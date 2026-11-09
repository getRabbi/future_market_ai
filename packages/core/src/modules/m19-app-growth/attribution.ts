import { appInstalls, brandApps, brands, type DbOrTx, experimentResults, experiments, paidCampaignDrafts, sequential, storeApps } from '@futuregrow/db';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { campaignConversions } from './index.js';
import { campaignReportDays, reportedCampaigns } from './store/query.js';

/**
 * Advanced marketing attribution (P3-08). For one application and period, each campaign shows
 * three kinds of evidence side by side and never adds them together:
 *  - store-reported acquisitions by utm_campaign (Google Play's own aggregate report; final,
 *    evidence-admitted days only, as in P1);
 *  - consented device-level telemetry from the app backend (installs → first opens → activations,
 *    with the reconciled 7-day windows of M19);
 *  - the content the campaign belongs to (studio posts from the campaign registry, paid campaign
 *    drafts by their utm_campaign).
 * Store acquisitions and telemetry installs measure overlapping people in different ways, so a
 * campaign's "total" is never computed. Incrementality is reported only from a concluded
 * experiment; otherwise the attribution is descriptive and says so.
 */

export const AttributionQuerySchema = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/),
    platform: z.enum(['ios', 'android']),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    brandId: z.string().uuid().optional(),
  })
  .strict();

export interface CampaignAttribution {
  campaign: string;
  /** Which brand/program/post the campaign belongs to, from the campaign registry only (never guessed from UTM labels). */
  identity: { status: 'unregistered' | 'post' | 'program' | 'brand_mismatch'; brandId?: string | null; programId?: string | null; postId?: string | null };
  storeReported: { available: boolean; acquisitions: number | null; visitors: number | null; reportedDays: number; reportedThrough: string | null; note: string };
  telemetry: { installs: number; firstOpens: number | null; activations: number | null; firstOpens7d: unknown; activations7d: unknown; methods: string[]; evidenceIds: string[] } | null;
  content: { posts: { postId: string | null; programId: string | null; channel: string | null }[]; paidDrafts: { draftId: string; platform: string; name: string; status: string; externalCampaignId: string | null }[] };
  /** Telemetry installs as a share of store acquisitions: how much of the store's count the consented backend observes (descriptive). */
  telemetryCoverageOfStore: number | null;
}

const utmCampaignOf = (s: string | null | undefined) => (s ? (/(?:^|[?&])utm_campaign=([^&]+)/.exec(s)?.[1] ?? null) : null);

export async function attributionReport(t: DbOrTx, raw: unknown, now: Date) {
  const q = AttributionQuerySchema.parse(raw);
  const telemetry = await campaignConversions(t, q, now);
  const fromDay = q.from.slice(0, 10);
  const toDay = q.to.slice(0, 10);
  const byCampaign = new Map<string, CampaignAttribution>();
  const row = (campaign: string): CampaignAttribution => {
    let r = byCampaign.get(campaign);
    if (!r) {
      r = { campaign, identity: { status: 'unregistered' }, storeReported: { available: q.platform === 'android', acquisitions: null, visitors: null, reportedDays: 0, reportedThrough: null, note: '' }, telemetry: null, content: { posts: [], paidDrafts: [] }, telemetryCoverageOfStore: null };
      byCampaign.set(campaign, r);
    }
    return r;
  };
  for (const c of telemetry.campaigns) {
    if (!c.campaign) continue;
    const r = row(c.campaign);
    const prev = r.telemetry;
    r.telemetry = {
      installs: (prev?.installs ?? 0) + c.metrics.installs,
      firstOpens: c.metrics.firstOpens === null && prev?.firstOpens == null ? null : (prev?.firstOpens ?? 0) + (c.metrics.firstOpens ?? 0),
      activations: c.metrics.activations === null && prev?.activations == null ? null : (prev?.activations ?? 0) + (c.metrics.activations ?? 0),
      firstOpens7d: c.reconciledWindows.firstOpens7d,
      activations7d: c.reconciledWindows.activations7d,
      methods: [...new Set([...(prev?.methods ?? []), c.attributionMethod])],
      evidenceIds: [...new Set([...(prev?.evidenceIds ?? []), ...c.evidenceIds])],
    };
    const id = c.identity as { status?: string; brandId?: string; postId?: string | null; programId?: string | null; channelPlatform?: string | null } | undefined;
    if (id?.status === 'registered') r.identity = { status: id.postId ? 'post' : 'program', brandId: id.brandId ?? null, programId: id.programId ?? null, postId: id.postId ?? null };
    if (id && (id.postId || id.programId)) r.content.posts.push({ postId: id.postId ?? null, programId: id.programId ?? null, channel: id.channelPlatform ?? null });
  }
  // Store-reported campaigns (Android): every UTM campaign Google reported for a final day in the
  // period, including campaigns no telemetry has seen (the common case before app-side telemetry).
  let storeRows: Awaited<ReturnType<typeof reportedCampaigns>>['rows'] = [];
  if (q.platform === 'android') {
    storeRows = (await reportedCampaigns(t, q.appId, fromDay, toDay)).rows.filter((s) => s.days > 0 || s.excludedDays > 0);
    for (const s of storeRows) {
      const sid = s.identity as { status: string; brandId?: string; programId?: string | null; postId?: string | null };
      if (q.brandId && sid.brandId !== q.brandId) continue;
      const r = row(s.utmCampaign);
      if (r.identity.status === 'unregistered' && sid.status !== 'unregistered') r.identity = { status: sid.status as CampaignAttribution['identity']['status'], brandId: sid.brandId ?? null, programId: sid.programId ?? null, postId: sid.postId ?? null };
    }
  }
  // Paid drafts carry utm_campaign in their tracking parameters.
  const drafts = await t
    .select()
    .from(paidCampaignDrafts)
    .where(q.brandId ? and(inArray(paidCampaignDrafts.status, ['submitted', 'created']), eq(paidCampaignDrafts.brandId, q.brandId)) : inArray(paidCampaignDrafts.status, ['submitted', 'created']));
  for (const d of drafts) {
    const spec = d.spec as { urlTags?: string; ad?: { finalUrlSuffix?: string | null } };
    const c = utmCampaignOf(spec.urlTags ?? spec.ad?.finalUrlSuffix ?? null);
    if (c) row(c).content.paidDrafts.push({ draftId: d.id, platform: d.platform, name: d.name, status: d.status, externalCampaignId: d.externalCampaignId });
  }
  const campaigns = [...byCampaign.keys()];
  let reportedThrough: string | null = null;
  if (q.platform === 'android' && campaigns.length) {
    const days = await campaignReportDays(t, q.appId, campaigns, fromDay, toDay);
    reportedThrough = days.reportedThrough;
    for (const c of campaigns) {
      const mine = days.days.filter((d) => d.campaign === c);
      const r = row(c);
      const acq = mine.map((d) => d.acquisitions).filter((v): v is number => v !== null);
      const vis = mine.map((d) => d.visitors).filter((v): v is number => v !== null);
      r.storeReported = {
        available: true,
        acquisitions: acq.length ? acq.reduce((a, b) => a + b, 0) : null,
        visitors: vis.length ? vis.reduce((a, b) => a + b, 0) : null,
        reportedDays: mine.length,
        reportedThrough: days.reportedThrough,
        note: mine.length ? 'final, evidence-admitted Google Play report days only' : 'Google Play has not reported this campaign for a final day in the period (unknown, not zero)',
      };
      if (r.telemetry && r.storeReported.acquisitions) r.telemetryCoverageOfStore = Math.round((r.telemetry.installs / r.storeReported.acquisitions) * 1000) / 1000;
    }
  } else {
    for (const r of byCampaign.values()) r.storeReported.note = 'App Store Connect Standard reports carry no campaign; store-reported acquisitions by campaign are not available for iOS';
  }
  // Incrementality only from completed (or stopped) experiments; everything else is descriptive.
  const concluded = await t
    .select({ id: experiments.id, name: experiments.name, targetMetric: experiments.targetMetric, status: experiments.status })
    .from(experiments)
    .where(inArray(experiments.status, ['completed', 'stopped']))
    .orderBy(desc(experiments.endedAt))
    .limit(20);
  const results = concluded.length
    ? await t
        .select()
        .from(experimentResults)
        .where(
          and(
            inArray(
              experimentResults.experimentId,
              concluded.map((e) => e.id),
            ),
          ),
        )
    : [];
  const incrementality = concluded.filter((e) => /install|first_open|activation|acquisition/i.test(e.targetMetric)).map((e) => ({ experimentId: e.id, name: e.name, targetMetric: e.targetMetric, results: results.filter((r) => r.experimentId === e.id).length }));
  const list = [...byCampaign.values()].sort((a, b) => (b.storeReported.acquisitions ?? b.telemetry?.installs ?? 0) - (a.storeReported.acquisitions ?? a.telemetry?.installs ?? 0));
  const funnel = attributionFunnel(list, q.platform);
  const coverage = {
    periodDays: Math.max(1, Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000)),
    storeReportedThrough: reportedThrough,
    /** Days between the end of the period and the newest final store day: the store publishes with a delay. */
    storeLagDays: reportedThrough ? Math.max(0, Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${reportedThrough}T00:00:00Z`)) / 86_400_000)) : null,
    campaigns: list.length,
    withStoreReport: list.filter((c) => c.storeReported.reportedDays > 0).length,
    withTelemetry: list.filter((c) => c.telemetry).length,
    withBoth: list.filter((c) => c.telemetry && c.storeReported.reportedDays > 0).length,
    registered: list.filter((c) => c.identity.status !== 'unregistered').length,
    excludedStoreDays: storeRows.reduce((a, s) => a + s.excludedDays, 0),
  };
  return {
    appId: q.appId,
    platform: q.platform,
    from: q.from,
    to: q.to,
    asOf: now.toISOString(),
    ...(q.brandId ? { brandId: q.brandId } : {}),
    campaigns: list,
    funnel,
    coverage,
    missingData: missingDataNotes(q.platform, list, coverage),
    incrementality: incrementality.length ? { basis: 'completed experiments', experiments: incrementality } : { basis: 'none', experiments: [], note: 'No completed experiment measures installs or activation: the numbers above describe what was observed, not what the campaigns caused.' },
    windows: { telemetryFirstOpen: '7 days after install (reconciled)', telemetryActivation: '7 days after install (reconciled)', storeReport: 'Google Play acquisition day; campaign = utm_campaign of the store listing visit' },
    notes: ['Store-reported acquisitions and consented telemetry installs are different measurements of overlapping people; they are shown side by side and never added.', 'A Google Play install increase is not attributed to social posting without a campaign link in the report or an experiment.', ...telemetry.notes],
  };
}

/**
 * Two separate funnels, one per measurement: the store's own listing visitors → acquisitions, and
 * consented telemetry installs → first opens → activations. A step is summed only within its own
 * layer, and only when every contributing campaign reported it (otherwise it is unknown).
 */
export function attributionFunnel(list: CampaignAttribution[], platform: 'ios' | 'android') {
  const sumKnown = (values: (number | null | undefined)[]) => {
    const present = values.filter((v) => v !== undefined);
    if (!present.length || present.some((v) => v === null)) return null;
    return (present as number[]).reduce((a, b) => a + b, 0);
  };
  const store = list.filter((c) => c.storeReported.reportedDays > 0);
  const tele = list.filter((c) => c.telemetry);
  return {
    store:
      platform === 'android'
        ? {
            basis: 'Google Play store-performance report (campaign-attributed listing visits only)',
            campaigns: store.length,
            steps: [
              { key: 'visitors', label: 'Store listing visitors', value: sumKnown(store.map((c) => c.storeReported.visitors)) },
              { key: 'acquisitions', label: 'Store listing acquisitions', value: sumKnown(store.map((c) => c.storeReported.acquisitions)) },
            ],
          }
        : { basis: 'not available: App Store Connect reports have no campaign dimension', campaigns: 0, steps: [] },
    telemetry: {
      basis: 'consented app-backend telemetry (evidence-backed installs and events)',
      campaigns: tele.length,
      steps: [
        { key: 'installs', label: 'Observed installs', value: tele.length ? tele.reduce((a, c) => a + c.telemetry!.installs, 0) : null },
        { key: 'firstOpens', label: 'Observed first opens', value: sumKnown(tele.map((c) => c.telemetry!.firstOpens)) },
        { key: 'activations', label: 'Observed activations', value: sumKnown(tele.map((c) => c.telemetry!.activations)) },
      ],
    },
    note: 'The two funnels measure different populations and are never joined or added. A step without a value was not reported for every campaign, so it is unknown rather than zero.',
  };
}

function missingDataNotes(platform: 'ios' | 'android', list: CampaignAttribution[], coverage: { storeReportedThrough: string | null; withTelemetry: number; withStoreReport: number; storeLagDays: number | null; excludedStoreDays: number; registered: number }) {
  const out: { key: string; detail: string; action: string }[] = [];
  if (platform === 'ios') out.push({ key: 'ios_no_campaigns', detail: 'App Store Connect reports have no campaign dimension, so store acquisitions by campaign do not exist for iOS.', action: 'Use consented app telemetry (install referrer equivalents) or Apple Ads attribution for iOS campaigns.' });
  if (platform === 'android' && !coverage.storeReportedThrough)
    out.push({ key: 'no_store_reports', detail: 'No final Google Play traffic-source report day has been imported for this app.', action: 'Connect the Google Play developer account (Apps & Store Reports) and wait for the first import; Google publishes about two days late.' });
  if (platform === 'android' && coverage.storeReportedThrough && (coverage.storeLagDays ?? 0) > 0)
    out.push({ key: 'store_lag', detail: `Google Play has published final days through ${coverage.storeReportedThrough}; the last ${coverage.storeLagDays} day(s) of the period are not reported yet.`, action: 'Nothing to do: the store publishes with a delay. Those days are unknown, not zero.' });
  if (coverage.excludedStoreDays > 0) out.push({ key: 'provisional_days', detail: `${coverage.excludedStoreDays} store report day(s) are provisional or not yet admitted as evidence and are left out.`, action: 'They are counted once the store marks them final.' });
  if (coverage.withTelemetry === 0)
    out.push({ key: 'no_telemetry', detail: 'No consented install telemetry was received for this app in the period.', action: 'App-side telemetry is optional: install the FUTUREGROW telemetry client in the app and send installs and events from your backend (docs/APP_INSTALL_INTEGRATION.md).' });
  if (list.length && coverage.registered < list.length)
    out.push({ key: 'unregistered_campaigns', detail: `${list.length - coverage.registered} campaign(s) are not in the campaign registry, so they are not assigned to a brand, program or post.`, action: 'Publish through the Content Studio (it registers each link), or treat these campaigns as external.' });
  if (!list.length) out.push({ key: 'no_campaigns', detail: 'No campaign was reported by the store, observed by telemetry or used by a paid campaign in this period.', action: 'Choose a longer period, or tag store links with utm_campaign.' });
  return out;
}

/**
 * Applications the attribution report can be run for: confirmed store apps, apps linked to a
 * brand, and apps that sent telemetry, each with its brand (if linked) and which sources exist.
 */
export async function attributionApps(t: DbOrTx) {
  const [store, linked, tele] = await sequential([
    t
      .select({ platform: storeApps.platform, appId: storeApps.appId, name: storeApps.displayName, status: storeApps.status })
      .from(storeApps)
      .where(inArray(storeApps.status, ['confirmed', 'discovered'])),
    t.select({ platform: brandApps.platform, appId: brandApps.appId, brandId: brands.id, brandName: brands.name }).from(brandApps).innerJoin(brands, eq(brands.id, brandApps.brandId)),
    t.selectDistinct({ platform: appInstalls.platform, appId: appInstalls.appId }).from(appInstalls).where(isNotNull(appInstalls.appId)),
  ]);
  const out = new Map<string, { platform: 'ios' | 'android'; appId: string; name: string | null; brandId: string | null; brandName: string | null; storeReports: boolean; telemetry: boolean }>();
  const get = (platform: string, appId: string) => {
    const k = `${platform}:${appId}`;
    let v = out.get(k);
    if (!v) {
      v = { platform: platform as 'ios' | 'android', appId, name: null, brandId: null, brandName: null, storeReports: false, telemetry: false };
      out.set(k, v);
    }
    return v;
  };
  for (const s of store) {
    const v = get(s.platform, s.appId);
    v.name = v.name ?? s.name;
    if (s.status === 'confirmed') v.storeReports = true;
  }
  for (const l of linked) Object.assign(get(l.platform, l.appId), { brandId: l.brandId, brandName: l.brandName });
  for (const x of tele) if (x.appId) get(x.platform, x.appId).telemetry = true;
  return [...out.values()].filter((a) => a.platform === 'ios' || a.platform === 'android').sort((a, b) => (a.name ?? a.appId).localeCompare(b.name ?? b.appId));
}

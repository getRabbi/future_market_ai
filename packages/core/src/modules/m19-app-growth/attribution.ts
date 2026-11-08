import { type DbOrTx, experimentResults, experiments, paidCampaignDrafts } from '@futuregrow/db';
import { and, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { campaignConversions } from './index.js';
import { campaignReportDays } from './store/query.js';

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
  const byCampaign = new Map<string, CampaignAttribution>();
  const row = (campaign: string): CampaignAttribution => {
    let r = byCampaign.get(campaign);
    if (!r) {
      r = { campaign, storeReported: { available: q.platform === 'android', acquisitions: null, visitors: null, reportedDays: 0, reportedThrough: null, note: '' }, telemetry: null, content: { posts: [], paidDrafts: [] }, telemetryCoverageOfStore: null };
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
    const id = c.identity as { postId?: string | null; programId?: string | null; channelPlatform?: string | null } | undefined;
    if (id && (id.postId || id.programId)) r.content.posts.push({ postId: id.postId ?? null, programId: id.programId ?? null, channel: id.channelPlatform ?? null });
  }
  // Paid drafts carry utm_campaign in their tracking parameters.
  const drafts = await t
    .select()
    .from(paidCampaignDrafts)
    .where(inArray(paidCampaignDrafts.status, ['submitted', 'created']));
  for (const d of drafts) {
    const spec = d.spec as { urlTags?: string; ad?: { finalUrlSuffix?: string | null } };
    const c = utmCampaignOf(spec.urlTags ?? spec.ad?.finalUrlSuffix ?? null);
    if (c) row(c).content.paidDrafts.push({ draftId: d.id, platform: d.platform, name: d.name, status: d.status, externalCampaignId: d.externalCampaignId });
  }
  const campaigns = [...byCampaign.keys()];
  if (q.platform === 'android' && campaigns.length) {
    const days = await campaignReportDays(t, q.appId, campaigns, q.from.slice(0, 10), q.to.slice(0, 10));
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
  return {
    appId: q.appId,
    platform: q.platform,
    from: q.from,
    to: q.to,
    asOf: now.toISOString(),
    campaigns: [...byCampaign.values()].sort((a, b) => (b.storeReported.acquisitions ?? b.telemetry?.installs ?? 0) - (a.storeReported.acquisitions ?? a.telemetry?.installs ?? 0)),
    incrementality: incrementality.length ? { basis: 'completed experiments', experiments: incrementality } : { basis: 'none', experiments: [], note: 'No completed experiment measures installs or activation: the numbers above describe what was observed, not what the campaigns caused.' },
    windows: { telemetryFirstOpen: '7 days after install (reconciled)', telemetryActivation: '7 days after install (reconciled)', storeReport: 'Google Play acquisition day; campaign = utm_campaign of the store listing visit' },
    notes: ['Store-reported acquisitions and consented telemetry installs are different measurements of overlapping people; they are shown side by side and never added.', 'A Google Play install increase is not attributed to social posting without a campaign link in the report or an experiment.', ...telemetry.notes],
  };
}

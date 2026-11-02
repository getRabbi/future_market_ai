import { fetchSalesReport } from '@futuregrow/connectors';
import { appInstalls, appStoreReports, customerEvents, type DbOrTx, evidenceRecords, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { record } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { ingestEventsInTransaction } from '../m02-customers/index.js';
import { appendPoints, upsertSeries } from '../m08-analytics/index.js';

/**
 * Referrer minimisation: only campaign parameters are kept. Click IDs and anything else in the
 * Play install referrer are discarded at the boundary (no fingerprinting, no cross-app joins).
 */
export const REFERRER_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export function parseInstallReferrer(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  } catch {
    return out;
  }
  for (const k of REFERRER_KEYS) {
    const v = params.get(k);
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}

export const InstallSchema = z.object({
  platform: z.enum(['ios', 'android']),
  appId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/)
    .optional(),
  installId: z.string().min(8).max(200),
  userId: z.string().min(1).max(200).optional(),
  installedAt: z.string().datetime({ offset: true }),
  /** Android: raw Play Install Referrer `installReferrer` string. */
  installReferrer: z.string().max(2000).optional(),
  referrerClickAt: z.string().datetime({ offset: true }).optional(),
  /** iOS: in-app "how did you hear about us" answer (self-reported, labelled as such). */
  selfReportedSource: z.string().max(100).optional(),
  consent: z.object({ analytics: z.boolean() }),
  context: z.object({ country: z.string().length(2).optional(), locale: z.string().max(35).optional(), timezone: z.string().max(64).optional() }).default({}),
});

/**
 * Record an install. Without analytics consent the install is counted with no campaign data and
 * no profile link. The method that produced attribution is always stored with the record.
 */
export async function recordInstall(deps: CoreDeps, tenantId: string, source: string, raw: unknown) {
  const i = InstallSchema.parse(raw);
  const now = deps.clock.now();
  if (Date.parse(i.installedAt) > now.getTime() + 300_000) throw invalid('installation timestamp is in the future');
  if (i.referrerClickAt && Date.parse(i.referrerClickAt) > Date.parse(i.installedAt)) throw invalid('referrer click must not follow installation');
  const installHash = sha256Hex(i.appId ? `${tenantId}:${i.platform}:${i.appId}:${i.installId}` : `${tenantId}:${i.installId}`);
  const messageId = i.appId ? `scoped-install:v1:${installHash}` : i.installId.length > 180 ? `legacy-install:v2:${installHash}` : `install:${i.platform}:${i.installId}`;
  const actor = systemActor('app-growth');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    // Serialise retries before identity resolution or evidence creation. Every side effect
    // commits with the install, so a crash cannot leave a partially recorded conversion.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${i.platform}:${installHash}`}, 0))`);
    const [existing] = await tx
      .select()
      .from(appInstalls)
      .where(and(eq(appInstalls.platform, i.platform), eq(appInstalls.installId, installHash)));
    if (existing) return { recorded: false, attributionMethod: existing.attributionMethod, profileLinked: Boolean(existing.profileId) };
    const consented = i.consent.analytics;
    let profileId: string | null = null;
    if (consented) {
      const res = await ingestEventsInTransaction(tx, deps, tenantId, source, [
        {
          messageId,
          event: 'app_installed',
          timestamp: i.installedAt,
          deviceId: i.appId ? `app:${installHash}` : i.installId,
          ...(i.userId ? { userId: i.userId } : {}),
          properties: { platform: i.platform, ...(i.appId ? { appId: i.appId, installHash } : {}) },
          context: { ...i.context, consent: { analytics: true } },
        },
      ]);
      profileId = res.profileIds[0] ?? null;
      if (!profileId) {
        const [ev] = await tx.select({ profileId: customerEvents.profileId }).from(customerEvents).where(eq(customerEvents.messageId, messageId));
        profileId = ev?.profileId ?? null;
      }
      if (!profileId) throw invalid('installation event did not resolve an analytics profile');
    }
    const referrer = consented && i.platform === 'android' && i.installReferrer ? parseInstallReferrer(i.installReferrer) : {};
    const method = !consented ? 'unattributed' : i.platform === 'android' && Object.keys(referrer).length ? 'play_install_referrer' : i.selfReportedSource ? 'self_reported' : 'unattributed';
    const evidence = consented
      ? await admitInternalEvidence(tx, tenantId, actor, {
          kind: 'observation',
          owner: source,
          uri: `app-install://${i.platform}/${i.appId ?? 'legacy'}/${installHash}`,
          content: { platform: i.platform, appId: i.appId ?? null, installHash, profileId, installedAt: i.installedAt, attributionMethod: method, referrer, source, verification: 'authenticated_backend_report' },
          summary: 'Installation reported by the authenticated application backend; not independent store verification',
          confidence: 0.8,
          license: 'tenant first-party telemetry with analytics consent',
          pii: 'pseudonymous',
          lawfulBasis: 'consent',
          permittedUses: ['analytics'],
          observedAt: new Date(i.installedAt),
          now,
        })
      : null;
    const [row] = await tx
      .insert(appInstalls)
      .values({
        tenantId,
        platform: i.platform,
        appId: i.appId ?? null,
        ingestionSource: source,
        evidenceId: evidence?.evidenceId ?? null,
        installId: installHash,
        profileId,
        installedAt: new Date(i.installedAt),
        referrerClickAt: consented && i.referrerClickAt ? new Date(i.referrerClickAt) : null,
        referrer: method === 'self_reported' ? { self_reported: i.selfReportedSource!.slice(0, 100) } : referrer,
        attributionMethod: method,
        campaignRef: referrer.utm_campaign ?? null,
        sourceRef: referrer.utm_source ?? (method === 'self_reported' ? i.selfReportedSource! : null),
        consentAnalytics: consented,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      await record(tx, tenantId, actor, 'app.install.recorded', { type: 'app_install', id: row.id }, { platform: i.platform, appId: i.appId ?? null, method, evidenceId: evidence?.evidenceId ?? null });
    }
    return { recorded: Boolean(row), attributionMethod: method, profileLinked: Boolean(profileId) };
  });
}

export const AppEventSchema = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/),
    platform: z.enum(['ios', 'android']),
    installId: z.string().min(8).max(200),
    eventId: z.string().min(8).max(200),
    event: z.enum(['first_open', 'activation', 'session']),
    occurredAt: z.string().datetime({ offset: true }),
    consent: z.object({ analytics: z.boolean() }),
  })
  .strict();

/** Server-authenticated telemetry; a first open is never inferred from an installation. */
export async function recordAppEvent(deps: CoreDeps, tenantId: string, source: string, raw: unknown) {
  const input = AppEventSchema.parse(raw);
  if (!input.consent.analytics) return { recorded: false, reason: 'analytics consent denied' };
  const now = deps.clock.now();
  const occurredAt = new Date(input.occurredAt);
  if (occurredAt.getTime() > now.getTime() + 300_000) throw invalid('event timestamp is in the future');
  const installHash = sha256Hex(`${tenantId}:${input.platform}:${input.appId}:${input.installId}`);
  const messageId = `app-event:${installHash}:${sha256Hex(input.eventId)}`;
  const eventName = `app_${input.event}`;
  const actor = systemActor('app-growth');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.platform}:${installHash}`}, 0))`);
    const [install] = await tx
      .select()
      .from(appInstalls)
      .where(and(eq(appInstalls.appId, input.appId), eq(appInstalls.platform, input.platform), eq(appInstalls.installId, installHash)))
      .for('update');
    if (!install) throw invalid('record this application installation before its events');
    if (!install.consentAnalytics || !install.profileId) return { recorded: false, reason: 'installation has no analytics consent or profile' };
    if (occurredAt < install.installedAt) throw invalid('event precedes installation');
    const [duplicate] = await tx.select().from(customerEvents).where(eq(customerEvents.messageId, messageId));
    if (duplicate) {
      if (duplicate.eventName !== eventName || duplicate.occurredAt.getTime() !== occurredAt.getTime()) throw conflict('app event ID reused with different data');
      return { recorded: false, evidenceId: duplicate.properties.evidenceId ?? null };
    }
    const evidence = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'observation',
      owner: source,
      uri: `app-event://${installHash}/${sha256Hex(input.eventId)}`,
      content: { appId: input.appId, platform: input.platform, installHash, profileId: install.profileId, event: input.event, occurredAt: input.occurredAt, verification: 'authenticated_backend_report' },
      summary: 'Consented application event reported by the authenticated backend',
      confidence: 0.8,
      license: 'tenant first-party telemetry with analytics consent',
      pii: 'pseudonymous',
      lawfulBasis: 'consent',
      permittedUses: ['analytics'],
      observedAt: occurredAt,
      now,
    });
    const result = await ingestEventsInTransaction(tx, deps, tenantId, source, [
      {
        messageId,
        event: eventName,
        timestamp: input.occurredAt,
        deviceId: `app:${installHash}`,
        properties: { appId: input.appId, platform: input.platform, installHash, evidenceId: evidence.evidenceId },
        context: { consent: { analytics: true } },
      },
    ]);
    if (result.accepted !== 1) throw invalid('application event was not accepted');
    return { recorded: true, evidenceId: evidence.evidenceId };
  });
}

export const CampaignQuerySchema = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/),
    platform: z.enum(['ios', 'android']),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict();

export async function listApplications(tx: DbOrTx) {
  return tx.selectDistinct({ appId: appInstalls.appId, platform: appInstalls.platform }).from(appInstalls).where(isNotNull(appInstalls.appId)).orderBy(appInstalls.appId, appInstalls.platform);
}

/** Counts genuine backend observations, not total store acquisitions or causal effects. */
export async function campaignConversions(tx: DbOrTx, raw: unknown, now: Date) {
  const query = CampaignQuerySchema.parse(raw);
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (to <= from || to.getTime() - from.getTime() > 366 * 86_400_000) throw invalid('campaign interval must be positive and at most 366 days');
  const result = await tx.execute<{
    campaign: string | null;
    source: string | null;
    medium: string | null;
    content: string | null;
    method: string;
    installs: number;
    first_opens: number;
    activations: number;
    retained_w1: number;
    mature_w1: number;
    proofs: { install: string; events: string[] }[];
  }>(sql`
    with installs as (
      select i.* from app_installs i join evidence_records proof on proof.id = i.evidence_id
      where i.app_id = ${query.appId} and i.platform = ${query.platform}
        and i.installed_at >= ${from} and i.installed_at < ${to} and i.installed_at <= ${now}
        and i.consent_analytics and i.profile_id is not null and proof.status = 'admitted' and proof.content is not null
    ), observed as (
      select i.*, events.first_open, events.activation, events.retained, events.event_evidence_ids
      from installs i left join lateral (
        select bool_or(e.event_name = 'app_first_open') as first_open,
          bool_or(e.event_name = 'app_activation') as activation,
          bool_or(e.event_name = 'app_session' and e.occurred_at >= i.installed_at + interval '7 days' and e.occurred_at < i.installed_at + interval '14 days') as retained,
          array_remove(ARRAY[
            min(ep.id::text) filter (where e.event_name = 'app_first_open'),
            min(ep.id::text) filter (where e.event_name = 'app_activation'),
            min(ep.id::text) filter (where e.event_name = 'app_session' and e.occurred_at >= i.installed_at + interval '7 days' and e.occurred_at < i.installed_at + interval '14 days')
          ], NULL) as event_evidence_ids
        from customer_events e join evidence_records ep on ep.id::text = e.properties->>'evidenceId'
        where e.profile_id = i.profile_id and e.properties->>'installHash' = i.install_id
          and e.properties->>'appId' = i.app_id and e.properties->>'platform' = i.platform
          and e.occurred_at >= i.installed_at and e.occurred_at <= ${now}
          and ep.status = 'admitted' and ep.content is not null
          and ep.content->>'installHash' = i.install_id and ep.content->>'appId' = i.app_id
          and ep.content->>'event' = substring(e.event_name from 5)
          and ep.observed_at = e.occurred_at
          and ep.source_owner = e.source
      ) events on true
    ), ranked as (
      select *, row_number() over (partition by campaign_ref, source_ref, referrer->>'utm_medium', referrer->>'utm_content', attribution_method order by installed_at, id) as proof_rank from observed
    )
    select campaign_ref as campaign, source_ref as source, referrer->>'utm_medium' as medium,
      referrer->>'utm_content' as content, attribution_method as method,
      count(*)::int as installs, count(*) filter (where first_open)::int as first_opens,
      count(*) filter (where activation)::int as activations,
      count(*) filter (where installed_at + interval '14 days' <= ${now})::int as mature_w1,
      count(*) filter (where retained and installed_at + interval '14 days' <= ${now})::int as retained_w1,
      jsonb_agg(jsonb_build_object('install', evidence_id, 'events', coalesce(event_evidence_ids, ARRAY[]::text[]))) filter (where proof_rank <= 50) as proofs
    from ranked group by 1,2,3,4,5 order by 1,2,3,4,5`);
  return {
    appId: query.appId,
    platform: query.platform,
    from: query.from,
    to: query.to,
    asOf: now.toISOString(),
    campaigns: result.rows.map((r) => ({
      campaign: r.campaign,
      source: r.source,
      medium: r.medium,
      content: r.content,
      attributionMethod: r.method,
      metrics: { linkClicks: null, installs: r.installs, firstOpens: r.first_opens || null, activations: r.activations || null, retainedWeek1: r.retained_w1 || null },
      matureWeek1Installs: r.mature_w1,
      evidenceIds: [...new Set(r.proofs.flatMap((proof) => [proof.install, ...proof.events]))],
      evidenceReferencesTruncated: r.installs > 50,
      coverage: 'observed_events_only',
    })),
    notes: [
      'Counts are consented, evidence-backed backend observations. An authenticated sender is not independent Google Play verification. Attribution describes the supplied campaign, not causal impact.',
      'Tracking coverage has not been verified: unobserved outcomes are unavailable, not zero. First opens and activation use actual events as of the report time; week-one retention requires a session at age 7–14 days and a fully elapsed 14-day window. No conversion rates or statistical winners are inferred.',
      'Clicks, unscoped legacy installs, non-consented records and other applications are excluded. Empty campaigns mean no supported observations, not zero store acquisitions.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* App Store Connect sales reports                                     */
/* ------------------------------------------------------------------ */

/** Product Type Identifiers that are first-time downloads in Apple Sales reports. */
export const FIRST_TIME_DOWNLOAD_TYPES = new Set(['1', '1F', '1T', 'F1', '1E', '1EP', '1EU']);

export function summarizeSalesReport(header: string[], rows: string[][]) {
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iType = col('Product Type Identifier');
  const iUnits = col('Units');
  const iCountry = col('Country Code');
  const iSku = col('SKU');
  if (iType < 0 || iUnits < 0) throw invalid('sales report is missing Product Type Identifier / Units columns');
  let downloads = 0;
  const byCountry: Record<string, number> = {};
  const bySku: Record<string, number> = {};
  for (const r of rows) {
    if (!FIRST_TIME_DOWNLOAD_TYPES.has((r[iType] ?? '').trim())) continue;
    const u = Number(r[iUnits] ?? 0);
    if (!Number.isFinite(u)) continue;
    downloads += u;
    const c = iCountry >= 0 ? (r[iCountry] ?? '??') : '??';
    byCountry[c] = (byCountry[c] ?? 0) + u;
    const s = iSku >= 0 ? (r[iSku] ?? '?') : '?';
    bySku[s] = (bySku[s] ?? 0) + u;
  }
  return { firstTimeDownloads: downloads, byCountry, bySku, rows: rows.length };
}

export async function syncAppStoreSales(deps: CoreDeps, tenantId: string, connectionId: string, reportDate: string) {
  const { ctx } = await readContext(deps, tenantId, connectionId, 'app_store_connect');
  const report = await fetchSalesReport(ctx, reportDate);
  const summary = summarizeSalesReport(report.header, report.rows);
  const sha = sha256Hex(report.bytes);
  const key = tenantKey(tenantId, 'reports', 'app-store', `${reportDate}-${sha.slice(0, 12)}.tsv.gz`);
  await deps.store.put(key, report.bytes, 'application/gzip');
  const actor = systemActor('app-store-sync');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'metric',
      sourceType: 'primary',
      owner: 'app_store_connect',
      uri: `asc://sales/DAILY/SUMMARY/${reportDate}#${sha}`,
      content: { reportDate, objectKey: key, sha256: sha, ...summary },
      summary: `App Store sales ${reportDate}: ${summary.firstTimeDownloads} first-time downloads`,
      confidence: 1,
      license: 'App Store Connect API terms (account holder data)',
      permittedUses: ['analytics', 'forecasting', 'causal_measurement'],
      externalPlatformTerms: 'app_store_connect',
      observedAt: new Date(`${reportDate}T23:59:59Z`),
      freshnessSlaHours: 72,
      now: deps.clock.now(),
    });
    const [row] = await tx
      .insert(appStoreReports)
      .values({ tenantId, connectionId, reportType: 'SALES_SUMMARY_DAILY', period: reportDate, objectKey: key, sha256: sha, rowCount: report.rows.length, evidenceId: ev.evidenceId })
      .onConflictDoUpdate({ target: [appStoreReports.tenantId, appStoreReports.connectionId, appStoreReports.reportType, appStoreReports.period], set: { objectKey: key, sha256: sha, rowCount: report.rows.length, evidenceId: ev.evidenceId, fetchedAt: deps.clock.now() } })
      .returning();
    return { report: row!, summary, evidenceId: ev.evidenceId };
  });
}

/* ------------------------------------------------------------------ */
/* Cohorts                                                             */
/* ------------------------------------------------------------------ */

/**
 * Weekly install cohorts by attribution method and source, with activation within 7 days and
 * week-1..4 retention (any first-party event in that week). Profiles without analytics consent
 * appear in install counts only.
 */
export async function acquisitionCohorts(tx: DbOrTx, args: { from: Date; to: Date; activationEvent: string }) {
  if (!/^[A-Za-z0-9_.:\- ]{1,200}$/.test(args.activationEvent)) throw invalid('invalid activation event name');
  const r = await tx.execute<{
    cohort_week: string;
    platform: string;
    attribution_method: string;
    source_ref: string | null;
    installs: number;
    linked: number;
    activated_7d: number;
    retained_w1: number;
    retained_w2: number;
    retained_w4: number;
  }>(sql`
    with i as (
      select date_trunc('week', installed_at) as cohort_week, platform, attribution_method, source_ref, profile_id, installed_at
      from app_installs where installed_at >= ${args.from} and installed_at < ${args.to}
    )
    select to_char(cohort_week, 'YYYY-MM-DD') as cohort_week, platform, attribution_method, source_ref,
      count(*)::int as installs,
      count(profile_id)::int as linked,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name = ${args.activationEvent}
        and e.occurred_at >= i.installed_at and e.occurred_at < i.installed_at + interval '7 days'))::int as activated_7d,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name <> 'app_installed'
        and e.occurred_at >= i.installed_at + interval '7 days' and e.occurred_at < i.installed_at + interval '14 days'))::int as retained_w1,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name <> 'app_installed'
        and e.occurred_at >= i.installed_at + interval '14 days' and e.occurred_at < i.installed_at + interval '21 days'))::int as retained_w2,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name <> 'app_installed'
        and e.occurred_at >= i.installed_at + interval '28 days' and e.occurred_at < i.installed_at + interval '35 days'))::int as retained_w4
    from i group by 1, 2, 3, 4 order by 1, 2, 3, 4`);
  return {
    cohorts: r.rows.map((c) => ({ ...c, activationRate: c.linked ? c.activated_7d / c.linked : null, w1Retention: c.linked ? c.retained_w1 / c.linked : null })),
    note: 'Attribution labels describe how an install was attributed (referrer, self-report, none). They are not causal effects; use experiments or MMM for incrementality. Rates use consented, profile-linked installs as the denominator.',
  };
}

export async function installStats(tx: DbOrTx) {
  const r = await tx.execute<{ platform: string; attribution_method: string; n: number }>(sql`select platform, attribution_method, count(*)::int as n from app_installs group by 1, 2 order by 1, 2`);
  return r.rows;
}

export async function listReports(tx: DbOrTx) {
  return tx.select().from(appStoreReports).orderBy(desc(appStoreReports.period)).limit(400);
}

/** M08 series key for App Store first-time downloads, fed from the daily sales reports. */
export const DOWNLOADS_SERIES_KEY = 'app.downloads.first_time';

/**
 * Bridge App Store sales reports into an M08 KPI series (one point per report day, each backed by
 * the report's evidence), so forecasts and the Growth Brain can use downloads. Idempotent: points
 * are upserted by day. Returns null when no report has been synced yet.
 */
export async function syncDownloadsSeries(tx: Tx, tenantId: string): Promise<{ seriesId: string; points: number } | null> {
  const rows = await tx
    .select({ period: appStoreReports.period, evidenceId: appStoreReports.evidenceId, content: evidenceRecords.content })
    .from(appStoreReports)
    .innerJoin(evidenceRecords, eq(evidenceRecords.id, appStoreReports.evidenceId))
    .where(eq(appStoreReports.reportType, 'SALES_SUMMARY_DAILY'))
    .orderBy(asc(appStoreReports.period));
  const pts = rows.map((r) => ({ ts: `${r.period}T00:00:00Z`, value: Number((r.content as { firstTimeDownloads?: unknown } | null)?.firstTimeDownloads), evidenceId: r.evidenceId })).filter((p) => /^\d{4}-\d{2}-\d{2}T/.test(p.ts) && Number.isFinite(p.value));
  if (!pts.length) return null;
  const actor = systemActor('app-store-sync');
  const series = await upsertSeries(tx, tenantId, actor, { key: DOWNLOADS_SERIES_KEY, name: 'App Store first-time downloads', unit: 'downloads', granularity: 'day', kind: 'kpi', channel: 'app_store', sourceEvidenceId: pts[pts.length - 1]!.evidenceId });
  await appendPoints(tx, tenantId, series.id, pts);
  return { seriesId: series.id, points: pts.length };
}

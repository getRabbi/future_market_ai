import { desc, eq, sql } from 'drizzle-orm';
import { fetchSalesReport } from '@futuregrow/connectors';
import { type DbOrTx, appInstalls, appStoreReports, customerEvents, withTenant } from '@futuregrow/db';
import { invalid, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { z } from 'zod';
import { type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { record } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { ingestEvents } from '../m02-customers/index.js';

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
  const consented = i.consent.analytics;
  let profileId: string | null = null;
  if (consented) {
    const res = await ingestEvents(deps, tenantId, source, [
      {
        messageId: `install:${i.platform}:${i.installId}`,
        event: 'app_installed',
        timestamp: i.installedAt,
        deviceId: i.installId,
        ...(i.userId ? { userId: i.userId } : {}),
        properties: { platform: i.platform },
        context: { ...i.context, consent: { analytics: true } },
      },
    ]);
    profileId = res.profileIds[0] ?? null;
    if (!profileId) {
      const [ev] = await withTenant(deps.db, { tenantId, actor: `ingest:${source}` }, (tx) =>
        tx.select({ profileId: customerEvents.profileId }).from(customerEvents).where(eq(customerEvents.messageId, `install:${i.platform}:${i.installId}`)),
      );
      profileId = ev?.profileId ?? null;
    }
  }
  const referrer = consented && i.platform === 'android' && i.installReferrer ? parseInstallReferrer(i.installReferrer) : {};
  const method =
    !consented ? 'unattributed'
    : i.platform === 'android' && Object.keys(referrer).length ? 'play_install_referrer'
    : i.selfReportedSource ? 'self_reported'
    : 'unattributed';
  const [row] = await withTenant(deps.db, { tenantId, actor: `ingest:${source}` }, (tx) =>
    tx
      .insert(appInstalls)
      .values({
        tenantId,
        platform: i.platform,
        installId: sha256Hex(`${tenantId}:${i.installId}`),
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
      .returning(),
  );
  if (row) {
    await withTenant(deps.db, { tenantId, actor: `ingest:${source}` }, (tx) =>
      record(tx, tenantId, systemActor('app-growth'), 'app.install.recorded', { type: 'app_install', id: row.id }, { platform: i.platform, method }),
    );
  }
  return { recorded: Boolean(row), attributionMethod: method, profileLinked: Boolean(profileId) };
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


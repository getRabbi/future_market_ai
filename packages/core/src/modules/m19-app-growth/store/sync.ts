import {
  type ConnectorContext,
  classifyPlayError,
  downloadReportObject,
  downloadReportSegment,
  listAnalyticsReportRequests,
  listAnalyticsReports,
  listAscApps,
  listInstanceSegments,
  listReportInstances,
  listReportObjects,
  ProviderHttpError,
  queryVitals,
  type ReportObject,
  searchPlayApps,
  VITALS_METRIC_SETS,
  type VitalsMetricSet,
  vitalsFreshness,
} from '@futuregrow/connectors';
import { storeAccounts, storeApps, storeReportCoverage, storeReportFiles, storeReportPartitions, storeSyncRuns, type Tx, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { and, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { type CoreDeps, systemActor } from '../../../deps.js';
import { audit } from '../../../util.js';
import { readContext } from '../../connections.js';
import { AccountSettingsSchema, enabledPlayDimensions, upsertDiscoveredApp } from './accounts.js';
import { decodeReport, REPORT_LIMITS, ReportFormatError } from './decode.js';
import { APPLE_FAMILIES, type AppleFamily, PLAY_FAMILIES, PLAY_POSTING_DAYS, PLAY_VITALS, type PlayFamily } from './definitions.js';
import { type ImportTarget, importParsedReport, recordRejectedFile, type SourceFile } from './ingest.js';
import { type ParsedReport, parseAppleReport, parsePlayReport, parseVitals } from './parse.js';

export const STORE_LEASE_MS = 15 * 60_000;
/** Files imported per run; the rest continue in a follow-up run a few minutes later. */
export const MAX_FILES_PER_RUN = 40;
const DAY = 86_400_000;
const ACTOR = systemActor('store-reporting');

type Account = typeof storeAccounts.$inferSelect;
type App = typeof storeApps.$inferSelect;
type Health = (typeof storeAccounts.$inferSelect)['healthStatus'];

export interface SyncStats {
  appsSeen: number;
  filesSeen: number;
  filesImported: number;
  filesUnchanged: number;
  filesRejected: number;
  filesFailed: number;
  deferred: number;
  observations: number;
  revisedDays: number;
  notes: string[];
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const ym = (d: Date) => d.toISOString().slice(0, 7);
const monthsBack = (now: Date, n: number) => {
  const out: string[] = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < n; i++) {
    out.push(ym(d));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
};
const safePart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

/** Next daily slot: 06:00–06:40 UTC (spread by account), after Play's and Apple's daily postings. */
export function nextDailySlot(accountId: string, now: Date): Date {
  const jitter = Number.parseInt(sha256Hex(accountId).slice(0, 4), 16) % 40;
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, jitter));
  return slot.getTime() > now.getTime() + 60 * 60_000 ? slot : new Date(slot.getTime() + DAY);
}

/** Bounded exponential backoff after failures: 30 min, 1 h, 2 h … capped at 24 h. */
export const failureBackoffMs = (failures: number) => Math.min(24 * 60 * 60_000, 30 * 60_000 * 2 ** Math.max(0, failures - 1));

function classify(err: unknown): { health: Health; message: string; retryAfterMs: number | null } {
  if (err instanceof ProviderHttpError) {
    const c = classifyPlayError(err);
    return { health: c.access === 'ok' ? 'error' : c.access, message: c.message, retryAfterMs: err.retryAfterMs };
  }
  return { health: 'error', message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300), retryAfterMs: null };
}

/**
 * One sync of one developer account. A lease on the account row serializes syncs across workers
 * (a crashed worker's lease expires); each file imports in its own transaction, so a restart
 * resumes with the files not yet recorded. Never throws for provider failures: they become the
 * account's health, the run's error and a backed-off next attempt.
 */
export async function runStoreAccountSync(deps: CoreDeps, tenantId: string, accountId: string, opts: { mode: 'discovery' | 'incremental' | 'backfill'; triggeredBy: string; owner: string }) {
  const startedAt = deps.clock.now();
  const claim = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, async (t) => {
    const [a] = await t
      .update(storeAccounts)
      .set({ leaseOwner: opts.owner, leaseUntil: new Date(startedAt.getTime() + STORE_LEASE_MS), lastSyncStartedAt: startedAt, updatedAt: startedAt })
      .where(and(eq(storeAccounts.id, accountId), eq(storeAccounts.status, 'active'), or(isNull(storeAccounts.leaseUntil), lt(storeAccounts.leaseUntil, startedAt))))
      .returning();
    if (!a) return null;
    await t
      .update(storeSyncRuns)
      .set({ status: 'failed', finishedAt: startedAt, error: { message: 'the worker stopped before this run finished; resumed by a later run' } })
      .where(and(eq(storeSyncRuns.storeAccountId, accountId), eq(storeSyncRuns.status, 'running')));
    const [run] = await t.insert(storeSyncRuns).values({ tenantId, storeAccountId: accountId, mode: opts.mode, triggeredBy: opts.triggeredBy, startedAt }).returning();
    return { a, run: run! };
  });
  if (!claim) return { skipped: true as const, reason: 'another sync holds the account, or it is disabled' };
  const { a, run } = claim;
  const stats: SyncStats = { appsSeen: 0, filesSeen: 0, filesImported: 0, filesUnchanged: 0, filesRejected: 0, filesFailed: 0, deferred: 0, observations: 0, revisedDays: 0, notes: [] };
  let health: Health = 'ok';
  let healthDetail: Record<string, unknown> = {};
  let fatal: { message: string; retryAfterMs: number | null } | null = null;
  try {
    const { ctx } = await readContext(deps, tenantId, a.connectionId, a.provider);
    healthDetail = a.provider === 'google_play' ? await syncPlay(deps, tenantId, ctx, a, stats) : await syncApple(deps, tenantId, ctx, a, stats);
  } catch (err) {
    const c = classify(err);
    health = c.health === 'ok' ? 'error' : c.health;
    fatal = { message: c.message, retryAfterMs: c.retryAfterMs };
    healthDetail = { error: c.message };
    if (health === 'permission_denied' || health === 'auth_failed' || health === 'not_found') await markAccountCoverage(deps, tenantId, a, health === 'permission_denied' ? 'permission_denied' : 'unavailable', c.message);
  }
  const now = deps.clock.now();
  const failures = fatal ? a.consecutiveFailures + 1 : 0;
  const outcome = fatal ? 'failed' : stats.filesFailed || stats.filesRejected ? 'partial' : 'succeeded';
  const next = fatal ? new Date(now.getTime() + (health === 'rate_limited' ? Math.max(fatal.retryAfterMs ?? 0, 60 * 60_000) : failureBackoffMs(failures))) : stats.deferred > 0 ? new Date(now.getTime() + 2 * 60_000) : stats.filesFailed > 0 ? new Date(now.getTime() + failureBackoffMs(1)) : nextDailySlot(a.id, now);
  await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, async (t) => {
    await t
      .update(storeAccounts)
      .set({
        healthStatus: health,
        healthDetail,
        healthCheckedAt: now,
        lastSyncFinishedAt: now,
        ...(fatal ? {} : { lastSuccessAt: now }),
        nextSyncAt: next,
        consecutiveFailures: failures,
        backfillCursor: fatal ? a.backfillCursor : stats.deferred > 0 ? 'pending' : null,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(and(eq(storeAccounts.id, a.id), eq(storeAccounts.leaseOwner, opts.owner)));
    await t
      .update(storeSyncRuns)
      .set({ status: outcome, finishedAt: now, stats: stats as unknown as Record<string, unknown>, error: fatal ? { message: fatal.message, health } : null })
      .where(eq(storeSyncRuns.id, run.id));
    if (fatal || health !== a.healthStatus) await audit(t, tenantId, ACTOR, fatal ? 'store.sync.failed' : 'store.account.health_changed', { type: 'store_account', id: a.id }, { from: a.healthStatus, to: health, message: fatal?.message ?? null, failures });
  });
  return { skipped: false as const, runId: run.id, outcome, health, stats, nextSyncAt: next.toISOString() };
}

/* ------------------------------------------------------------------ */
/* Google Play                                                         */
/* ------------------------------------------------------------------ */

const playFileRe = (f: PlayFamily) => new RegExp(`^${f.folder}/${f.stem}_([A-Za-z][A-Za-z0-9_.]*)_(\\d{6})_([a-z_]+)\\.csv$`);

async function syncPlay(deps: CoreDeps, tenantId: string, ctx: ConnectorContext, a: Account, stats: SyncStats): Promise<Record<string, unknown>> {
  const now = deps.clock.now();
  const bucket = a.accountRef;
  const settings = AccountSettingsSchema.parse(a.settings ?? {});
  const dims = enabledPlayDimensions(settings);
  const window = new Set(monthsBack(now, settings.backfillMonths));
  // One listing per report family serves discovery and import for every app of the account.
  const listings = new Map<string, { obj: ReportObject; pkg: string; month: string; dim: string }[]>();
  for (const f of PLAY_FAMILIES) {
    const re = playFileRe(f);
    const objs = await listReportObjects(ctx, bucket, `${f.folder}/${f.stem}_`, { maxPages: 50 });
    stats.filesSeen += objs.length;
    listings.set(
      f.family,
      objs.flatMap((obj) => {
        const m = re.exec(obj.name);
        return m ? [{ obj, pkg: m[1]!, month: `${m[2]!.slice(0, 4)}-${m[2]!.slice(4)}`, dim: m[3]! }] : [];
      }),
    );
  }
  const fromReports = new Set([...listings.values()].flat().map((x) => x.pkg));
  let reporting: 'ok' | string = 'ok';
  let apiApps: { packageName: string; displayName: string | null }[] = [];
  try {
    apiApps = await searchPlayApps(ctx);
  } catch (err) {
    reporting = classifyPlayError(err).access;
    stats.notes.push(`Play Developer Reporting API unavailable (${reporting}): app names and vitals are not imported.`);
  }
  const apps = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, async (t) => {
    for (const pkg of fromReports) await upsertDiscoveredApp(t, tenantId, a, { platform: 'android', appId: pkg, displayName: apiApps.find((x) => x.packageName === pkg)?.displayName ?? null, via: 'report_bucket', reliable: true }, now);
    // Apps the key can see through the API but with no file in this account's bucket may belong to another developer account: owner confirms.
    for (const x of apiApps) if (!fromReports.has(x.packageName)) await upsertDiscoveredApp(t, tenantId, a, { platform: 'android', appId: x.packageName, displayName: x.displayName, via: 'play_reporting_api', reliable: false }, now);
    return t
      .select()
      .from(storeApps)
      .where(and(eq(storeApps.storeAccountId, a.id), eq(storeApps.status, 'confirmed')));
  });
  stats.appsSeen = apps.length;
  const imported = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) => t.select({ uri: storeReportFiles.sourceUri, version: storeReportFiles.sourceVersion }).from(storeReportFiles).where(eq(storeReportFiles.storeAccountId, a.id)));
  const done = new Set(imported.map((r) => `${r.uri}#${r.version}`));
  const pendingKeys = new Set<string>();
  let budget = MAX_FILES_PER_RUN;
  for (const app of apps) {
    for (const f of PLAY_FAMILIES) {
      const wanted = new Set(dims[f.family] ?? []);
      const files = (listings.get(f.family) ?? []).filter((x) => x.pkg === app.appId && window.has(x.month) && wanted.has(x.dim)).sort((x, y) => (x.month === y.month ? x.dim.localeCompare(y.dim) : y.month.localeCompare(x.month)));
      for (const x of files) {
        const uri = `gs://${bucket}/${x.obj.name}`;
        if (done.has(`${uri}#${x.obj.generation}`)) continue;
        if (budget <= 0) {
          stats.deferred++;
          pendingKeys.add(`${f.family}|${x.dim}|${x.month}`);
          continue;
        }
        budget--;
        const dimension = f.dimensions.find((d) => d.suffix === x.dim);
        if (!dimension) continue;
        await importPlayFile(deps, tenantId, ctx, a, app, f, dimension, x, uri, stats).catch((err) => {
          const c = classify(err);
          if (c.health === 'permission_denied' || c.health === 'auth_failed' || c.health === 'rate_limited') throw err;
          stats.filesFailed++;
          pendingKeys.add(`${f.family}|${x.dim}|${x.month}`);
          stats.notes.push(`${x.obj.name}: ${c.message}`.slice(0, 300));
        });
      }
    }
    if (settings.vitals && reporting === 'ok') await syncVitals(deps, tenantId, ctx, a, app, stats);
    // Older months only change when a file changes: a quiet daily run re-checks the last three.
    const coverageMonths = stats.filesImported > 0 || stats.filesRejected > 0 || a.backfillCursor !== null ? [...window] : monthsBack(now, 3);
    await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, async (t) => {
      for (const f of PLAY_FAMILIES) {
        for (const d of dims[f.family] ?? []) {
          const present = new Set((listings.get(f.family) ?? []).filter((x) => x.pkg === app.appId && x.dim === d).map((x) => x.month));
          await refreshCoverage(t, tenantId, app, f.family, f.dimensions.find((x) => x.suffix === d)?.key ?? d, coverageMonths, now, (month) => {
            if (pendingKeys.has(`${f.family}|${d}|${month}`)) return { status: 'pending', detail: { reason: 'a published report is waiting to be imported' } };
            if (!present.has(month)) return month >= ym(new Date(now.getTime() - PLAY_POSTING_DAYS * DAY)) ? { status: 'not_yet_published', detail: { reason: 'Google posts statistics within 3 to 7 days' } } : { status: 'unavailable', detail: { reason: 'Google published no report for this month' } };
            return null;
          });
        }
      }
    });
  }
  return { bucket, reporting, appsInBucket: fromReports.size, appsInReportingApi: apiApps.length };
}

async function importPlayFile(deps: CoreDeps, tenantId: string, ctx: ConnectorContext, a: Account, app: App, f: PlayFamily, dimension: PlayFamily['dimensions'][number], x: { obj: ReportObject; pkg: string; month: string; dim: string }, uri: string, stats: SyncStats) {
  const now = deps.clock.now();
  const target: ImportTarget = { tenantId, storeAccountId: a.id, storeAppId: app.id, platform: 'android', appId: app.appId, provider: 'google_play' };
  const base: Omit<SourceFile, 'sha256' | 'encoding' | 'objectKey' | 'sizeBytes'> = { uri, version: x.obj.generation, rank: Number(x.obj.generation), period: x.month, updatedAt: x.obj.updated ? new Date(x.obj.updated) : null, checksum: x.obj.md5Hash };
  let bytes: Uint8Array;
  try {
    bytes = await downloadReportObject(ctx, a.accountRef, x.obj, REPORT_LIMITS.maxDownloadBytes);
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 413) {
      await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) => recordRejectedFile(t, target, { ...base, sha256: '', encoding: null, objectKey: null, sizeBytes: x.obj.size }, { family: f.family, dimension: dimension.key, error: err.message, code: 'too_large' }, now));
      stats.filesRejected++;
      return;
    }
    throw err;
  }
  const sha256 = sha256Hex(bytes);
  const objectKey = tenantKey(tenantId, 'reports', 'store', 'google_play', safePart(app.appId), x.month, `${f.stem}-${x.dim}-${x.obj.generation}.csv`);
  await deps.store.put(objectKey, bytes, 'text/csv');
  const source: SourceFile = { ...base, sha256, objectKey, sizeBytes: bytes.byteLength, encoding: null };
  let parsed: ParsedReport;
  try {
    const decoded = decodeReport(bytes);
    source.encoding = decoded.encoding;
    parsed = parsePlayReport(decoded.text, f, dimension, app.appId);
  } catch (err) {
    if (!(err instanceof ReportFormatError)) throw err;
    await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) => recordRejectedFile(t, target, source, { family: f.family, dimension: dimension.key, error: err.message, code: err.code }, now));
    stats.filesRejected++;
    return;
  }
  const r = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) =>
    importParsedReport(t, target, source, parsed, { now, completeAfterDays: PLAY_POSTING_DAYS, evidence: { uri: `${uri}#${x.obj.generation}`, license: 'Google Play Console reports (account holder data)', freshnessSlaHours: 24 * 9 } }),
  );
  if (r.duplicate) stats.filesUnchanged++;
  else if (r.status === 'rejected') stats.filesRejected++;
  else stats.filesImported++;
  stats.observations += r.observations;
  stats.revisedDays += r.partitionsRevised;
}

async function syncVitals(deps: CoreDeps, tenantId: string, ctx: ConnectorContext, a: Account, app: App, stats: SyncStats) {
  const now = deps.clock.now();
  for (const [set, dimension] of [
    ['crashRateMetricSet', 'crash_rate'],
    ['anrRateMetricSet', 'anr_rate'],
  ] as [VitalsMetricSet, 'crash_rate' | 'anr_rate'][]) {
    try {
      const end = await vitalsFreshness(ctx, app.appId, set);
      if (!end) continue;
      const from = ymd(new Date(Date.parse(`${end}T00:00:00Z`) - 35 * DAY));
      const { rows, raw } = await queryVitals(ctx, app.appId, set, { from, to: end });
      const body = new TextEncoder().encode(JSON.stringify(raw));
      const sha256 = sha256Hex(body);
      const uri = `playreporting://apps/${app.appId}/${set}?from=${from}&to=${end}`;
      const objectKey = tenantKey(tenantId, 'reports', 'store', 'google_play', safePart(app.appId), 'vitals', `${dimension}-${end}-${sha256.slice(0, 12)}.json`);
      await deps.store.put(objectKey, body, 'application/json');
      const parsed = parseVitals(
        rows,
        VITALS_METRIC_SETS[set].filter((m) => m !== 'distinctUsers'),
        dimension,
      );
      const r = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) =>
        importParsedReport(t, { tenantId, storeAccountId: a.id, storeAppId: app.id, platform: 'android', appId: app.appId, provider: 'google_play' }, { uri, version: sha256, rank: now.getTime(), period: end, updatedAt: now, checksum: null, sizeBytes: body.byteLength, sha256, encoding: 'utf-8', objectKey }, parsed, {
          now,
          completeAfterDays: 0,
          evidence: { uri: `${uri}#${sha256.slice(0, 16)}`, license: 'Google Play Developer Reporting API (account holder data)', freshnessSlaHours: 72 },
        }),
      );
      stats.observations += r.observations;
      await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) => refreshCoverage(t, tenantId, app, PLAY_VITALS.family, dimension, monthsBack(now, 2), now, () => null));
    } catch (err) {
      const c = classifyPlayError(err);
      stats.notes.push(`${app.appId} ${set}: ${c.message}`.slice(0, 300));
      if (c.access === 'auth_failed') throw err;
    }
  }
}

/* ------------------------------------------------------------------ */
/* App Store Connect                                                   */
/* ------------------------------------------------------------------ */

async function syncApple(deps: CoreDeps, tenantId: string, ctx: ConnectorContext, a: Account, stats: SyncStats): Promise<Record<string, unknown>> {
  const now = deps.clock.now();
  const visible = await listAscApps(ctx);
  const apps = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, async (t) => {
    for (const x of visible) await upsertDiscoveredApp(t, tenantId, a, { platform: 'ios', appId: x.bundleId, storeAppId: x.id, displayName: x.name, via: 'asc_apps_api', reliable: true }, now);
    return t
      .select()
      .from(storeApps)
      .where(and(eq(storeApps.storeAccountId, a.id), eq(storeApps.status, 'confirmed')));
  });
  stats.appsSeen = apps.length;
  const imported = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) => t.select({ uri: storeReportFiles.sourceUri }).from(storeReportFiles).where(eq(storeReportFiles.storeAccountId, a.id)));
  const done = new Set(imported.map((r) => r.uri));
  let budget = MAX_FILES_PER_RUN;
  let requestsReadable = true;
  for (const app of apps) {
    if (!app.storeAppId) continue;
    const pending = new Set<string>();
    let requests: { id: string; accessType: string; stoppedDueToInactivity: boolean }[] = [];
    try {
      requests = await listAnalyticsReportRequests(ctx, app.storeAppId);
    } catch (err) {
      if (!(err instanceof ProviderHttpError) || err.status !== 403) throw err;
      requestsReadable = false;
    }
    const known = (app.settings as { analytics?: Record<string, { requestId?: string }> }).analytics ?? {};
    const ids = [...new Set([...requests.filter((r) => !r.stoppedDueToInactivity).map((r) => r.id), ...Object.values(known).flatMap((v) => (v.requestId ? [v.requestId] : []))])];
    const stopped = requests.some((r) => r.accessType === 'ONGOING' && r.stoppedDueToInactivity) && !requests.some((r) => r.accessType === 'ONGOING' && !r.stoppedDueToInactivity);
    for (const requestId of ids) {
      let reports: { id: string; name: string; category: string }[] = [];
      try {
        reports = await listAnalyticsReports(ctx, requestId);
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status === 404) continue;
        throw err;
      }
      for (const f of APPLE_FAMILIES) {
        const report = reports.find((r) => f.names.test(r.name));
        if (!report) continue;
        const instances = await listReportInstances(ctx, report.id, 'DAILY');
        for (const inst of instances.sort((x, y) => y.processingDate.localeCompare(x.processingDate))) {
          const uri = `asc://analyticsReportInstances/${inst.id}`;
          if (done.has(uri)) continue;
          if (budget <= 0) {
            stats.deferred++;
            pending.add(f.family);
            continue;
          }
          budget--;
          await importAppleInstance(deps, tenantId, ctx, a, app, f, inst, uri, stats).catch((err) => {
            const c = classify(err);
            if (c.health === 'auth_failed' || c.health === 'rate_limited') throw err;
            stats.filesFailed++;
            pending.add(f.family);
            stats.notes.push(`${app.appId} ${f.family} ${inst.processingDate}: ${c.message}`.slice(0, 300));
          });
          done.add(uri);
        }
      }
    }
    await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, async (t) => {
      for (const f of APPLE_FAMILIES) {
        await refreshCoverage(t, tenantId, app, f.family, 'standard', monthsBack(now, 3), now, (month) => {
          if (pending.has(f.family)) return { status: 'pending', detail: { reason: 'report instances are waiting to be imported' } };
          if (!ids.length)
            return requestsReadable
              ? { status: 'pending', detail: { reason: stopped ? 'Apple stopped the ongoing report request after inactivity; request reports again' : 'no analytics report request yet; request reports with an Admin API key', action: 'request_reports' } }
              : { status: 'permission_denied', detail: { reason: 'this API key cannot read analytics report requests' } };
          const since = Date.parse(`${month}-01T00:00:00Z`);
          return now.getTime() - since < 40 * DAY
            ? { status: 'not_yet_published', detail: { reason: `Apple completes this report within ${f.completenessDays} days of each date` } }
            : { status: 'unavailable', detail: { reason: 'Apple keeps report instances for 35 days; request a one-time snapshot for older history' } };
        });
      }
    });
  }
  return { appsVisible: visible.length, requestsReadable };
}

async function importAppleInstance(deps: CoreDeps, tenantId: string, ctx: ConnectorContext, a: Account, app: App, f: AppleFamily, inst: { id: string; processingDate: string }, uri: string, stats: SyncStats) {
  const now = deps.clock.now();
  const segments = await listInstanceSegments(ctx, inst.id);
  const target: ImportTarget = { tenantId, storeAccountId: a.id, storeAppId: app.id, platform: 'ios', appId: app.appId, provider: 'app_store_connect' };
  const processed = new Date(`${inst.processingDate}T00:00:00Z`);
  const texts: string[] = [];
  const parts: Uint8Array[] = [];
  let size = 0;
  let encoding: string | null = null;
  const base = { uri, version: inst.id, rank: Math.floor(processed.getTime() / 1000), period: inst.processingDate, updatedAt: processed, checksum: segments.map((s) => s.checksum ?? '').join(',') || null };
  try {
    for (const seg of segments.sort((x, y) => x.id.localeCompare(y.id))) {
      const bytes = await downloadReportSegment(ctx, seg, REPORT_LIMITS.maxDownloadBytes);
      size += bytes.byteLength;
      if (size > REPORT_LIMITS.maxDownloadBytes) throw new ReportFormatError('report instance exceeds the import size limit', 'too_large');
      parts.push(bytes);
      const decoded = decodeReport(bytes);
      encoding = decoded.encoding;
      texts.push(decoded.text);
    }
    // Gzip members concatenate into one valid gzip stream: one retained object per instance.
    const raw = Buffer.concat(parts);
    const objectKey = tenantKey(tenantId, 'reports', 'store', 'app_store_connect', safePart(app.appId), inst.processingDate, `${f.family}-${safePart(inst.id)}.gz`);
    await deps.store.put(objectKey, raw, 'application/gzip');
    const parsed = parseAppleReport(texts, f, app.storeAppId!);
    const source: SourceFile = { ...base, sha256: sha256Hex(raw), encoding, objectKey, sizeBytes: size };
    const r = await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) =>
      importParsedReport(t, target, source, parsed, { now, completeAfterDays: f.completenessDays, evidence: { uri: `${uri}#${inst.processingDate}`, license: 'App Store Connect Analytics Reports (account holder data)', freshnessSlaHours: 24 * (f.completenessDays + 2) } }),
    );
    if (r.duplicate) stats.filesUnchanged++;
    else if (r.status === 'rejected') stats.filesRejected++;
    else stats.filesImported++;
    stats.observations += r.observations;
    stats.revisedDays += r.partitionsRevised;
  } catch (err) {
    if (!(err instanceof ReportFormatError)) throw err;
    await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, (t) => recordRejectedFile(t, target, { ...base, sha256: sha256Hex(Buffer.concat(parts)), encoding, objectKey: null, sizeBytes: size }, { family: f.family, dimension: 'standard', error: err.message, code: err.code }, now));
    stats.filesRejected++;
  }
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

type CoverageStatus = (typeof storeReportCoverage.$inferSelect)['status'];

/**
 * Per month: complete (every elapsed day imported and final), revised (complete with restated
 * days), partial (some days, or still in progress), or the fallback's verdict when nothing was
 * imported (pending, not yet published, unavailable, permission denied). Never inferred as zero.
 */
export async function refreshCoverage(t: Tx, tenantId: string, app: App, family: string, dimension: string, months: string[], now: Date, fallback: (month: string) => { status: CoverageStatus; detail: Record<string, unknown> } | null) {
  const yesterday = ymd(new Date(now.getTime() - DAY));
  for (const month of months) {
    const first = `${month}-01`;
    const lastOfMonth = ymd(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
    const last = lastOfMonth < yesterday ? lastOfMonth : yesterday;
    if (first > last) continue;
    const expected = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY) + 1;
    const [s] = await t
      .select({
        days: sql<number>`count(*)::int`,
        complete: sql<number>`count(*) filter (where ${storeReportPartitions.status} = 'complete')::int`,
        revised: sql<number>`count(*) filter (where ${storeReportPartitions.revision} > 1)::int`,
        through: sql<string | null>`max(${storeReportPartitions.observationDate})::text`,
      })
      .from(storeReportPartitions)
      .where(and(eq(storeReportPartitions.storeAppId, app.id), eq(storeReportPartitions.family, family), eq(storeReportPartitions.dimension, dimension), gte(storeReportPartitions.observationDate, first), lte(storeReportPartitions.observationDate, lastOfMonth)));
    const fb = fallback(month);
    let status: CoverageStatus;
    let detail: Record<string, unknown> = { days: s?.days ?? 0, completeDays: s?.complete ?? 0, expectedDays: expected, through: s?.through ?? null };
    if (fb && (fb.status === 'pending' || !s?.days)) {
      status = fb.status;
      detail = { ...detail, ...fb.detail };
    } else if (!s?.days) {
      status = 'not_yet_published';
    } else if (s.complete >= expected && lastOfMonth <= yesterday) {
      status = s.revised ? 'revised' : 'complete';
    } else {
      status = 'partial';
    }
    await t
      .insert(storeReportCoverage)
      .values({ tenantId, storeAppId: app.id, family, dimension, period: month, status, detail, checkedAt: now })
      .onConflictDoUpdate({ target: [storeReportCoverage.tenantId, storeReportCoverage.storeAppId, storeReportCoverage.family, storeReportCoverage.dimension, storeReportCoverage.period], set: { status, detail, checkedAt: now } });
  }
}

/** Access lost for the whole account: the current month of every confirmed app says so. */
async function markAccountCoverage(deps: CoreDeps, tenantId: string, a: Account, status: 'permission_denied' | 'unavailable', reason: string) {
  const now = deps.clock.now();
  await withTenant(deps.db, { tenantId, actor: 'system:store-reporting' }, async (t) => {
    const apps = await t
      .select()
      .from(storeApps)
      .where(and(eq(storeApps.storeAccountId, a.id), eq(storeApps.status, 'confirmed')));
    const families = a.provider === 'google_play' ? PLAY_FAMILIES.map((f) => ({ family: f.family, dims: enabledPlayDimensions(AccountSettingsSchema.parse(a.settings ?? {}))[f.family] ?? [] })) : APPLE_FAMILIES.map((f) => ({ family: f.family, dims: ['standard'] }));
    for (const app of apps) {
      for (const f of families) {
        for (const d of f.dims) {
          const dimension = PLAY_FAMILIES.find((x) => x.family === f.family)?.dimensions.find((x) => x.suffix === d)?.key ?? d;
          await t
            .insert(storeReportCoverage)
            .values({ tenantId, storeAppId: app.id, family: f.family, dimension, period: ym(now), status, detail: { reason }, checkedAt: now })
            .onConflictDoUpdate({ target: [storeReportCoverage.tenantId, storeReportCoverage.storeAppId, storeReportCoverage.family, storeReportCoverage.dimension, storeReportCoverage.period], set: { status, detail: { reason }, checkedAt: now } });
        }
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Scheduling and retention                                            */
/* ------------------------------------------------------------------ */

/** Accounts whose next sync is due and that no worker holds. */
export async function dueStoreAccounts(deps: CoreDeps, tenantId: string): Promise<{ id: string; backfill: boolean }[]> {
  const now = deps.clock.now();
  return withTenant(deps.db, { tenantId, actor: 'system:scheduler' }, async (t) =>
    (
      await t
        .select({ id: storeAccounts.id, cursor: storeAccounts.backfillCursor })
        .from(storeAccounts)
        .where(and(eq(storeAccounts.status, 'active'), or(isNull(storeAccounts.nextSyncAt), lte(storeAccounts.nextSyncAt, now)), or(isNull(storeAccounts.leaseUntil), lt(storeAccounts.leaseUntil, now))))
    ).map((r) => ({ id: r.id, backfill: r.cursor !== null })),
  );
}

/**
 * Raw report copies are kept `days` (default 400) for re-parsing and audit, then deleted from object
 * storage. Normalized observations, file records and evidence stay (aggregate, no personal data).
 */
export async function pruneStoreReportObjects(deps: CoreDeps, tenantId: string, days = 400) {
  const cutoff = new Date(deps.clock.now().getTime() - days * DAY);
  const rows = await withTenant(deps.db, { tenantId, actor: 'system:retention' }, (t) =>
    t
      .select({ id: storeReportFiles.id, key: storeReportFiles.objectKey })
      .from(storeReportFiles)
      .where(and(lt(storeReportFiles.importedAt, cutoff), sql`${storeReportFiles.objectKey} is not null`))
      .limit(500),
  );
  let deleted = 0;
  for (const r of rows) {
    if (r.key) await deps.store.delete(r.key);
    await withTenant(deps.db, { tenantId, actor: 'system:retention' }, (t) => t.update(storeReportFiles).set({ objectKey: null }).where(eq(storeReportFiles.id, r.id)));
    deleted++;
  }
  return { deleted };
}

import { type DbOrTx, metricPoints, metricSeries, storeApps, type Tx } from '@futuregrow/db';
import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { type Actor, systemActor } from '../../../deps.js';
import { audit } from '../../../util.js';
import { appendPoints, upsertSeries } from '../../m08-analytics/index.js';
import { METRIC_DEFINITIONS, type StorePlatform } from './definitions.js';
import { type DailyTotal, dailyTotals, isUsableTotal } from './query.js';

const DAY = 86_400_000;
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * M08 KPI series fed from store reports. Each is one provider metric with one definition; Android
 * and iOS are separate series. Only final values (complete partitions) backed by admitted evidence
 * of the winning report version become points. A per-platform ("all apps") point exists only on
 * days every confirmed app of that platform has such a value: an app without a value makes the day
 * unknown, never a smaller total.
 */
export const STORE_KPI_SERIES = {
  'app.store.android.user_installs': { metricKey: 'play.daily_user_installs', platform: 'android', name: 'Google Play user installs (all apps)', unit: 'installs' },
  'app.store.android.listing_acquisitions': { metricKey: 'play.store_listing_acquisitions', platform: 'android', name: 'Google Play store listing acquisitions (all apps)', unit: 'acquisitions' },
  'app.store.ios.first_time_downloads': { metricKey: 'asc.first_time_downloads', platform: 'ios', name: 'App Store first-time downloads, Analytics Reports (all apps)', unit: 'downloads' },
} as const satisfies Record<string, { metricKey: string; platform: StorePlatform; name: string; unit: string }>;
export type StoreSeriesKey = keyof typeof STORE_KPI_SERIES;
export const isStoreSeriesKey = (k: string): k is StoreSeriesKey => k in STORE_KPI_SERIES || /^app\.store\.(android|ios)\.[a-z_]+:/.test(k);

export const perAppKey = (base: StoreSeriesKey, appId: string) => `${base}:${appId.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`.slice(0, 200);

/** The platform series a store key belongs to, and the per-app suffix when it is one app's own series. */
export function parseStoreSeriesKey(key: string): { base: StoreSeriesKey; appSuffix: string | null } | null {
  const i = key.indexOf(':');
  const base = i < 0 ? key : key.slice(0, i);
  if (!(base in STORE_KPI_SERIES)) return null;
  return { base: base as StoreSeriesKey, appSuffix: i < 0 ? null : key.slice(i + 1) };
}

type Point = { ts: string; value: number; evidenceId: string };

/**
 * Makes one series hold exactly `pts` inside the sync window: upserts them, then removes points
 * the current reports no longer support (revoked or rejected evidence, a lost final value, an app
 * no longer confirmed, an all-apps day that is no longer complete). Points before the window and
 * other series are untouched; raw reports, observations and evidence are never deleted.
 */
async function materialize(t: Tx, tenantId: string, actor: Actor, key: string, meta: { name: string; unit: string; channel: string }, pts: Point[], windowStart: Date) {
  const [existing] = await t.select({ id: metricSeries.id }).from(metricSeries).where(eq(metricSeries.key, key));
  let seriesId = existing?.id ?? null;
  if (pts.length) {
    const series = await upsertSeries(t, tenantId, actor, { key, name: meta.name, unit: meta.unit, granularity: 'day', kind: 'kpi', channel: meta.channel, sourceEvidenceId: pts.at(-1)!.evidenceId });
    seriesId = series.id;
    await appendPoints(t, tenantId, series.id, pts);
  }
  if (!seriesId) return { points: 0, removed: 0 };
  const keep = pts.map((p) => new Date(p.ts));
  const removed = await t
    .delete(metricPoints)
    .where(and(eq(metricPoints.seriesId, seriesId), gte(metricPoints.ts, windowStart), keep.length ? notInArray(metricPoints.ts, keep) : undefined))
    .returning({ ts: metricPoints.ts });
  if (removed.length) {
    const days = removed.map((r) => r.ts.toISOString().slice(0, 10)).sort();
    await audit(t, tenantId, actor, 'analytics.series.points_invalidated', { type: 'metric_series', id: seriesId }, { key, removed: removed.length, firstDay: days[0], lastDay: days.at(-1), reason: 'no longer supported by a final store report with admitted evidence' });
  }
  return { points: pts.length, removed: removed.length };
}

const pointOf = (x: DailyTotal): Point => ({ ts: `${x.day}T00:00:00Z`, value: x.value!, evidenceId: x.evidenceId! });

/**
 * Writes per-platform and per-app series from imported reports. Idempotent and safe to repeat: it
 * recomputes the whole window from the current report partitions, so a revision updates the value
 * and evidence of its day, and a value that lost its support is removed. Runs one at a time per
 * organization (transaction-scoped advisory lock), so concurrent runs cannot interleave.
 */
export async function syncStoreKpiSeries(t: Tx, tenantId: string, now: Date, lookbackDays = 730) {
  await t.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`store-kpi:${tenantId}`}, 0))`);
  const to = shift(now.toISOString().slice(0, 10), -1);
  const from = shift(to, -lookbackDays);
  const windowStart = new Date(`${from}T00:00:00Z`);
  const actor = systemActor('store-reporting');
  const written: { key: string; points: number; removed: number }[] = [];
  const note = (key: string, r: { points: number; removed: number }) => {
    if (r.points || r.removed) written.push({ key, ...r });
  };
  for (const [key, def] of Object.entries(STORE_KPI_SERIES) as [StoreSeriesKey, (typeof STORE_KPI_SERIES)[StoreSeriesKey]][]) {
    const channel = def.platform === 'android' ? 'google_play' : 'app_store';
    const apps = await t
      .select()
      .from(storeApps)
      .where(and(eq(storeApps.platform, def.platform), eq(storeApps.status, 'confirmed')))
      .orderBy(storeApps.appId);
    const usable = (
      await dailyTotals(
        t,
        apps.map((a) => a.id),
        [def.metricKey],
        from,
        to,
      )
    ).filter(isUsableTotal);
    const byDay = new Map<string, Map<string, DailyTotal>>();
    for (const x of usable) {
      const day = byDay.get(x.day) ?? new Map<string, DailyTotal>();
      day.set(x.appRowId, x);
      byDay.set(x.day, day);
    }
    // All apps: the day's sum only when every confirmed app has a final value; it cites the first app's report.
    const platformPts = [...byDay.entries()]
      .filter(([, vals]) => apps.length > 0 && apps.every((a) => vals.has(a.id)))
      .map(([day, vals]) => ({ ts: `${day}T00:00:00Z`, value: apps.reduce((s, a) => s + vals.get(a.id)!.value!, 0), evidenceId: vals.get(apps[0]!.id)!.evidenceId! }))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    note(key, await materialize(t, tenantId, actor, key, { name: def.name, unit: def.unit, channel }, platformPts, windowStart));
    const own = new Set<string>();
    for (const app of apps) {
      const k = perAppKey(key, app.appId);
      own.add(k);
      const pts = usable
        .filter((x) => x.appRowId === app.id)
        .map(pointOf)
        .sort((a, b) => a.ts.localeCompare(b.ts));
      note(k, await materialize(t, tenantId, actor, k, { name: `${def.name.replace(' (all apps)', '')}: ${app.displayName ?? app.appId}`, unit: def.unit, channel }, pts, windowStart));
    }
    // Per-app series of apps that are no longer confirmed keep no current points.
    const orphans = await t
      .select({ key: metricSeries.key })
      .from(metricSeries)
      .where(sql`starts_with(${metricSeries.key}, ${`${key}:`})`);
    for (const o of orphans) if (!own.has(o.key)) note(o.key, await materialize(t, tenantId, actor, o.key, { name: o.key, unit: def.unit, channel }, [], windowStart));
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* Growth Brain signals                                                */
/* ------------------------------------------------------------------ */

export interface StoreSignal {
  appRowId: string;
  appId: string;
  platform: StorePlatform;
  metricKey: string;
  label: string;
  status: 'increase' | 'decrease' | 'no_clear_change' | 'insufficient_data' | 'stale';
  /** Newest final day of this metric with admitted evidence (null when there is none). */
  latestFinalDay: string | null;
  recent: { from: string; to: string; total: number | null; days: number } | null;
  previous: { from: string; to: string; total: number | null; days: number } | null;
  /** Rate ratio recent/previous with a 95% interval (quasi-Poisson). */
  ratio: number | null;
  interval: [number, number] | null;
  /** Days in the two windows the provider restated; the newest version is used. */
  revisedDays: number;
  evidenceIds: string[];
  statement: string;
}

const SIGNAL_METRICS: Record<StorePlatform, string[]> = { android: ['play.store_listing_acquisitions', 'play.daily_user_installs'], ios: ['asc.first_time_downloads'] };
export const SIGNAL_RULES = { windowDays: 28, minDaysPerWindow: 24, minCountPerWindow: 10, staleAfterDays: 12 } as const;

/** Newest day of one app's metric that is final and backed by admitted evidence of the winning report version. */
async function latestFinalDay(t: DbOrTx, appRowId: string, metricKey: string, today: string): Promise<string | null> {
  const r = await t.execute<{ day: string | null }>(sql`
    select max(o.observation_date)::text as day
    from store_metric_observations o
    join store_report_partitions p on p.id = o.partition_id
    join store_report_files f on f.id = p.report_file_id
    join evidence_records e on e.id = f.evidence_id
    where o.store_app_id = ${appRowId}::uuid and o.metric_key = ${metricKey} and o.value is not null
      and p.status = 'complete' and e.status = 'admitted' and o.observation_date <= ${today}::date`);
  return r.rows[0]?.day ?? null;
}

/**
 * Descriptive change in reported acquisition, recent 28 complete days vs the 28 before, per app and
 * metric. Freshness and windows come from the analysed metric's own final, evidence-backed days
 * (never from another report family). Abstains (insufficient_data / stale) rather than guessing;
 * intervals widen with day-to-day overdispersion. A change is an observation, never attributed to
 * a cause here.
 */
export async function storeKpiSignals(t: DbOrTx, now: Date): Promise<{ signals: StoreSignal[]; qualityFlags: { appId: string; platform: StorePlatform; statement: string }[]; rules: typeof SIGNAL_RULES }> {
  const apps = await t.select().from(storeApps).where(eq(storeApps.status, 'confirmed')).orderBy(storeApps.platform, storeApps.appId);
  const today = now.toISOString().slice(0, 10);
  const signals: StoreSignal[] = [];
  const qualityFlags: { appId: string; platform: StorePlatform; statement: string }[] = [];
  for (const app of apps) {
    const platform = app.platform as StorePlatform;
    for (const metricKey of SIGNAL_METRICS[platform]) {
      const def = METRIC_DEFINITIONS[metricKey]!;
      const base = { appRowId: app.id, appId: app.appId, platform, metricKey, label: def.label, latestFinalDay: null, recent: null, previous: null, ratio: null, interval: null, revisedDays: 0, evidenceIds: [] as string[] };
      // Provisional days (still being posted) and values without admitted evidence are excluded.
      const last = await latestFinalDay(t, app.id, metricKey, today);
      if (!last) {
        signals.push({ ...base, status: 'insufficient_data', statement: `${def.label} for ${app.appId}: no final report days with admitted evidence yet.` });
        continue;
      }
      const staleDays = Math.floor((now.getTime() - Date.parse(`${last}T00:00:00Z`)) / DAY);
      if (staleDays > SIGNAL_RULES.staleAfterDays) {
        signals.push({ ...base, latestFinalDay: last, status: 'stale', statement: `${def.label} for ${app.appId}: latest final day is ${last} (${staleDays} days old); no trend is stated on stale data.` });
        continue;
      }
      const rTo = last;
      const rFrom = shift(rTo, -(SIGNAL_RULES.windowDays - 1));
      const pTo = shift(rFrom, -1);
      const pFrom = shift(pTo, -(SIGNAL_RULES.windowDays - 1));
      const totals = (await dailyTotals(t, [app.id], [metricKey], pFrom, rTo)).filter(isUsableTotal);
      const recentDays = totals.filter((x) => x.day >= rFrom);
      const prevDays = totals.filter((x) => x.day <= pTo);
      const a = recentDays.reduce((s, x) => s + x.value!, 0);
      const b = prevDays.reduce((s, x) => s + x.value!, 0);
      const recent = { from: rFrom, to: rTo, total: recentDays.length ? a : null, days: recentDays.length };
      const previous = { from: pFrom, to: pTo, total: prevDays.length ? b : null, days: prevDays.length };
      const evidenceIds = [...new Set(totals.map((x) => x.evidenceId!))].sort().slice(0, 20);
      const revisedDays = totals.filter((x) => x.revision > 1).length;
      const revisedNote = revisedDays ? ` ${revisedDays} of these days were restated by the provider; the newest version is used.` : '';
      const known = { ...base, latestFinalDay: last, recent, previous, evidenceIds, revisedDays };
      if (recentDays.length < SIGNAL_RULES.minDaysPerWindow || prevDays.length < SIGNAL_RULES.minDaysPerWindow || a < SIGNAL_RULES.minCountPerWindow || b < SIGNAL_RULES.minCountPerWindow) {
        signals.push({
          ...known,
          status: 'insufficient_data',
          statement: `${def.label} for ${app.appId}: ${recentDays.length}/${prevDays.length} final reported days and ${a}/${b} in the two ${SIGNAL_RULES.windowDays}-day windows; at least ${SIGNAL_RULES.minDaysPerWindow} days and ${SIGNAL_RULES.minCountPerWindow} per window are needed to state a change.${revisedNote}`,
        });
        continue;
      }
      // Quasi-Poisson: dispersion from daily counts around each window's mean (at least 1).
      const resid = (xs: typeof totals, mean: number) => xs.reduce((s, x) => s + (x.value! - mean) ** 2 / Math.max(mean, 1e-9), 0);
      const ma = a / recentDays.length;
      const mb = b / prevDays.length;
      const phi = Math.max(1, (resid(recentDays, ma) + resid(prevDays, mb)) / Math.max(1, recentDays.length + prevDays.length - 2));
      const ratio = ma / mb;
      const se = Math.sqrt(phi * (1 / a + 1 / b));
      const interval: [number, number] = [Math.exp(Math.log(ratio) - 1.96 * se), Math.exp(Math.log(ratio) + 1.96 * se)];
      const status = interval[0] > 1 ? 'increase' : interval[1] < 1 ? 'decrease' : 'no_clear_change';
      const pct = (x: number) => `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(0)}%`;
      signals.push({
        ...known,
        ratio,
        interval,
        status,
        statement: `${def.label} for ${app.appId}: ${a} in ${rFrom}..${rTo} vs ${b} in ${pFrom}..${pTo} (daily rate ${pct(ratio)}, 95% interval ${pct(interval[0])} to ${pct(interval[1])}): ${status === 'no_clear_change' ? 'no clear change' : `an observed ${status}`}. This is a reported change, not a measured effect of any action.${revisedNote}`,
      });
    }
    // Quality co-occurrence: crash/ANR rates rising while acquisitions fall (stated as co-occurring only).
    const acq = signals.find((s) => s.appRowId === app.id && s.status === 'decrease');
    if (acq) {
      const qKeys = platform === 'android' ? ['play.vitals.crash_rate', 'play.vitals.anr_rate', 'play.daily_crashes'] : ['asc.crashes'];
      const q = (await dailyTotals(t, [app.id], qKeys, acq.previous!.from, acq.recent!.to)).filter(isUsableTotal);
      for (const k of qKeys) {
        const r = q.filter((x) => x.metricKey === k && x.day >= acq.recent!.from);
        const p = q.filter((x) => x.metricKey === k && x.day <= acq.previous!.to);
        if (r.length < SIGNAL_RULES.minDaysPerWindow || p.length < SIGNAL_RULES.minDaysPerWindow) continue;
        const mr = r.reduce((s, x) => s + x.value!, 0) / r.length;
        const mp = p.reduce((s, x) => s + x.value!, 0) / p.length;
        if (mp > 0 && mr > mp * 1.25)
          qualityFlags.push({ appId: app.appId, platform, statement: `${METRIC_DEFINITIONS[k]?.label ?? k} for ${app.appId} rose from ${mp.toPrecision(3)} to ${mr.toPrecision(3)} per day while ${acq.label.toLowerCase()} decreased. The two co-occur; this does not show that one caused the other.` });
      }
    }
  }
  return { signals, qualityFlags, rules: SIGNAL_RULES };
}

/**
 * Store-report trend context for a goal measured on a store series (D-045 → Growth Brain): only the
 * goal's own metric, only the apps the series covers (one app for a per-app series, every confirmed
 * app of the platform for an all-apps series). `stated` signals have enough final, fresh,
 * evidence-backed days; the rest are listed as withheld so nothing reads as a trend.
 */
export async function storeTrendContext(t: DbOrTx, seriesKey: string, now: Date) {
  const parsed = parseStoreSeriesKey(seriesKey);
  if (!parsed) return null;
  const def = STORE_KPI_SERIES[parsed.base];
  const { signals } = await storeKpiSignals(t, now);
  const scoped = signals.filter((s) => s.platform === def.platform && s.metricKey === def.metricKey && (parsed.appSuffix === null || perAppKey(parsed.base, s.appId) === seriesKey));
  const stated = scoped.filter((s) => s.status === 'increase' || s.status === 'decrease' || s.status === 'no_clear_change');
  const withheld = scoped.filter((s) => !stated.includes(s));
  return {
    seriesKey,
    scope: parsed.appSuffix === null ? ('all_apps' as const) : ('app' as const),
    stated: stated.map((s) => ({ appId: s.appId, status: s.status, statement: s.statement, evidenceIds: s.evidenceIds })),
    withheld: withheld.map((s) => ({ appId: s.appId, status: s.status, statement: s.statement })),
  };
}

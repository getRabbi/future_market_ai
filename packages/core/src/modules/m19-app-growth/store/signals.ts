import { type DbOrTx, evidenceRecords, storeApps, storeReportFiles, storeReportPartitions, type Tx } from '@futuregrow/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { systemActor } from '../../../deps.js';
import { appendPoints, upsertSeries } from '../../m08-analytics/index.js';
import { METRIC_DEFINITIONS, type StorePlatform } from './definitions.js';
import { dailyTotals } from './query.js';

const DAY = 86_400_000;
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * M08 KPI series fed from store reports. Each is one provider metric with one definition; Android
 * and iOS are separate series. Per-platform series add the same metric across confirmed apps only
 * on days every reporting app has a value.
 */
export const STORE_KPI_SERIES = {
  'app.store.android.user_installs': { metricKey: 'play.daily_user_installs', platform: 'android', name: 'Google Play user installs (all apps)', unit: 'installs' },
  'app.store.android.listing_acquisitions': { metricKey: 'play.store_listing_acquisitions', platform: 'android', name: 'Google Play store listing acquisitions (all apps)', unit: 'acquisitions' },
  'app.store.ios.first_time_downloads': { metricKey: 'asc.first_time_downloads', platform: 'ios', name: 'App Store first-time downloads, Analytics Reports (all apps)', unit: 'downloads' },
} as const satisfies Record<string, { metricKey: string; platform: StorePlatform; name: string; unit: string }>;
export type StoreSeriesKey = keyof typeof STORE_KPI_SERIES;
export const isStoreSeriesKey = (k: string): k is StoreSeriesKey => k in STORE_KPI_SERIES || /^app\.store\.(android|ios)\.[a-z_]+:/.test(k);

const perAppKey = (base: StoreSeriesKey, appId: string) => `${base}:${appId.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`.slice(0, 200);

async function evidenceByDay(t: DbOrTx, appIds: string[], from: string, to: string) {
  if (!appIds.length) return { byDay: new Map<string, string>(), admitted: new Set<string>() };
  const rows = await t
    .select({ app: storeReportPartitions.storeAppId, day: storeReportPartitions.observationDate, evidenceId: storeReportFiles.evidenceId, status: evidenceRecords.status })
    .from(storeReportPartitions)
    .innerJoin(storeReportFiles, eq(storeReportFiles.id, storeReportPartitions.reportFileId))
    .leftJoin(evidenceRecords, eq(evidenceRecords.id, storeReportFiles.evidenceId))
    .where(and(inArray(storeReportPartitions.storeAppId, appIds), sql`${storeReportPartitions.observationDate} between ${from}::date and ${to}::date`));
  const byDay = new Map<string, string>();
  const admitted = new Set<string>();
  for (const r of rows) {
    if (!r.evidenceId) continue;
    byDay.set(`${r.app}|${r.day}`, r.evidenceId);
    if (r.status === 'admitted') admitted.add(r.evidenceId);
  }
  return { byDay, admitted };
}

/** A series is anchored on its newest admitted evidence; without any, it is not updated. */
const anchor = (pts: { evidenceId: string }[], admitted: Set<string>) => [...pts].reverse().find((p) => admitted.has(p.evidenceId))?.evidenceId ?? null;

/** Writes per-platform and per-app series from imported reports (idempotent: points upsert by day). */
export async function syncStoreKpiSeries(t: Tx, tenantId: string, now: Date, lookbackDays = 730) {
  const to = shift(now.toISOString().slice(0, 10), -1);
  const from = shift(to, -lookbackDays);
  const actor = systemActor('store-reporting');
  const written: { key: string; points: number }[] = [];
  for (const [key, def] of Object.entries(STORE_KPI_SERIES) as [StoreSeriesKey, (typeof STORE_KPI_SERIES)[StoreSeriesKey]][]) {
    const apps = await t
      .select()
      .from(storeApps)
      .where(and(eq(storeApps.platform, def.platform), eq(storeApps.status, 'confirmed')));
    if (!apps.length) continue;
    const totals = (
      await dailyTotals(
        t,
        apps.map((a) => a.id),
        [def.metricKey],
        from,
        to,
      )
    ).filter((x) => x.value !== null);
    if (!totals.length) continue;
    const { byDay: ev, admitted } = await evidenceByDay(
      t,
      apps.map((a) => a.id),
      from,
      to,
    );
    const reporting = [...new Set(totals.map((x) => x.appRowId))];
    const byDay = new Map<string, { sum: number; n: number; evidenceId: string | null }>();
    for (const x of totals) {
      const cur = byDay.get(x.day) ?? { sum: 0, n: 0, evidenceId: null };
      cur.sum += x.value!;
      cur.n++;
      cur.evidenceId ??= ev.get(`${x.appRowId}|${x.day}`) ?? null;
      byDay.set(x.day, cur);
    }
    const pts = [...byDay.entries()].filter(([, v]) => v.n === reporting.length && v.evidenceId).map(([day, v]) => ({ ts: `${day}T00:00:00Z`, value: v.sum, evidenceId: v.evidenceId! }));
    pts.sort((a, b) => a.ts.localeCompare(b.ts));
    const platformAnchor = anchor(pts, admitted);
    if (pts.length && platformAnchor) {
      const series = await upsertSeries(t, tenantId, actor, { key, name: def.name, unit: def.unit, granularity: 'day', kind: 'kpi', channel: def.platform === 'android' ? 'google_play' : 'app_store', sourceEvidenceId: platformAnchor });
      await appendPoints(t, tenantId, series.id, pts);
      written.push({ key, points: pts.length });
    }
    for (const app of apps) {
      const mine = totals.filter((x) => x.appRowId === app.id && ev.get(`${app.id}|${x.day}`));
      if (!mine.length) continue;
      const appPts = mine.map((x) => ({ ts: `${x.day}T00:00:00Z`, value: x.value!, evidenceId: ev.get(`${app.id}|${x.day}`)! })).sort((a, b) => a.ts.localeCompare(b.ts));
      const appAnchor = anchor(appPts, admitted);
      if (!appAnchor) continue;
      const k = perAppKey(key, app.appId);
      const series = await upsertSeries(t, tenantId, actor, { key: k, name: `${def.name.replace(' (all apps)', '')}: ${app.displayName ?? app.appId}`, unit: def.unit, granularity: 'day', kind: 'kpi', channel: def.platform === 'android' ? 'google_play' : 'app_store', sourceEvidenceId: appAnchor });
      await appendPoints(t, tenantId, series.id, appPts);
      written.push({ key: k, points: appPts.length });
    }
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
  recent: { from: string; to: string; total: number | null; days: number } | null;
  previous: { from: string; to: string; total: number | null; days: number } | null;
  /** Rate ratio recent/previous with a 95% interval (quasi-Poisson). */
  ratio: number | null;
  interval: [number, number] | null;
  evidenceIds: string[];
  statement: string;
}

const SIGNAL_METRICS: Record<StorePlatform, string[]> = { android: ['play.store_listing_acquisitions', 'play.daily_user_installs'], ios: ['asc.first_time_downloads'] };
export const SIGNAL_RULES = { windowDays: 28, minDaysPerWindow: 24, minCountPerWindow: 10, staleAfterDays: 12 } as const;

/**
 * Descriptive change in reported acquisition, recent 28 complete days vs the 28 before, per app.
 * Abstains (insufficient_data / stale) rather than guessing; intervals widen with day-to-day
 * overdispersion. A change is an observation, never attributed to a cause here.
 */
export async function storeKpiSignals(t: DbOrTx, now: Date): Promise<{ signals: StoreSignal[]; qualityFlags: { appId: string; platform: StorePlatform; statement: string }[]; rules: typeof SIGNAL_RULES }> {
  const apps = await t.select().from(storeApps).where(eq(storeApps.status, 'confirmed'));
  const signals: StoreSignal[] = [];
  const qualityFlags: { appId: string; platform: StorePlatform; statement: string }[] = [];
  for (const app of apps) {
    const platform = app.platform as StorePlatform;
    // Latest day whose partitions are final: provisional days (still being posted) are excluded.
    const [last] = await t
      .select({ day: sql<string | null>`max(${storeReportPartitions.observationDate})::text` })
      .from(storeReportPartitions)
      .where(and(eq(storeReportPartitions.storeAppId, app.id), eq(storeReportPartitions.status, 'complete'), lte(storeReportPartitions.observationDate, now.toISOString().slice(0, 10))));
    for (const metricKey of SIGNAL_METRICS[platform]) {
      const def = METRIC_DEFINITIONS[metricKey]!;
      const base = { appRowId: app.id, appId: app.appId, platform, metricKey, label: def.label, recent: null, previous: null, ratio: null, interval: null, evidenceIds: [] as string[] };
      if (!last?.day) {
        signals.push({ ...base, status: 'insufficient_data', statement: `${def.label} for ${app.appId}: no final report days yet.` });
        continue;
      }
      const staleDays = Math.floor((now.getTime() - Date.parse(`${last.day}T00:00:00Z`)) / DAY);
      if (staleDays > SIGNAL_RULES.staleAfterDays) {
        signals.push({ ...base, status: 'stale', statement: `${def.label} for ${app.appId}: latest final day is ${last.day} (${staleDays} days old); no trend is stated on stale data.` });
        continue;
      }
      const rTo = last.day;
      const rFrom = shift(rTo, -(SIGNAL_RULES.windowDays - 1));
      const pTo = shift(rFrom, -1);
      const pFrom = shift(pTo, -(SIGNAL_RULES.windowDays - 1));
      const totals = (await dailyTotals(t, [app.id], [metricKey], pFrom, rTo)).filter((x) => x.value !== null);
      const recentDays = totals.filter((x) => x.day >= rFrom);
      const prevDays = totals.filter((x) => x.day <= pTo);
      const a = recentDays.reduce((s, x) => s + x.value!, 0);
      const b = prevDays.reduce((s, x) => s + x.value!, 0);
      const recent = { from: rFrom, to: rTo, total: recentDays.length ? a : null, days: recentDays.length };
      const previous = { from: pFrom, to: pTo, total: prevDays.length ? b : null, days: prevDays.length };
      const files = await t
        .select({ evidenceId: storeReportFiles.evidenceId })
        .from(storeReportPartitions)
        .innerJoin(storeReportFiles, eq(storeReportFiles.id, storeReportPartitions.reportFileId))
        .where(and(eq(storeReportPartitions.storeAppId, app.id), sql`${storeReportPartitions.observationDate} between ${pFrom}::date and ${rTo}::date`))
        .groupBy(storeReportFiles.evidenceId)
        .limit(12);
      const evidenceIds = files.map((f) => f.evidenceId).filter((x): x is string => Boolean(x));
      if (recentDays.length < SIGNAL_RULES.minDaysPerWindow || prevDays.length < SIGNAL_RULES.minDaysPerWindow || a < SIGNAL_RULES.minCountPerWindow || b < SIGNAL_RULES.minCountPerWindow) {
        signals.push({
          ...base,
          recent,
          previous,
          evidenceIds,
          status: 'insufficient_data',
          statement: `${def.label} for ${app.appId}: ${recentDays.length}/${prevDays.length} reported days and ${a}/${b} in the two ${SIGNAL_RULES.windowDays}-day windows; at least ${SIGNAL_RULES.minDaysPerWindow} days and ${SIGNAL_RULES.minCountPerWindow} per window are needed to state a change.`,
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
        ...base,
        recent,
        previous,
        ratio,
        interval,
        evidenceIds,
        status,
        statement: `${def.label} for ${app.appId}: ${a} in ${rFrom}..${rTo} vs ${b} in ${pFrom}..${pTo} (daily rate ${pct(ratio)}, 95% interval ${pct(interval[0])} to ${pct(interval[1])}): ${status === 'no_clear_change' ? 'no clear change' : `an observed ${status}`}. This is a reported change, not a measured effect of any action.`,
      });
    }
    // Quality co-occurrence: crash/ANR rates rising while acquisitions fall (stated as co-occurring only).
    const acq = signals.find((s) => s.appRowId === app.id && s.status === 'decrease');
    if (acq && last?.day) {
      const qKeys = platform === 'android' ? ['play.vitals.crash_rate', 'play.vitals.anr_rate', 'play.daily_crashes'] : ['asc.crashes'];
      const q = (await dailyTotals(t, [app.id], qKeys, acq.previous!.from, acq.recent!.to)).filter((x) => x.value !== null);
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

import { appInstalls, brandApps, brands, campaignLinks, type DbOrTx, storeAccounts, storeApps, storeReportCoverage, storeReportFiles, storeSyncRuns } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accountView, appView } from './accounts.js';
import { HEADLINE_METRICS, METRIC_DEFINITIONS, type StorePlatform } from './definitions.js';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Brand links store the Play package, or for iOS the numeric Apple ID taken from the listing URL. */
const BRAND_APP_JOIN = and(eq(brandApps.platform, storeApps.platform), or(eq(brandApps.appId, storeApps.appId), and(eq(storeApps.platform, 'ios'), eq(brandApps.appId, storeApps.storeAppId))));
const DAY = 86_400_000;

export const IntelligenceQuerySchema = z
  .object({
    from: Day,
    /** Inclusive. */
    to: Day,
    granularity: z.enum(['day', 'week', 'month']).default('day'),
    platform: z.enum(['android', 'ios']).optional(),
    accountId: z.string().uuid().optional(),
    brandId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const span = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / DAY;
    if (!(span >= 0)) ctx.addIssue({ code: 'custom', message: 'to must not be before from' });
    if (span > 731) ctx.addIssue({ code: 'custom', message: 'the range is limited to two years' });
  });
export type IntelligenceQuery = z.infer<typeof IntelligenceQuerySchema>;

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Which report dimension represents an app total for a day (an overview file wins over summed rows). */
const TOTAL_RANK = sql.raw(`case dimension when 'overview' then 0 when 'standard' then 0 when 'crash_rate' then 0 when 'anr_rate' then 0 when 'country' then 1 when 'app_version' then 2 else 9 end`);
const BASIS: Record<number, string> = { 0: 'reported_total', 1: 'sum_of_country_rows', 2: 'sum_of_app_version_rows', 9: 'sum_of_rows' };

export interface DailyTotal {
  appRowId: string;
  metricKey: string;
  day: string;
  value: number | null;
  basis: string;
  /** The one report partition (family, dimension, day) the value comes from. */
  family: string;
  dimension: string;
  /** `provisional` while the provider may still restate the day. */
  partitionStatus: string;
  revision: number;
  /** Evidence of the partition's current (winning) report version, and that evidence's status. */
  evidenceId: string | null;
  evidenceStatus: string | null;
}

/**
 * App-level daily totals of the given metrics. A day's total comes from exactly one report
 * partition: the best-ranked dimension (a reported total before country or version rows), so two
 * breakdowns of the same day are never added together. It is unknown (null) when any contributing
 * row is unknown; ratios and averages are only taken from single-row (reported total) sources,
 * never re-derived from breakdown rows.
 */
export async function dailyTotals(t: DbOrTx, appRowIds: string[], metricKeys: string[], from: string, to: string): Promise<DailyTotal[]> {
  if (!appRowIds.length || !metricKeys.length) return [];
  const r = await t.execute<{ app: string; metric: string; day: string; total: number | null; has_null: boolean; n: number; rank: number; family: string; dimension: string; partition_status: string; revision: number; evidence_id: string | null; evidence_status: string | null }>(sql`
    with ranked as (
      select store_app_id, metric_key, observation_date, partition_id, family, dimension, value, ${TOTAL_RANK} as rank
      from store_metric_observations
      where store_app_id in (${sql.join(
        appRowIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        and metric_key in (${sql.join(
          metricKeys.map((k) => sql`${k}`),
          sql`, `,
        )})
        and observation_date between ${from}::date and ${to}::date
    ), best as (
      select distinct on (store_app_id, metric_key, observation_date) store_app_id, metric_key, observation_date, partition_id, rank
      from ranked
      order by store_app_id, metric_key, observation_date, rank, dimension, family
    )
    select b.store_app_id::text as app, b.metric_key as metric, b.observation_date::text as day,
      sum(r.value) as total, bool_or(r.value is null) as has_null, count(*)::int as n, b.rank,
      p.family, p.dimension, p.status as partition_status, p.revision, f.evidence_id::text as evidence_id, e.status as evidence_status
    from best b
    join ranked r on r.partition_id = b.partition_id and r.metric_key = b.metric_key
    join store_report_partitions p on p.id = b.partition_id
    join store_report_files f on f.id = p.report_file_id
    left join evidence_records e on e.id = f.evidence_id
    group by b.store_app_id, b.metric_key, b.observation_date, b.rank, b.partition_id, p.family, p.dimension, p.status, p.revision, f.evidence_id, e.status
    order by 3`);
  return r.rows.flatMap((x) => {
    const def = METRIC_DEFINITIONS[x.metric];
    const additive = def && (def.aggregation === 'sum' || def.aggregation === 'daily_unique' || def.aggregation === 'snapshot');
    if (!additive && x.n !== 1) return [];
    return [
      {
        appRowId: x.app,
        metricKey: x.metric,
        day: x.day,
        value: x.has_null || x.total === null ? null : Number(x.total),
        basis: BASIS[x.rank] ?? 'sum_of_rows',
        family: x.family,
        dimension: x.dimension,
        partitionStatus: x.partition_status,
        revision: Number(x.revision),
        evidenceId: x.evidence_id,
        evidenceStatus: x.evidence_status,
      },
    ];
  });
}

/**
 * A value that may feed KPI series, trends and goal measurement: known, from a final (complete)
 * partition, and backed by admitted evidence of the partition's current report version.
 */
export const isUsableTotal = (x: DailyTotal): boolean => x.value !== null && x.partitionStatus === 'complete' && x.evidenceId !== null && x.evidenceStatus === 'admitted';

/** Range value for one metric from daily totals, following its aggregation semantics. */
export function rangeValue(metricKey: string, totals: DailyTotal[], expectedDays: number) {
  const def = METRIC_DEFINITIONS[metricKey];
  const known = totals.filter((x) => x.value !== null).sort((a, b) => a.day.localeCompare(b.day));
  const base = { daysWithData: known.length, expectedDays, complete: known.length === expectedDays, through: known.at(-1)?.day ?? null, basis: [...new Set(totals.map((x) => x.basis))] };
  if (!def || !known.length) return { ...base, value: null as number | null };
  if (def.aggregation === 'snapshot') return { ...base, value: known.at(-1)!.value, complete: true };
  if (def.aggregation === 'ratio' || def.aggregation === 'mean') return { ...base, value: expectedDays === 1 ? known[0]!.value : null };
  return { ...base, value: known.reduce((s, x) => s + (x.value ?? 0), 0) };
}

async function scopedApps(t: DbOrTx, q: { platform?: StorePlatform; accountId?: string; brandId?: string }) {
  const rows = await t
    .select({ app: storeApps, account: storeAccounts, brandId: brandApps.brandId, brandName: brands.name })
    .from(storeApps)
    .innerJoin(storeAccounts, eq(storeAccounts.id, storeApps.storeAccountId))
    .leftJoin(brandApps, BRAND_APP_JOIN)
    .leftJoin(brands, eq(brands.id, brandApps.brandId))
    .where(and(eq(storeApps.status, 'confirmed'), q.platform ? eq(storeApps.platform, q.platform) : undefined, q.accountId ? eq(storeApps.storeAccountId, q.accountId) : undefined, q.brandId ? eq(brandApps.brandId, q.brandId) : undefined))
    .orderBy(storeApps.platform, storeApps.appId);
  return rows;
}

async function latestCoverage(t: DbOrTx, appRowIds: string[], fromMonth: string, toMonth: string) {
  if (!appRowIds.length) return [];
  return t
    .select()
    .from(storeReportCoverage)
    .where(and(inArray(storeReportCoverage.storeAppId, appRowIds), gte(storeReportCoverage.period, fromMonth), lte(storeReportCoverage.period, toMonth)))
    .orderBy(storeReportCoverage.period);
}

const STATUS_ORDER = ['permission_denied', 'pending', 'not_yet_published', 'partial', 'unavailable', 'revised', 'complete'] as const;
function summarizeCoverage(rows: (typeof storeReportCoverage.$inferSelect)[]) {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const worst = STATUS_ORDER.find((s) => byStatus[s]) ?? null;
  return { worst, byStatus };
}

/** All Apps overview: per-app headline metrics with freshness and coverage; per-platform totals of like metrics only. */
export async function appIntelligenceOverview(t: DbOrTx, raw: unknown, now: Date) {
  const q = IntelligenceQuerySchema.parse(raw);
  const span = days(q.from, q.to);
  const prevTo = shift(q.from, -1);
  const prevFrom = shift(q.from, -span);
  const apps = await scopedApps(t, q);
  const ids = apps.map((a) => a.app.id);
  const keys = [...new Set(Object.values(HEADLINE_METRICS).flatMap((h) => [...h.acquisition, ...h.installs, ...h.quality]))];
  const [cur, prev, coverage, lastFiles] = await Promise.all([
    dailyTotals(t, ids, keys, q.from, q.to),
    dailyTotals(t, ids, keys, prevFrom, prevTo),
    latestCoverage(t, ids, q.from.slice(0, 7), q.to.slice(0, 7)),
    ids.length
      ? t
          .select({ app: storeReportFiles.storeAppId, last: sql<string>`max(${storeReportFiles.importedAt})::text` })
          .from(storeReportFiles)
          .where(inArray(storeReportFiles.storeAppId, ids))
          .groupBy(storeReportFiles.storeAppId)
      : Promise.resolve([]),
  ]);
  const out = apps.map(({ app, account, brandId, brandName }) => {
    const h = HEADLINE_METRICS[app.platform as StorePlatform];
    const metricKeys = [...h.acquisition, ...h.installs, ...h.quality];
    const metrics = Object.fromEntries(
      metricKeys.map((k) => {
        const v = rangeValue(
          k,
          cur.filter((x) => x.appRowId === app.id && x.metricKey === k),
          span,
        );
        const p = rangeValue(
          k,
          prev.filter((x) => x.appRowId === app.id && x.metricKey === k),
          span,
        );
        return [k, { ...v, previous: p.complete ? p.value : null, label: METRIC_DEFINITIONS[k]?.label ?? k, unit: METRIC_DEFINITIONS[k]?.unit ?? 'count', aggregation: METRIC_DEFINITIONS[k]?.aggregation ?? 'sum' }];
      }),
    );
    const cov = coverage.filter((c) => c.storeAppId === app.id);
    const latestDay =
      cur
        .filter((x) => x.appRowId === app.id && x.value !== null)
        .map((x) => x.day)
        .sort()
        .at(-1) ?? null;
    return {
      id: app.id,
      platform: app.platform,
      appId: app.appId,
      displayName: app.displayName,
      brand: brandId ? { id: brandId, name: brandName } : null,
      account: { id: account.id, displayName: account.displayName, provider: account.provider, health: account.healthStatus, lastSuccessAt: account.lastSuccessAt?.toISOString() ?? null, nextSyncAt: account.nextSyncAt?.toISOString() ?? null },
      freshness: { latestDay, lastImportAt: lastFiles.find((f) => f.app === app.id)?.last ?? null, staleDays: latestDay ? Math.floor((now.getTime() - Date.parse(`${latestDay}T00:00:00Z`)) / DAY) : null },
      coverage: summarizeCoverage(cov),
      metrics,
    };
  });
  // Totals add the same metric across apps of one platform, only when every app's range is complete.
  const totals: Record<string, Record<string, { value: number | null; apps: number; appsComplete: number; label: string }>> = {};
  for (const platform of ['android', 'ios'] as const) {
    const group = out.filter((a) => a.platform === platform);
    if (!group.length) continue;
    totals[platform] = {};
    for (const k of [...HEADLINE_METRICS[platform].acquisition, ...HEADLINE_METRICS[platform].installs]) {
      const def = METRIC_DEFINITIONS[k];
      if (!def || (def.aggregation !== 'sum' && def.aggregation !== 'daily_unique')) continue;
      const vals = group.map((a) => (a.metrics as Record<string, { value: number | null; complete: boolean }>)[k]!);
      const complete = vals.filter((v) => v.complete && v.value !== null);
      totals[platform]![k] = { value: complete.length === group.length ? complete.reduce((s, v) => s + v.value!, 0) : null, apps: group.length, appsComplete: complete.length, label: def.label };
    }
  }
  return {
    range: { from: q.from, to: q.to, days: span, previous: { from: prevFrom, to: prevTo } },
    apps: out,
    totals,
    notes: [
      'Values are official aggregate store reports (Layer 1). Google posts Play statistics within 3 to 7 days, so the latest days are often not available yet; they are shown as missing, never as zero.',
      'Android and iOS metrics have different definitions and populations and are never added together. Platform totals only add the same metric across apps, and only when every app has the full range.',
      'Store listing visitors are daily unique counts: a range total is the sum of daily values, not unique people.',
      'Reported changes are observations, not causal effects of any post or campaign.',
    ],
  };
}

/** Per-app detail: trends by granularity, breakdowns, campaigns, quality, coverage, files and the optional telemetry layer. */
export async function appIntelligenceDetail(t: DbOrTx, appRowId: string, raw: unknown, now: Date) {
  const q = IntelligenceQuerySchema.parse(raw);
  const [row] = await scopedAppsById(t, appRowId);
  if (!row) throw notFound('store app');
  const { app, account } = row;
  const platform = app.platform as StorePlatform;
  const allKeys = Object.entries(METRIC_DEFINITIONS)
    .filter(([, d]) => (platform === 'android' ? d.provider === 'google_play' : d.provider === 'app_store_connect'))
    .map(([k]) => k);
  const totals = await dailyTotals(t, [app.id], allKeys, q.from, q.to);
  const series = Object.fromEntries(
    allKeys
      .map(
        (k) =>
          [
            k,
            bucketSeries(
              k,
              totals.filter((x) => x.metricKey === k),
              q.from,
              q.to,
              q.granularity,
            ),
          ] as const,
      )
      .filter(([, s]) => s.some((b) => b.daysWithData > 0)),
  );
  const breakdown = async (dimension: string, field: string, keys: string[]) => {
    const r = await t.execute<{ value_key: string | null; metric: string; total: number | null; has_null: boolean; days: number }>(sql`
      select dims ->> ${field} as value_key, metric_key as metric, sum(value) as total, bool_or(value is null) as has_null, count(distinct observation_date)::int as days
      from store_metric_observations
      where store_app_id = ${app.id}::uuid and dimension = ${dimension} and metric_key in (${sql.join(
        keys.map((k) => sql`${k}`),
        sql`, `,
      )})
        and observation_date between ${q.from}::date and ${q.to}::date
      group by 1, 2`);
    const map = new Map<string, Record<string, number | null>>();
    for (const x of r.rows) {
      const k = x.value_key ?? '';
      const m = map.get(k) ?? {};
      m[x.metric] = x.has_null ? null : x.total === null ? null : Number(x.total);
      map.set(k, m);
    }
    return [...map.entries()].map(([value, metrics]) => ({ value: value || '(not reported)', metrics })).sort((a, b) => (Object.values(b.metrics)[0] ?? -1) - (Object.values(a.metrics)[0] ?? -1));
  };
  const androidKeys = ['play.store_listing_acquisitions', 'play.store_listing_visitors'];
  const iosKeys = ['asc.first_time_downloads', 'asc.page_views', 'asc.installations'];
  const countries = platform === 'android' ? await breakdown('country', 'country', androidKeys) : await breakdown('standard', 'territory', iosKeys);
  const sources = platform === 'android' ? await breakdown('traffic_source', 'traffic_source', androidKeys) : await breakdown('standard', 'source_type', iosKeys);
  const versions = platform === 'android' ? await breakdown('app_version', 'app_version', ['play.daily_crashes', 'play.daily_anrs', 'play.daily_device_installs']) : await breakdown('standard', 'app_version', ['asc.crashes']);
  const campaigns = platform === 'android' ? await reportedCampaigns(t, app.appId, q.from, q.to) : null;
  const [coverage, files, runs, telemetry] = await Promise.all([
    t
      .select()
      .from(storeReportCoverage)
      .where(and(eq(storeReportCoverage.storeAppId, app.id), gte(storeReportCoverage.period, q.from.slice(0, 7)), lte(storeReportCoverage.period, q.to.slice(0, 7))))
      .orderBy(storeReportCoverage.family, storeReportCoverage.period),
    t
      .select({
        id: storeReportFiles.id,
        family: storeReportFiles.family,
        dimension: storeReportFiles.dimension,
        period: storeReportFiles.period,
        status: storeReportFiles.status,
        rowsTotal: storeReportFiles.rowsTotal,
        rowsRejected: storeReportFiles.rowsRejected,
        partitionsRevised: storeReportFiles.partitionsRevised,
        unmappedColumns: storeReportFiles.unmappedColumns,
        error: storeReportFiles.error,
        sourceUpdatedAt: storeReportFiles.sourceUpdatedAt,
        importedAt: storeReportFiles.importedAt,
        evidenceId: storeReportFiles.evidenceId,
      })
      .from(storeReportFiles)
      .where(eq(storeReportFiles.storeAppId, app.id))
      .orderBy(desc(storeReportFiles.importedAt))
      .limit(30),
    t.select().from(storeSyncRuns).where(eq(storeSyncRuns.storeAccountId, account.id)).orderBy(desc(storeSyncRuns.startedAt)).limit(5),
    telemetryLayer(t, platform, app.appId, q.from, q.to),
  ]);
  return {
    app: { id: app.id, platform, appId: app.appId, storeAppId: app.storeAppId, displayName: app.displayName, brand: row.brandId ? { id: row.brandId, name: row.brandName } : null },
    account: {
      id: account.id,
      displayName: account.displayName,
      provider: account.provider,
      health: account.healthStatus,
      healthDetail: account.healthDetail,
      lastSuccessAt: account.lastSuccessAt?.toISOString() ?? null,
      nextSyncAt: account.nextSyncAt?.toISOString() ?? null,
      syncing: Boolean(account.leaseUntil && account.leaseUntil > now),
    },
    range: { from: q.from, to: q.to, granularity: q.granularity },
    series,
    breakdowns: { countries, sources, versions },
    campaigns,
    coverage: coverage.map((c) => ({ family: c.family, dimension: c.dimension, period: c.period, status: c.status, detail: c.detail, checkedAt: c.checkedAt.toISOString() })),
    files: files.map((f) => ({ ...f, sourceUpdatedAt: f.sourceUpdatedAt?.toISOString() ?? null, importedAt: f.importedAt.toISOString() })),
    runs: runs.map((r) => ({ mode: r.mode, status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, stats: r.stats, error: r.error })),
    telemetry,
    definitions: Object.fromEntries(Object.keys(series).map((k) => [k, METRIC_DEFINITIONS[k]])),
    notes:
      platform === 'android'
        ? [
            'Google Play reports campaigns by UTM source and UTM campaign only; utm_content is not a report dimension, so a campaign shared by several posts cannot be split per post here.',
            'Store listing acquisitions are provider-reported attribution of installs to a traffic source or campaign; they do not prove that a post caused them. Values under Google’s thresholds appear as "Other".',
            'Play does not document the time zone of statistics days; vitals use America/Los_Angeles days.',
          ]
        : [
            'Standard Analytics Reports are used: they carry no campaign token (only Detailed reports do) and installation, session and crash counts include only users who share data with developers.',
            'A newer Apple report instance replaces older data for the same day; recent days stay provisional until Apple’s completeness window (2 to 5 days) passes.',
          ],
  };
}

async function scopedAppsById(t: DbOrTx, appRowId: string) {
  if (!z.string().uuid().safeParse(appRowId).success) throw invalid('invalid app id');
  return t
    .select({ app: storeApps, account: storeAccounts, brandId: brandApps.brandId, brandName: brands.name })
    .from(storeApps)
    .innerJoin(storeAccounts, eq(storeAccounts.id, storeApps.storeAccountId))
    .leftJoin(brandApps, BRAND_APP_JOIN)
    .leftJoin(brands, eq(brands.id, brandApps.brandId))
    .where(eq(storeApps.id, appRowId));
}

const weekStart = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return shift(day, -((d.getUTCDay() + 6) % 7));
};
const bucketOf = (day: string, g: 'day' | 'week' | 'month') => (g === 'day' ? day : g === 'week' ? weekStart(day) : `${day.slice(0, 7)}-01`);

/** Buckets daily totals; incomplete buckets are flagged and ratios exist only per day. */
export function bucketSeries(metricKey: string, totals: DailyTotal[], from: string, to: string, g: 'day' | 'week' | 'month') {
  const def = METRIC_DEFINITIONS[metricKey];
  const buckets = new Map<string, { expected: number; vals: DailyTotal[] }>();
  for (let d = from; d <= to; d = shift(d, 1)) {
    const b = bucketOf(d, g);
    const cur = buckets.get(b) ?? { expected: 0, vals: [] };
    cur.expected++;
    buckets.set(b, cur);
  }
  for (const x of totals) buckets.get(bucketOf(x.day, g))?.vals.push(x);
  return [...buckets.entries()].map(([bucket, { expected, vals }]) => {
    const known = vals.filter((v) => v.value !== null).sort((a, b) => a.day.localeCompare(b.day));
    let value: number | null = null;
    if (known.length && def) {
      if (def.aggregation === 'snapshot') value = known.at(-1)!.value;
      else if (def.aggregation === 'ratio' || def.aggregation === 'mean') value = g === 'day' ? known[0]!.value : null;
      else value = known.reduce((s, v) => s + (v.value ?? 0), 0);
    }
    return { bucket, value, daysWithData: known.length, expectedDays: expected, complete: known.length === expected };
  });
}

/**
 * Play traffic-source rows with a UTM campaign, mapped through the campaign registry: `post` when
 * the campaign was registered as unique to one post, `program` when it is shared by several posts
 * of one program (Play cannot split it), `unregistered` otherwise.
 */
export async function reportedCampaigns(t: DbOrTx, appId: string, from: string, to: string) {
  const r = await t.execute<{ utm_source: string | null; utm_campaign: string; acquisitions: number | null; visitors: number | null; days: number; nulls: boolean }>(sql`
    select dims ->> 'utm_source' as utm_source, dims ->> 'utm_campaign' as utm_campaign,
      sum(value) filter (where metric_key = 'play.store_listing_acquisitions') as acquisitions,
      sum(value) filter (where metric_key = 'play.store_listing_visitors') as visitors,
      count(distinct observation_date)::int as days,
      bool_or(value is null and metric_key in ('play.store_listing_acquisitions', 'play.store_listing_visitors')) as nulls
    from store_metric_observations
    where platform = 'android' and app_id = ${appId} and family = 'play.store_performance' and dimension = 'traffic_source'
      and coalesce(dims ->> 'utm_campaign', '') not in ('', 'Other', '(not set)')
      and observation_date between ${from}::date and ${to}::date
    group by 1, 2 order by 3 desc nulls last`);
  const names = [...new Set(r.rows.map((x) => x.utm_campaign))];
  const links = names.length
    ? await t
        .select()
        .from(campaignLinks)
        .where(and(eq(campaignLinks.appPlatform, 'android'), eq(campaignLinks.appId, appId), inArray(campaignLinks.campaign, names)))
    : [];
  const [owner] = await t
    .select({ brandId: brandApps.brandId })
    .from(brandApps)
    .where(and(eq(brandApps.platform, 'android'), eq(brandApps.appId, appId)));
  return {
    rows: r.rows.map((x) => {
      const mine = links.filter((l) => l.campaign === x.utm_campaign);
      const unique = mine.find((l) => l.reportScope === 'campaign');
      const programs = [...new Set(mine.map((l) => l.programId))];
      const brandOk = mine.every((l) => l.brandId === owner?.brandId);
      const identity = !mine.length
        ? { status: 'unregistered' as const }
        : !brandOk
          ? { status: 'brand_mismatch' as const }
          : unique
            ? { status: 'post' as const, brandId: unique.brandId, programId: unique.programId, planItemId: unique.planItemId, postId: unique.postId, channelPlatform: unique.channelPlatform }
            : { status: 'program' as const, brandId: mine[0]!.brandId, programId: programs.length === 1 ? programs[0] : null, posts: mine.length };
      return { utmSource: x.utm_source, utmCampaign: x.utm_campaign, acquisitions: x.nulls ? null : x.acquisitions === null ? null : Number(x.acquisitions), visitors: x.nulls ? null : x.visitors === null ? null : Number(x.visitors), days: x.days, identity };
    }),
    basis: 'provider_reported_attribution',
    note: 'Google attributes store listing acquisitions to the UTM campaign of the visit. This is attribution reported by Google, not proof that a post caused installs. Small values may be grouped as "Other".',
  };
}

/** Layer 2: consented backend telemetry (M19), shown beside store reports and never added to them. */
async function telemetryLayer(t: DbOrTx, platform: StorePlatform, appId: string, from: string, to: string) {
  const r = await t
    .select({ day: sql<string>`to_char(${appInstalls.installedAt} at time zone 'UTC', 'YYYY-MM-DD')`, n: sql<number>`count(*)::int` })
    .from(appInstalls)
    .where(and(eq(appInstalls.platform, platform), eq(appInstalls.appId, appId), gte(appInstalls.installedAt, new Date(`${from}T00:00:00Z`)), lte(appInstalls.installedAt, new Date(`${to}T23:59:59.999Z`))))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return {
    available: r.length > 0,
    installsByDay: r.map((x) => ({ day: x.day, installs: x.n })),
    note: 'Optional app-side telemetry sent by the app backend (consented installs, UTC days). A different population from store reports; not added to store counts. Empty means no telemetry was received, not zero installs.',
  };
}

/** Accounts with their apps and last run, for the Developer accounts & apps screen. */
export async function developerAccountsOverview(t: DbOrTx) {
  const accounts = await t.select().from(storeAccounts).orderBy(storeAccounts.createdAt);
  const apps = await t.select({ app: storeApps, brandId: brandApps.brandId, brandName: brands.name }).from(storeApps).leftJoin(brandApps, BRAND_APP_JOIN).leftJoin(brands, eq(brands.id, brandApps.brandId)).orderBy(storeApps.appId);
  const runs = accounts.length
    ? await t.execute<{ store_account_id: string; mode: string; status: string; started_at: string; finished_at: string | null; stats: Record<string, unknown>; error: Record<string, unknown> | null }>(sql`
        select distinct on (store_account_id) store_account_id::text, mode, status, started_at::text, finished_at::text, stats, error
        from store_sync_runs order by store_account_id, started_at desc`)
    : { rows: [] };
  return {
    accounts: accounts.map((a) => ({ ...accountView(a), lastRun: runs.rows.find((r) => r.store_account_id === a.id) ?? null })),
    apps: apps.map((x) => ({ ...appView(x.app), brand: x.brandId ? { id: x.brandId, name: x.brandName } : null })),
  };
}

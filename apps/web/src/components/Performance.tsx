import { useMemo, useState } from 'react';
import { type ChartPoint, coverage, dailyFromPoints, formatCompact, isoDay, pctChange } from '../lib/chart.js';
import { formatDay } from '../lib/format.js';
import { LineChart } from './Chart.js';
import { Ico } from './Icons.js';
import { ErrorNotice, LoadingRows, useApi } from './ui.js';

/* ------------------------------------------------------------------ */
/* Store report shapes (GET /v1/app-intelligence/overview, /apps/:id)  */
/* ------------------------------------------------------------------ */

export interface RangeValue {
  value: number | null;
  previous: number | null;
  daysWithData: number;
  expectedDays: number;
  complete: boolean;
  through: string | null;
  label: string;
  unit: string;
}
export interface OverviewApp {
  id: string;
  platform: 'android' | 'ios';
  appId: string;
  displayName: string | null;
  brand: { id: string; name: string | null } | null;
  freshness: { latestDay: string | null; staleDays: number | null };
  coverage: { worst: string | null; byStatus: Record<string, number> };
  metrics: Record<string, RangeValue>;
}
export interface Overview {
  range: { from: string; to: string; days: number; window?: 'calendar' | 'reported'; reportedThrough?: string | null; unpublishedDaysExcluded?: number };
  apps: OverviewApp[];
  totals: Record<string, Record<string, { value: number | null; apps: number; appsComplete: number; label: string; incomplete?: { appId: string; name: string; daysWithData: number; expectedDays: number }[] }>>;
  notes: string[];
}
interface Bucket {
  bucket: string;
  value: number | null;
  daysWithData: number;
  expectedDays: number;
  complete: boolean;
}
interface AppDetailLite {
  series: Record<string, Bucket[]>;
  definitions: Record<string, { label: string; definition: string }>;
}
interface SeriesRow {
  id: string;
  key: string;
  name: string;
  unit: string;
  granularity: string;
}

/** Report presets: "reported" windows end on the latest day every app has reported (D-047). */
export const PERIODS = [
  { key: 'r7', days: 7, label: 'Last 7 reported days' },
  { key: 'r28', days: 28, label: 'Last 28 reported days' },
  { key: 'r90', days: 90, label: 'Last 90 reported days' },
] as const;
export type PeriodKey = (typeof PERIODS)[number]['key'];

export const HEADLINE: Record<'android' | 'ios', string[]> = {
  android: ['play.daily_user_installs', 'play.store_listing_acquisitions', 'play.store_listing_visitors', 'play.daily_user_uninstalls', 'play.daily_crashes'],
  ios: ['asc.first_time_downloads', 'asc.installations', 'asc.page_views', 'asc.deletions', 'asc.crashes'],
};

export function requestedRange(days: number) {
  const to = new Date(Date.now() - 86_400_000);
  return { from: isoDay(new Date(to.getTime() - (days - 1) * 86_400_000)), to: isoDay(to) };
}

/** The store overview for a reported window of `days`. */
export function useStoreOverview(days: number) {
  const r = useMemo(() => requestedRange(days), [days]);
  return useApi<Overview>(`/v1/app-intelligence/overview?${new URLSearchParams({ ...r, window: 'reported' })}`);
}

export function PeriodSelect({ value, onChange, id = 'period' }: { value: PeriodKey; onChange: (k: PeriodKey) => void; id?: string }) {
  return (
    <div className="period-select">
      <Ico name="calendar" size={17} />
      <label htmlFor={id} className="sr-only">
        Period
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as PeriodKey)}>
        {PERIODS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      <Ico name="sort" size={15} className="period-chev" />
    </div>
  );
}

/** "Oct 6 – Nov 2, 2026", the dates the figures really cover. */
export function rangeText(o: Overview | null): string | null {
  if (!o) return null;
  if (!o.range.reportedThrough && !o.apps.length) return null;
  return `${formatDay(o.range.from).replace(/, \d{4}$/, '')} – ${formatDay(o.range.to)}`;
}

/* ------------------------------------------------------------------ */
/* Performance chart panel                                             */
/* ------------------------------------------------------------------ */

type Choice = { id: string; kind: 'app'; app: OverviewApp; metric: string; label: string; unit: string } | { id: string; kind: 'series'; series: SeriesRow; label: string; unit: string };

function choicesFor(o: Overview | null, series: SeriesRow[] | null): Choice[] {
  const out: Choice[] = [];
  for (const a of o?.apps ?? []) {
    for (const k of HEADLINE[a.platform]) {
      const m = a.metrics[k];
      if (m) out.push({ id: `app:${a.id}:${k}`, kind: 'app', app: a, metric: k, label: m.label, unit: m.unit });
    }
  }
  for (const s of series ?? []) if (s.granularity === 'day') out.push({ id: `series:${s.id}`, kind: 'series', series: s, label: s.name, unit: s.unit });
  return out;
}

export function ChangeChip({ pct, label = 'vs the previous period' }: { pct: number | null; label?: string }) {
  if (pct === null) return null;
  const up = pct > 0.5;
  const down = pct < -0.5;
  return (
    <span className={`chip-change ${up ? 'up' : down ? 'down' : 'flat'}`} title={label}>
      <span aria-hidden="true">{up ? '↑' : down ? '↓' : '='}</span> {`${up ? '+' : ''}${Math.round(pct)}%`}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/**
 * The reference "Performance" card: one KPI over the reported window, from store reports or a
 * daily KPI series. Totals and changes are only stated when the period (and the previous one)
 * is complete; missing days are gaps.
 */
export function PerformancePanel({ overview, days, initialApp, initialMetric, heading = 'Performance', variant = 'card' }: { overview: { data: Overview | null; error: unknown }; days: number; initialApp?: string | null; initialMetric?: string | null; heading?: string; variant?: 'card' | 'wide' }) {
  const series = useApi<SeriesRow[]>('/v1/analytics/series');
  const o = overview.data;
  const choices = useMemo(() => choicesFor(o, series.data), [o, series.data]);
  const apps = o?.apps ?? [];
  const defaultApp = apps.find((a) => a.id === initialApp) ?? [...apps].sort((a, b) => (installsOf(b) ?? -1) - (installsOf(a) ?? -1))[0];
  const [appId, setAppId] = useState<string | null>(null);
  const [metric, setMetric] = useState<string | null>(initialMetric ?? null);
  const app = apps.find((a) => a.id === appId) ?? defaultApp;
  const appChoices = choices.filter((c): c is Extract<Choice, { kind: 'app' }> => c.kind === 'app' && c.app.id === app?.id);
  const seriesChoices = choices.filter((c) => c.kind === 'series');
  const chosen = choices.find((c) => c.id === metric) ?? appChoices.find((c) => c.metric === metric) ?? appChoices[0] ?? seriesChoices[0];

  const range = o ? { from: o.range.from, to: o.range.to } : requestedRange(days);
  const detail = useApi<AppDetailLite>(chosen?.kind === 'app' ? `/v1/app-intelligence/apps/${chosen.app.id}?${new URLSearchParams({ ...range, granularity: 'day' })}` : null);
  const points = useApi<{ ts: string; value: number }[]>(chosen?.kind === 'series' ? `/v1/analytics/series/${chosen.series.id}/points` : null);

  const chart: ChartPoint[] | null = useMemo(() => {
    if (!chosen) return null;
    if (chosen.kind === 'app') {
      const b = detail.data?.series[chosen.metric];
      if (!detail.data) return null;
      return (b ?? []).map((x) => ({ x: x.bucket, value: x.value, partial: !x.complete && x.value !== null }));
    }
    if (!points.data) return null;
    return dailyFromPoints(points.data, range.from, range.to);
  }, [chosen, detail.data, points.data, range.from, range.to]);

  const loading = !o && !overview.error;
  const head = (
    <header className="card-head">
      <h2 className="card-title">
        <Ico name="chart" size={19} /> {heading}
        {chosen?.kind === 'app' ? <span className="card-scope">({chosen.app.displayName ?? chosen.app.appId})</span> : chosen ? <span className="card-scope">(KPI series)</span> : null}
      </h2>
      {chosen ? (
        <div className="card-tools">
          {apps.length > 1 ? (
            <label className="mini-select">
              <span className="sr-only">App</span>
              <select
                value={app?.id ?? ''}
                onChange={(e) => {
                  setAppId(e.target.value);
                  setMetric(null);
                }}
                aria-label="App"
              >
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ?? a.appId} ({a.platform === 'ios' ? 'iOS' : 'Android'})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="mini-select">
            <span className="sr-only">Metric</span>
            <select value={chosen.id} onChange={(e) => setMetric(e.target.value)} aria-label="Metric">
              {appChoices.length ? (
                <optgroup label={app?.displayName ?? 'App'}>
                  {appChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {shortMetric(c.label)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {seriesChoices.length ? (
                <optgroup label="KPI series">
                  {seriesChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
        </div>
      ) : null}
    </header>
  );

  if (overview.error) {
    return (
      <section className={`card perf ${variant}`} aria-label={heading}>
        {head}
        <ErrorNotice error={overview.error} />
      </section>
    );
  }
  if (loading || (series.loading && !choices.length)) {
    return (
      <section className={`card perf ${variant}`} aria-label={heading} aria-busy="true">
        {head}
        <LoadingRows label="Loading performance…" />
      </section>
    );
  }
  if (!chosen) {
    return (
      <section className={`card perf ${variant}`} aria-label={heading}>
        {head}
        <div className="empty-state">
          <strong>No performance data yet</strong>
          <span className="small muted">Installs and acquisitions arrive from official store reports once a Google Play or App Store Connect developer account is connected. Nothing is estimated.</span>
          <div className="row">
            <a className="btn primary" href="/app/apps?tab=accounts">
              Connect a developer account
            </a>
          </div>
        </div>
      </section>
    );
  }

  const m = chosen.kind === 'app' ? chosen.app.metrics[chosen.metric] : null;
  const cov = chart ? coverage(chart) : null;
  const value = m ? (m.complete ? m.value : null) : (cov?.total ?? null);
  const change = m?.complete ? pctChange(m.value, m.previous) : null;
  const daysWith = m ? m.daysWithData : (cov?.daysWithData ?? 0);
  const expected = m ? m.expectedDays : (cov?.expectedDays ?? 0);
  const through = m?.through ?? cov?.through ?? null;
  const source = chosen.kind === 'app' ? (chosen.app.platform === 'ios' ? 'App Store Connect Analytics Reports' : 'Google Play bulk reports') : `KPI series “${chosen.series.key}”`;

  return (
    <section className={`card perf ${variant}`} aria-label={heading}>
      {head}
      <div className="perf-figure">
        <span className="perf-value">{value === null ? '—' : formatCompact(value, chosen.unit)}</span>
        <ChangeChip pct={change} />
      </div>
      <p className="perf-sub">
        {chosen.label} · {o?.range.days ?? days} reported days
        {value === null && daysWith > 0 ? (
          <span className="perf-open">
            {' '}
            · total open: {daysWith} of {expected} days reported
          </span>
        ) : null}
        {m?.complete && change === null ? <span className="perf-open"> · no complete previous period to compare</span> : null}
      </p>
      {chart === null ? (
        detail.error || points.error ? (
          <ErrorNotice error={detail.error ?? points.error} />
        ) : (
          <LoadingRows label="Loading the chart…" />
        )
      ) : (
        <LineChart
          points={chart}
          label={chosen.label}
          unit={chosen.unit === 'ratio' ? 'ratio' : undefined}
          height={variant === 'wide' ? 240 : 170}
          caption={
            <>
              <span>Source: {source}</span>
              <span>{through ? `Data through ${formatDay(through)}` : 'No reported day yet'}</span>
              {cov && cov.daysWithData < cov.expectedDays ? <span>{cov.expectedDays - cov.daysWithData} day(s) not reported — shown as gaps, not zero</span> : null}
              {chart.some((p) => p.partial) ? <span>Hollow points: partial days</span> : null}
            </>
          }
        />
      )}
      {chosen.kind === 'app' ? (
        <a className="card-link" href={`/app/apps?app=${chosen.app.id}`}>
          Open the app report <Ico name="arrow-right" size={15} />
        </a>
      ) : (
        <a className="card-link" href="/app/analytics">
          Open Forecasts &amp; Analytics <Ico name="arrow-right" size={15} />
        </a>
      )}
    </section>
  );
}

const installsOf = (a: OverviewApp) => a.metrics['play.daily_user_installs']?.value ?? a.metrics['asc.first_time_downloads']?.value ?? null;
const shortMetric = (label: string) => label.replace(/^Daily /, '').replace(/^Store listing /, 'Store ');

/* ------------------------------------------------------------------ */
/* Growth summary tiles                                                */
/* ------------------------------------------------------------------ */

interface PostLite {
  id: string;
  status: string;
  verifiedAt: string | null;
  scheduledAt: string;
}

interface Tile {
  key: string;
  label: string;
  value: number | null;
  change: number | null;
  note: string;
  kind: 'reported' | 'counted' | 'unavailable';
}

/** Totals of like metrics only (Android installs are never added to iOS downloads). */
export function summaryTiles(o: Overview | null, posts: PostLite[] | null): Tile[] {
  const tiles: Tile[] = [];
  const add = (platform: 'android' | 'ios', key: string, label: string) => {
    const t = o?.totals[platform]?.[key];
    if (!t) return;
    const apps = (o?.apps ?? []).filter((a) => a.platform === platform && a.metrics[key]);
    const prevOk = apps.length > 0 && apps.every((a) => a.metrics[key]!.complete && a.metrics[key]!.previous !== null);
    const prev = prevOk ? apps.reduce((n, a) => n + (a.metrics[key]!.previous ?? 0), 0) : null;
    tiles.push({
      key: `${platform}-${key}`,
      label,
      value: t.value,
      change: t.value !== null ? pctChange(t.value, prev) : null,
      note: t.value === null ? (t.incomplete?.length ? `Open: ${t.incomplete.length} app${t.incomplete.length === 1 ? '' : 's'} missing days` : 'Not reported yet') : `${t.apps} app${t.apps === 1 ? '' : 's'} · reported`,
      kind: t.value === null ? 'unavailable' : 'reported',
    });
  };
  add('android', 'play.daily_user_installs', 'Installs (Android)');
  add('android', 'play.store_listing_acquisitions', 'Store acquisitions');
  add('android', 'play.store_listing_visitors', 'Store visitors');
  add('ios', 'asc.first_time_downloads', 'First-time downloads (iOS)');
  if (!tiles.length) tiles.push({ key: 'installs', label: 'Installs', value: null, change: null, note: 'Connect a developer account', kind: 'unavailable' });
  if (posts && o) {
    const from = Date.parse(`${o.range.from}T00:00:00Z`);
    const to = Date.parse(`${o.range.to}T00:00:00Z`) + 86_400_000;
    const n = posts.filter((p) => p.status === 'published_verified' && p.verifiedAt && Date.parse(p.verifiedAt) >= from && Date.parse(p.verifiedAt) < to).length;
    tiles.push({ key: 'posts', label: 'Published & verified posts', value: n, change: null, note: 'Counted · same dates', kind: 'counted' });
  }
  return tiles.slice(0, 5);
}

export function GrowthSummary({ overview, compact = false }: { overview: { data: Overview | null; error: unknown }; compact?: boolean }) {
  const posts = useApi<PostLite[]>('/v1/social/posts');
  const o = overview.data;
  const loading = !o && !overview.error;
  return (
    <section className={`card summary${compact ? ' compact' : ''}`} aria-label="Growth summary" aria-busy={loading}>
      <header className="card-head">
        <h2 className="card-title">
          <Ico name="autopilot" size={19} /> Growth summary <span className="card-scope">({o ? `last ${o.range.days} reported days` : 'reported days'})</span>
        </h2>
      </header>
      {overview.error ? <ErrorNotice error={overview.error} /> : null}
      {loading ? (
        <LoadingRows label="Loading the summary…" />
      ) : o ? (
        <div className="tiles">
          {summaryTiles(o, posts.data ?? (posts.error ? [] : null)).map((t) => (
            <div key={t.key} className={`tile ${t.kind}`}>
              <span className="tile-value">{t.value === null ? '—' : formatCompact(t.value)}</span>
              <span className="tile-label">{t.label}</span>
              {t.change !== null ? <ChangeChip pct={t.change} /> : <span className="tile-note">{t.note}</span>}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* A goal's KPI over time                                              */
/* ------------------------------------------------------------------ */

/** The goal's metric from store reports (the app that reports it) or a KPI series with the same key. */
export function GoalKpiChart({ metricKey, label, since }: { metricKey: string; label: string; since: string }) {
  const days = Math.min(90, Math.max(7, Math.ceil((Date.now() - Date.parse(since)) / 86_400_000) + 14));
  const overview = useStoreOverview(days);
  const series = useApi<SeriesRow[]>('/v1/analytics/series');
  const apps = (overview.data?.apps ?? []).filter((a) => a.metrics[metricKey]);
  const [appId, setAppId] = useState<string | null>(null);
  const app = apps.find((a) => a.id === appId) ?? apps[0];
  const kpi = (series.data ?? []).find((s) => s.key === metricKey);
  const range = overview.data ? { from: overview.data.range.from, to: overview.data.range.to } : null;
  const detail = useApi<AppDetailLite>(app && range ? `/v1/app-intelligence/apps/${app.id}?${new URLSearchParams({ ...range, granularity: 'day' })}` : null);
  const points = useApi<{ ts: string; value: number }[]>(!app && kpi ? `/v1/analytics/series/${kpi.id}/points` : null);
  if (overview.error && series.error) return <ErrorNotice error={overview.error} />;
  if (!overview.data || !series.data) return <LoadingRows label="Loading the KPI chart…" />;
  if (!app && !kpi) return <p className="small muted">No stored observations of “{label}” yet. The chart appears once reports or KPI points for this metric arrive; nothing is estimated in the meantime.</p>;
  const r = range!;
  const pts: ChartPoint[] | null = app ? (detail.data ? (detail.data.series[metricKey] ?? []).map((b) => ({ x: b.bucket, value: b.value, partial: !b.complete && b.value !== null })) : null) : points.data ? dailyFromPoints(points.data, r.from, r.to) : null;
  const startDay = since.slice(0, 10);
  return (
    <div className="stack">
      {apps.length > 1 ? (
        <label className="mini-select">
          App{' '}
          <select value={app?.id} onChange={(e) => setAppId(e.target.value)}>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName ?? a.appId}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {pts ? (
        <LineChart
          points={pts.map((p) => (p.x === startDay ? { ...p, note: 'Goal started' } : p))}
          label={label}
          height={210}
          caption={
            <>
              <span>Source: {app ? `${app.platform === 'ios' ? 'App Store Connect' : 'Google Play'} reports · ${app.displayName ?? app.appId}` : `KPI series “${kpi!.key}”`}</span>
              <span>
                {formatDay(r.from)} – {formatDay(r.to)}
              </span>
              <span>Goal started {formatDay(startDay)}</span>
            </>
          }
        />
      ) : (
        <LoadingRows label="Loading the KPI chart…" />
      )}
    </div>
  );
}

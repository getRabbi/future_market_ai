import { useMemo, useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, DataTable, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const APP_INTELLIGENCE_CALLS = [
  { method: 'GET', path: '/v1/app-intelligence/accounts' },
  { method: 'POST', path: '/v1/app-intelligence/accounts' },
  { method: 'PATCH', path: '/v1/app-intelligence/accounts/:id' },
  { method: 'POST', path: '/v1/app-intelligence/accounts/:id/key' },
  { method: 'POST', path: '/v1/app-intelligence/accounts/:id/sync' },
  { method: 'POST', path: '/v1/app-intelligence/accounts/:id/apps' },
  { method: 'POST', path: '/v1/app-intelligence/apps/:id/decision' },
  { method: 'POST', path: '/v1/app-intelligence/apps/:id/apple-analytics' },
  { method: 'GET', path: '/v1/app-intelligence/overview' },
  { method: 'GET', path: '/v1/app-intelligence/apps/:id' },
  { method: 'GET', path: '/v1/app-intelligence/signals' },
  { method: 'GET', path: '/v1/brands' },
  { method: 'POST', path: '/v1/brands/:id/apps' },
  { method: 'GET', path: '/v1/connections' },
] as const;

interface Account {
  id: string;
  provider: 'google_play' | 'app_store_connect';
  accountRef: string;
  displayName: string;
  status: string;
  health: string;
  healthDetail: Record<string, unknown>;
  lastSuccessAt: string | null;
  nextSyncAt: string | null;
  consecutiveFailures: number;
  backfillPending: boolean;
  syncing: boolean;
  lastRun: { mode: string; status: string; started_at: string; stats: { filesImported?: number; deferred?: number; notes?: string[] }; error: { message?: string } | null } | null;
}
interface StoreApp {
  id: string;
  storeAccountId: string;
  platform: 'android' | 'ios';
  appId: string;
  storeAppId: string | null;
  displayName: string | null;
  status: string;
  discoveredVia: string[];
  conflict: { reason?: string } | null;
  analytics: Record<string, { requestId: string }> | null;
  brand: { id: string; name: string | null } | null;
}
interface RangeValue {
  value: number | null;
  previous: number | null;
  daysWithData: number;
  expectedDays: number;
  complete: boolean;
  through: string | null;
  label: string;
  unit: string;
}
interface OverviewApp {
  id: string;
  platform: 'android' | 'ios';
  appId: string;
  displayName: string | null;
  brand: { id: string; name: string | null } | null;
  account: { id: string; displayName: string; health: string; lastSuccessAt: string | null; nextSyncAt: string | null };
  freshness: { latestDay: string | null; staleDays: number | null };
  coverage: { worst: string | null; byStatus: Record<string, number> };
  metrics: Record<string, RangeValue>;
}
interface Overview {
  range: { from: string; to: string; days: number };
  apps: OverviewApp[];
  totals: Record<string, Record<string, { value: number | null; apps: number; appsComplete: number; label: string }>>;
  notes: string[];
}
interface Bucket {
  bucket: string;
  value: number | null;
  daysWithData: number;
  expectedDays: number;
  complete: boolean;
}
interface Detail {
  app: { id: string; platform: string; appId: string; displayName: string | null };
  account: { displayName: string; health: string; lastSuccessAt: string | null; nextSyncAt: string | null; syncing: boolean };
  series: Record<string, Bucket[]>;
  breakdowns: Record<'countries' | 'sources' | 'versions', { value: string; metrics: Record<string, number | null> }[]>;
  campaigns: { rows: { utmSource: string | null; utmCampaign: string; acquisitions: number | null; visitors: number | null; identity: { status: string; postId?: string | null; posts?: number } }[]; note: string } | null;
  coverage: { family: string; dimension: string; period: string; status: string; detail: { reason?: string; through?: string | null } }[];
  files: { family: string; dimension: string; period: string; status: string; rowsRejected: number; unmappedColumns: string[]; importedAt: string }[];
  telemetry: { available: boolean; installsByDay: { day: string; installs: number }[]; note: string };
  definitions: Record<string, { label: string; definition: string; population: string; aggregation: string }>;
  notes: string[];
}
interface Signals {
  signals: { appId: string; platform: string; status: string; statement: string }[];
  qualityFlags: { appId: string; statement: string }[];
}

const PROVIDER = { google_play: 'Google Play', app_store_connect: 'App Store Connect' } as const;
const HEADLINE: Record<'android' | 'ios', string[]> = {
  android: ['play.store_listing_acquisitions', 'play.store_listing_visitors', 'play.daily_user_installs', 'play.daily_user_uninstalls', 'play.daily_crashes'],
  ios: ['asc.first_time_downloads', 'asc.page_views', 'asc.installations', 'asc.deletions', 'asc.crashes'],
};
const isAdmin = (me: Me) => ['owner', 'admin'].some((r) => me.roles?.includes(r));
const canSync = (me: Me) => ['owner', 'admin', 'growth_operator'].some((r) => me.roles?.includes(r));
const day = (d: Date) => d.toISOString().slice(0, 10);

/** null means "not reported" (never shown as 0); a real zero stays 0. */
function num(v: number | null | undefined, unit?: string): string {
  if (v === null || v === undefined) return '—';
  if (unit === 'ratio') return `${(v * 100).toFixed(2)}%`;
  if (unit === 'rating') return v.toFixed(2);
  return Math.round(v).toLocaleString('en-US');
}
function change(cur: number | null, prev: number | null): string {
  if (cur === null || prev === null || prev === 0) return '';
  const pct = ((cur - prev) / prev) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs previous period`;
}

export function AppIntelligenceView({ me }: { me: Me }) {
  const [tab, setTab] = useState<'apps' | 'accounts'>('apps');
  return (
    <>
      <nav className="ai-tabs" aria-label="App intelligence">
        <button type="button" className={`ai-tab${tab === 'apps' ? ' on' : ''}`} aria-pressed={tab === 'apps'} onClick={() => setTab('apps')}>
          All apps
        </button>
        <button type="button" className={`ai-tab${tab === 'accounts' ? ' on' : ''}`} aria-pressed={tab === 'accounts'} onClick={() => setTab('accounts')}>
          Developer accounts &amp; apps
        </button>
      </nav>
      {tab === 'apps' ? <AppsOverview /> : <DeveloperAccounts me={me} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* All apps                                                            */
/* ------------------------------------------------------------------ */

function AppsOverview() {
  const [preset, setPreset] = useState(28);
  const [platform, setPlatform] = useState('');
  const [accountId, setAccountId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const range = useMemo(() => {
    const to = new Date(Date.now() - 86_400_000);
    return { from: day(new Date(to.getTime() - (preset - 1) * 86_400_000)), to: day(to) };
  }, [preset]);
  const q = new URLSearchParams({ ...range, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), ...(brandId ? { brandId } : {}) });
  const overview = useApi<Overview>(`/v1/app-intelligence/overview?${q}`);
  const accounts = useApi<{ accounts: Account[] }>('/v1/app-intelligence/accounts');
  const brands = useApi<{ id: string; name: string }[]>('/v1/brands');
  const signals = useApi<Signals>('/v1/app-intelligence/signals');
  return (
    <>
      <section className="card">
        <h2>All apps</h2>
        <p className="small muted">Official store reports (Google Play bulk reports, App Store Analytics Reports). No app update or SDK is needed. A dash means not reported yet, not zero.</p>
        <div className="form-grid">
          <label>
            Period
            <select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={28}>Last 28 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 365 days</option>
            </select>
          </label>
          <label>
            Platform
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">Android and iOS</option>
              <option value="android">Android</option>
              <option value="ios">iOS</option>
            </select>
          </label>
          <label>
            Developer account
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">All accounts</option>
              {accounts.data?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Brand
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">All brands</option>
              {brands.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ErrorNotice error={overview.error} />
        {!overview.data && !overview.error ? <LoadingRows /> : null}
        {overview.data && !overview.data.apps.length ? <EmptyState title="No apps reporting yet">Connect a Google Play developer account or App Store Connect in Developer accounts &amp; apps. Every app the account publishes is found automatically.</EmptyState> : null}
        {overview.data?.apps.length ? (
          <div className="ai-grid">
            {overview.data.apps.map((a) => (
              <AppCard key={a.id} app={a} onOpen={() => setOpen(a.id)} active={open === a.id} />
            ))}
          </div>
        ) : null}
        {overview.data && Object.keys(overview.data.totals).length ? <Totals totals={overview.data.totals} /> : null}
        {overview.data ? (
          <ul className="small muted">
            {overview.data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </section>
      {open ? <AppDetail key={`${open}-${range.from}`} id={open} range={range} onClose={() => setOpen(null)} /> : null}
      <section className="card">
        <h2>What the Growth Brain sees</h2>
        <p className="small muted">Changes in reported acquisition over the last 28 final days against the 28 before. Nothing is stated on stale or thin data, and a change is not attributed to a cause.</p>
        <ErrorNotice error={signals.error} />
        {signals.data && !signals.data.signals.length ? <EmptyState title="No signals yet">Signals appear once apps have imported reports.</EmptyState> : null}
        <ul>
          {signals.data?.signals.map((s) => (
            <li key={`${s.appId}-${s.statement.slice(0, 40)}`}>
              <Badge value={s.status} /> {s.statement}
            </li>
          ))}
          {signals.data?.qualityFlags.map((f) => (
            <li key={f.statement}>
              <Badge value="quality" /> {f.statement}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function AppCard({ app, onOpen, active }: { app: OverviewApp; onOpen: () => void; active: boolean }) {
  const keys = HEADLINE[app.platform].slice(0, 3);
  return (
    <button type="button" className={`ai-card${active ? ' active' : ''}`} onClick={onOpen} aria-pressed={active}>
      <span className="ai-card-head">
        <strong>{app.displayName ?? app.appId}</strong>
        <span className="small muted">
          {app.platform === 'android' ? 'Android' : 'iOS'} · {app.appId}
        </span>
        <span className="small muted">{app.brand?.name ? `Brand: ${app.brand.name}` : 'No brand linked'}</span>
      </span>
      <span className="ai-kpis">
        {keys.map((k) => {
          const m = app.metrics[k];
          return (
            <span key={k} className="ai-kpi">
              <span className="small muted">{m?.label ?? k}</span>
              <span className="ai-kpi-value">{num(m?.value ?? null, m?.unit)}</span>
              <span className="small muted">{m && !m.complete && m.value !== null ? `${m.daysWithData}/${m.expectedDays} days reported` : change(m?.value ?? null, m?.previous ?? null)}</span>
            </span>
          );
        })}
      </span>
      <span className="small muted">
        Data through {app.freshness.latestDay ?? 'no day yet'} · <Badge value={app.coverage.worst ?? 'pending'} /> · account <Badge value={app.account.health} />
      </span>
    </button>
  );
}

function Totals({ totals }: { totals: Overview['totals'] }) {
  const rows = Object.entries(totals).flatMap(([platform, ms]) => Object.entries(ms).map(([, v]) => ({ platform: platform === 'android' ? 'Android' : 'iOS', metric: v.label, total: v.value === null ? `— (${v.appsComplete} of ${v.apps} apps have the full period)` : num(v.value) })));
  return (
    <>
      <h3>Totals of like metrics</h3>
      <DataTable rows={rows} columns={['platform', 'metric', 'total']} />
    </>
  );
}

function AppDetail({ id, range, onClose }: { id: string; range: { from: string; to: string }; onClose: () => void }) {
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day');
  const detail = useApi<Detail>(`/v1/app-intelligence/apps/${id}?${new URLSearchParams({ ...range, granularity })}`);
  const [metric, setMetric] = useState('');
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return <LoadingRows />;
  const d = detail.data;
  const keys = Object.keys(d.series);
  const shown = metric && d.series[metric] ? metric : (HEADLINE[d.app.platform as 'android' | 'ios'].find((k) => d.series[k]) ?? keys[0] ?? '');
  const def = d.definitions[shown];
  return (
    <section className="card">
      <div className="ai-detail-head">
        <h2>{d.app.displayName ?? d.app.appId}</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small muted">
        {d.account.displayName} · <Badge value={d.account.health} /> · last successful sync {d.account.lastSuccessAt ? relativeTime(d.account.lastSuccessAt) : 'never'} · next {d.account.nextSyncAt ? relativeTime(d.account.nextSyncAt) : 'not scheduled'}
        {d.account.syncing ? ' · syncing now' : ''}
      </p>
      {keys.length ? (
        <>
          <div className="form-grid">
            <label>
              Metric
              <select value={shown} onChange={(e) => setMetric(e.target.value)}>
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {d.definitions[k]?.label ?? k}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Group by
              <select value={granularity} onChange={(e) => setGranularity(e.target.value as typeof granularity)}>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </label>
          </div>
          <Trend buckets={d.series[shown] ?? []} unit={def?.aggregation === 'ratio' ? 'ratio' : undefined} />
          {def ? (
            <p className="small muted">
              <strong>{def.label}:</strong> {def.definition} Population: {def.population}.
            </p>
          ) : null}
        </>
      ) : (
        <EmptyState title="No reported days in this period">Recent days arrive later (Google posts within 3 to 7 days). Check the coverage below.</EmptyState>
      )}
      <div className="ai-columns">
        <Breakdown title="Countries" rows={d.breakdowns.countries} />
        <Breakdown title="Reported acquisition sources" rows={d.breakdowns.sources} />
        <Breakdown title="App versions" rows={d.breakdowns.versions} />
      </div>
      {d.campaigns ? (
        <>
          <h3>Campaigns (UTM, as reported by Google)</h3>
          <DataTable
            rows={d.campaigns.rows.map((c) => ({
              source: c.utmSource ?? '—',
              campaign: c.utmCampaign,
              acquisitions: num(c.acquisitions),
              visitors: num(c.visitors),
              identity: c.identity.status === 'post' ? 'one post' : c.identity.status === 'program' ? `shared by ${c.identity.posts ?? 'several'} posts` : c.identity.status.replace('_', ' '),
            }))}
            columns={['source', 'campaign', 'acquisitions', 'visitors', 'identity']}
            empty="No tagged campaign rows in this period."
          />
          <p className="small muted">{d.campaigns.note}</p>
        </>
      ) : null}
      <h3>Report coverage and freshness</h3>
      <DataTable rows={d.coverage.map((c) => ({ report: `${c.family.replace(/^(play|asc)\./, '')} · ${c.dimension}`, month: c.period, status: c.status, detail: c.detail.reason ?? (c.detail.through ? `through ${c.detail.through}` : '') }))} columns={['report', 'month', 'status', 'detail']} empty="Not checked yet." />
      <details>
        <summary>Imported report files</summary>
        <DataTable
          rows={d.files.map((f) => ({ report: `${f.family} · ${f.dimension}`, period: f.period, status: f.status, rejectedRows: f.rowsRejected, newColumns: f.unmappedColumns.join(', '), imported: relativeTime(f.importedAt) }))}
          columns={['report', 'period', 'status', 'rejectedRows', 'newColumns', 'imported']}
          empty="No files yet."
        />
      </details>
      <h3>Optional in-app telemetry</h3>
      <p className="small muted">{d.telemetry.note}</p>
      {d.telemetry.available ? <DataTable rows={d.telemetry.installsByDay} columns={['day', 'installs']} /> : <p className="small">No app-side telemetry received for this app in this period.</p>}
      <ul className="small muted">
        {d.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}

/** Line of reported values; incomplete buckets are hollow, unreported buckets are gaps. */
function Trend({ buckets, unit }: { buckets: Bucket[]; unit?: string }) {
  const vals = buckets.map((b) => b.value).filter((v): v is number => v !== null);
  if (!vals.length) return <p className="small muted">No reported values for this metric in the period.</p>;
  const w = 640;
  const hgt = 140;
  const max = Math.max(...vals, 0) || 1;
  const x = (i: number) => (buckets.length === 1 ? w / 2 : 8 + (i * (w - 16)) / (buckets.length - 1));
  const y = (v: number) => hgt - 12 - (v / max) * (hgt - 28);
  const segments: string[] = [];
  let cur = '';
  buckets.forEach((b, i) => {
    if (b.value === null) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.value).toFixed(1)}`;
  });
  if (cur) segments.push(cur);
  const last = [...buckets].reverse().find((b) => b.value !== null)!;
  return (
    <figure className="ai-trend">
      <svg viewBox={`0 0 ${w} ${hgt}`} role="img" aria-label={`Trend, latest ${num(last.value, unit)} for ${last.bucket}`}>
        <line x1="8" x2={w - 8} y1={hgt - 12} y2={hgt - 12} className="ai-axis" />
        {segments.map((d) => (
          <path key={d} d={d} className="ai-line" />
        ))}
        {buckets.map((b, i) =>
          b.value === null ? null : (
            <circle key={b.bucket} cx={x(i)} cy={y(b.value)} r={3} className={b.complete ? 'ai-dot' : 'ai-dot partial'}>
              <title>{`${b.bucket}: ${num(b.value, unit)}${b.complete ? '' : ` (${b.daysWithData} of ${b.expectedDays} days reported)`}`}</title>
            </circle>
          ),
        )}
      </svg>
      <figcaption className="small muted">
        {buckets[0]?.bucket} – {buckets.at(-1)?.bucket} · max {num(max, unit)} · hollow points have days not yet reported
      </figcaption>
    </figure>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { value: string; metrics: Record<string, number | null> }[] }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))];
  return (
    <div>
      <h3>{title}</h3>
      <DataTable rows={rows.slice(0, 15).map((r) => ({ value: r.value, ...Object.fromEntries(cols.map((c) => [c.replace(/^(play|asc)\./, ''), num(r.metrics[c] ?? null)])) }))} columns={['value', ...cols.map((c) => c.replace(/^(play|asc)\./, ''))]} empty="Not reported for this period." />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Developer accounts & apps                                           */
/* ------------------------------------------------------------------ */

function DeveloperAccounts({ me }: { me: Me }) {
  const data = useApi<{ accounts: Account[]; apps: StoreApp[] }>('/v1/app-intelligence/accounts');
  const brands = useApi<{ id: string; name: string }[]>('/v1/brands');
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await data.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <section className="card">
        <h2>Developer accounts &amp; apps</h2>
        <p className="small muted">Connect a developer account once. Every app it publishes is found from its own reports and appears here; new apps join without any change on your side.</p>
        <ErrorNotice error={data.error ?? error} />
        {!data.data && !data.error ? <LoadingRows /> : null}
        {data.data && !data.data.accounts.length ? <EmptyState title="No developer account connected">Add your Google Play or App Store Connect account below.</EmptyState> : null}
        {data.data?.accounts.map((a) => (
          <div key={a.id} className="card nested">
            <h3>
              {a.displayName} <Badge value={a.status === 'active' ? a.health : 'disabled'} />
            </h3>
            <p className="small muted">
              {PROVIDER[a.provider]} · {a.accountRef} · last success {a.lastSuccessAt ? relativeTime(a.lastSuccessAt) : 'never'} · next sync {a.nextSyncAt ? relativeTime(a.nextSyncAt) : 'not scheduled'}
              {a.backfillPending ? ' · importing history' : ''}
              {a.syncing ? ' · syncing now' : ''}
            </p>
            {a.health !== 'ok' && a.health !== 'unknown' ? <p className="notice error small">{healthHelp(a)}</p> : null}
            {a.lastRun?.stats?.notes?.length ? (
              <details>
                <summary className="small">Notes from the last sync</summary>
                <ul className="small">
                  {a.lastRun.stats.notes.slice(0, 10).map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <AppsTable apps={data.data!.apps.filter((x) => x.storeAccountId === a.id)} brands={brands.data ?? []} admin={isAdmin(me)} run={run} />
            <div className="row-actions">
              {canSync(me) && a.status === 'active' ? (
                <>
                  <button type="button" className="btn" onClick={() => void run(() => api('POST', `/v1/app-intelligence/accounts/${a.id}/sync`, { mode: 'incremental' }))}>
                    Sync now
                  </button>
                  <button type="button" className="btn" onClick={() => void run(() => api('POST', `/v1/app-intelligence/accounts/${a.id}/sync`, { mode: 'backfill' }))}>
                    Re-import history
                  </button>
                </>
              ) : null}
              {isAdmin(me) ? (
                <button type="button" className="btn" onClick={() => void run(() => api('PATCH', `/v1/app-intelligence/accounts/${a.id}`, { status: a.status === 'active' ? 'disabled' : 'active' }))}>
                  {a.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              ) : null}
            </div>
            {isAdmin(me) ? <ManualApp account={a} onAdded={() => void data.reload()} /> : null}
            {isAdmin(me) && a.provider === 'google_play' ? <ReplaceKey account={a} onReplaced={() => void data.reload()} /> : null}
          </div>
        ))}
      </section>
      {isAdmin(me) ? <ConnectAccount onConnected={() => void data.reload()} /> : <p className="small muted">An owner or admin with two-factor sign-in connects developer accounts.</p>}
    </>
  );
}

function healthHelp(a: Account): string {
  const msg = String(a.healthDetail?.error ?? '');
  if (a.health === 'permission_denied') return `Access denied. ${a.provider === 'google_play' ? 'In Play Console › Users and permissions, give the service account "View app information" (Global).' : 'Use an App Store Connect key with the Sales and Reports (or Admin) role.'} ${msg}`;
  if (a.health === 'auth_failed') return a.provider === 'google_play' ? 'The key was rejected (deleted, disabled or rotated). Use "Replace the service account key" below; history and apps stay.' : 'The key was rejected (deleted, disabled or rotated). Replace it in Connections.';
  if (a.health === 'not_found') return 'The report source was not found. Check the Cloud Storage URI.';
  if (a.health === 'rate_limited') return 'The provider limited requests; the next sync waits and retries automatically.';
  return `The last sync failed and will be retried with a growing delay. ${msg}`;
}

function AppsTable({ apps, brands, admin, run }: { apps: StoreApp[]; brands: { id: string; name: string }[]; admin: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  if (!apps.length) return <p className="small muted">No apps found yet. The first sync lists them from the account's reports.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>App</th>
            <th>Status</th>
            <th>Brand</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((x) => (
            <tr key={x.id}>
              <td>
                {x.displayName ?? x.appId}
                <div className="small muted">
                  {x.platform === 'android' ? 'Android' : 'iOS'} · {x.appId}
                </div>
              </td>
              <td>
                <Badge value={x.status} />
                {x.conflict?.reason ? <div className="small muted">{x.conflict.reason}</div> : null}
              </td>
              <td>{x.brand?.name ?? (admin && x.status === 'confirmed' ? <BrandLink app={x} brands={brands} run={run} /> : 'Not linked')}</td>
              <td>
                {admin && x.status === 'discovered' ? (
                  <>
                    <button type="button" className="btn ai-sm" onClick={() => void run(() => api('POST', `/v1/app-intelligence/apps/${x.id}/decision`, { decision: 'confirm' }))}>
                      Report this app
                    </button>{' '}
                    <button type="button" className="btn ai-sm" onClick={() => void run(() => api('POST', `/v1/app-intelligence/apps/${x.id}/decision`, { decision: 'ignore' }))}>
                      Ignore
                    </button>
                  </>
                ) : null}
                {admin && (x.status === 'conflict' || x.status === 'ignored') ? (
                  <button type="button" className="btn ai-sm" onClick={() => void run(() => api('POST', `/v1/app-intelligence/apps/${x.id}/decision`, { decision: 'take_over' }))}>
                    Report it from this account
                  </button>
                ) : null}
                {admin && x.platform === 'ios' && x.status === 'confirmed' && !x.analytics?.ONGOING ? (
                  <button type="button" className="btn ai-sm" onClick={() => void run(() => api('POST', `/v1/app-intelligence/apps/${x.id}/apple-analytics`, { accessType: 'ONGOING' }))}>
                    Request Apple reports
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BrandLink({ app, brands, run }: { app: StoreApp; brands: { id: string; name: string }[]; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [brandId, setBrandId] = useState('');
  if (!brands.length) return <span className="small muted">Create a brand in Brands &amp; channels</span>;
  if (app.platform === 'ios' && !app.storeAppId) return <span className="small muted">Not linked</span>;
  const listingUrl = app.platform === 'android' ? `https://play.google.com/store/apps/details?id=${app.appId}` : `https://apps.apple.com/us/app/app/id${app.storeAppId}`;
  return (
    <span className="inline-form">
      <select aria-label={`Brand for ${app.appId}`} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
        <option value="">Choose a brand</option>
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <button type="button" className="btn ai-sm" disabled={!brandId} onClick={() => void run(() => api('POST', `/v1/brands/${brandId}/apps`, { platform: app.platform, listingUrl }))}>
        Link
      </button>
    </span>
  );
}

function ManualApp({ account, onAdded }: { account: Account; onAdded: () => void }) {
  const [appId, setAppId] = useState('');
  const [storeAppId, setStoreAppId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const ios = account.provider === 'app_store_connect';
  return (
    <details>
      <summary className="small">Add an app that has not appeared yet</summary>
      <ErrorNotice error={error} />
      <div className="form-grid">
        <label>
          {ios ? 'Bundle ID' : 'Package name'}
          <input value={appId} onChange={(e) => setAppId(e.target.value.trim())} placeholder={ios ? 'com.example.app' : 'com.example.app'} />
        </label>
        {ios ? (
          <label>
            Apple ID (App Information)
            <input value={storeAppId} onChange={(e) => setStoreAppId(e.target.value.trim())} inputMode="numeric" />
          </label>
        ) : null}
      </div>
      <button
        type="button"
        className="btn"
        disabled={!appId}
        onClick={async () => {
          setError(null);
          try {
            await api('POST', `/v1/app-intelligence/accounts/${account.id}/apps`, { appId, ...(ios ? { storeAppId } : {}) });
            setAppId('');
            setStoreAppId('');
            onAdded();
          } catch (e) {
            setError(e);
          }
        }}
      >
        Add app
      </button>
    </details>
  );
}

/** Replaces a Play account's key in place: tested against the same bucket first; account, apps and history stay. */
function ReplaceKey({ account, onReplaced }: { account: Account; onReplaced: () => void }) {
  const [key, setKey] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <details>
      <summary className="small">Replace the service account key</summary>
      <p className="small muted">The new key is tested against {account.accountRef} before it is saved. The account, its apps and imported history stay as they are; nothing is imported twice.</p>
      <ErrorNotice error={error} />
      {done ? <p className="notice small">Key replaced; a sync has been queued.</p> : null}
      <label>
        Replacement key file (.json)
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 20_000) {
              setError(new Error('That file is too large to be a key file.'));
              return;
            }
            setDone(false);
            setFileName(f.name);
            setKey(await f.text());
          }}
        />
        {fileName && key ? <span className="small muted">{fileName} loaded; it is sent once over HTTPS, encrypted on the server and never shown again.</span> : null}
      </label>
      <button
        type="button"
        className="btn"
        disabled={!key || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api('POST', `/v1/app-intelligence/accounts/${account.id}/key`, { serviceAccountKey: key });
            setKey('');
            setFileName('');
            setDone(true);
            onReplaced();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Testing…' : 'Test and replace key'}
      </button>
    </details>
  );
}

function ConnectAccount({ onConnected }: { onConnected: () => void }) {
  const [provider, setProvider] = useState<'google_play' | 'app_store_connect'>('google_play');
  const [form, setForm] = useState({ displayName: '', bucket: '', key: '', issuerId: '', keyId: '', p8: '', connectionId: '' });
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const conns = useApi<{ id: string; provider: string; displayName: string }[]>('/v1/connections');
  const ascConns = (conns.data ?? []).filter((c) => c.provider === 'app_store_connect');
  const readFile = (target: 'key' | 'p8') => async (e: { target: { files: FileList | null } }) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 20_000) {
      setError(new Error('That file is too large to be a key file.'));
      return;
    }
    setFileName(f.name);
    setForm((s) => ({ ...s, [target]: '' }));
    const text = await f.text();
    setForm((s) => ({ ...s, [target]: text }));
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body =
        provider === 'google_play'
          ? { provider, displayName: form.displayName, bucket: form.bucket, serviceAccountKey: form.key }
          : form.connectionId
            ? { provider, connectionId: form.connectionId, ...(form.displayName ? { displayName: form.displayName } : {}) }
            : { provider, displayName: form.displayName || 'App Store Connect', issuerId: form.issuerId, keyId: form.keyId, privateKeyPem: form.p8 };
      await api('POST', '/v1/app-intelligence/accounts', body);
      setForm({ displayName: '', bucket: '', key: '', issuerId: '', keyId: '', p8: '', connectionId: '' });
      setFileName('');
      onConnected();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const ready = provider === 'google_play' ? form.displayName && form.bucket && form.key : form.connectionId || (form.issuerId && form.keyId && form.p8);
  return (
    <section className="card">
      <h2>Connect a developer account</h2>
      <div className="form-grid">
        <label>
          Store
          <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
            <option value="google_play">Google Play Console</option>
            <option value="app_store_connect">App Store Connect</option>
          </select>
        </label>
        <label>
          Name shown here
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} maxLength={200} placeholder="My Play account" />
        </label>
      </div>
      {provider === 'google_play' ? (
        <>
          <ol className="small">
            <li>In Google Cloud, create a service account and download a JSON key.</li>
            <li>In Play Console › Users and permissions, invite the service account's email with only "View app information" (Global). Access can take up to a day.</li>
            <li>In Play Console › Download reports › Statistics, choose "Copy Cloud Storage URI" and paste it below.</li>
          </ol>
          <div className="form-grid">
            <label>
              Cloud Storage URI
              <input value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} placeholder="gs://pubsite_prod_rev_…" />
            </label>
            <label>
              Service account key (JSON file)
              <input type="file" accept="application/json,.json" onChange={(e) => void readFile('key')(e)} />
              {fileName && form.key ? <span className="small muted">{fileName} loaded; it is sent once over HTTPS, encrypted on the server and never shown again.</span> : null}
            </label>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">A key with the Sales and Reports role can read reports; requesting Apple's analytics reports for an app needs an Admin key once.</p>
          {ascConns.length ? (
            <label>
              Use an existing App Store Connect connection
              <select value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}>
                <option value="">No, enter a key</option>
                {ascConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!form.connectionId ? (
            <div className="form-grid">
              <label>
                Issuer ID
                <input value={form.issuerId} onChange={(e) => setForm({ ...form, issuerId: e.target.value.trim() })} />
              </label>
              <label>
                Key ID
                <input value={form.keyId} onChange={(e) => setForm({ ...form, keyId: e.target.value.trim().toUpperCase() })} />
              </label>
              <label>
                Private key (.p8 file)
                <input type="file" accept=".p8" onChange={(e) => void readFile('p8')(e)} />
              </label>
            </div>
          ) : null}
        </>
      )}
      <ErrorNotice error={error} />
      <button type="button" className="btn primary" disabled={busy || !ready} onClick={() => void submit()}>
        {busy ? 'Checking access…' : 'Check access and connect'}
      </button>
      <p className="small muted">Access is checked with read-only calls before anything is saved. Connecting needs two-factor sign-in.</p>
    </section>
  );
}

import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { formatDay, relativeTime } from '../lib/format.js';
import { Ico } from './Icons.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const SEARCH_CONSOLE_CALLS = [
  { method: 'GET', path: '/v1/seo/search-console' },
  { method: 'GET', path: '/v1/seo/search-console/:id/properties' },
  { method: 'PUT', path: '/v1/seo/search-console/:id/property' },
  { method: 'POST', path: '/v1/seo/search-console/sync' },
  { method: 'GET', path: '/v1/seo/search-console/performance' },
  { method: 'GET', path: '/v1/seo/opportunities/grounded' },
  { method: 'POST', path: '/v1/seo/opportunities/ideas' },
] as const;

interface Period {
  start: string;
  end: string;
  rows: number;
  importedAt?: string | null;
}
interface Conn {
  id: string;
  displayName: string;
  status: string;
  healthStatus: string;
  property: string;
  propertySelected: boolean;
  permissionLevel: string | null;
  lastSync: { status: 'ok' | 'failed'; at: string; rows?: number; period?: { start: string; end: string }; error?: string; trigger: string } | null;
  lastData: { at: string; evidenceId: string; summary: string | null; stale: boolean } | null;
  periods: Period[];
}
interface Overview {
  freshnessHours: number;
  connections: Conn[];
  uploads: Period[];
  schedule: string;
}
interface Row {
  key: string | null;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}
interface Performance {
  period: { start: string; end: string } | null;
  totals: { rows: number; clicks: number; impressions: number; ctr: number | null; position: number | null; queries: number; pages: number } | null;
  queries: Row[];
  pages: Row[];
  notes: string[];
}
interface Opportunity {
  query: string;
  page_url: string | null;
  impressions: number;
  clicks: number;
  position: number;
  ctr: number;
  evidenceIds: string[];
}

const OPERATORS = ['owner', 'admin', 'growth_operator'];
const ADMINS = ['owner', 'admin'];
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const pos = (v: number | null) => (v === null ? '—' : Number(v).toFixed(1));
const day = (d: Date) => d.toISOString().slice(0, 10);
const periodLabel = (p: { start: string; end: string }) => `${formatDay(p.start)} – ${formatDay(p.end)}`;

/**
 * Channels › Search Console (P2-13): the property each connection reads, sync state and errors,
 * search performance for one reported period, and grounded opportunities that can become ideas.
 */
export function SearchConsole({ me }: { me: Me }) {
  const overview = useApi<Overview>('/v1/seo/search-console');
  const [selected, setSelected] = useState<string | null>(null);
  if (overview.error) return <ErrorNotice error={overview.error} />;
  if (!overview.data) return <LoadingRows label="Loading Search Console…" />;
  const o = overview.data;
  if (!o.connections.length)
    return (
      <EmptyState
        title="Search Console is not connected"
        action={
          <a className="btn" href="/app/connections">
            Open Connections & Credentials
          </a>
        }
      >
        Verify your site in Google Search Console, create an OAuth client, authorize a verified user with the webmasters.readonly scope and connect it here. FUTUREGROW only reads search data; it never changes your property.
        {o.uploads.length ? ` ${o.uploads.length} uploaded keyword period(s) are already available in SEO, ASO & AI discovery.` : ''}
      </EmptyState>
    );
  const conn = o.connections.find((c) => c.id === selected) ?? o.connections[0]!;
  return (
    <div className="stack">
      {o.connections.length > 1 ? (
        <div className="field">
          <label htmlFor="sc-conn">Connection</label>
          <select id="sc-conn" value={conn.id} onChange={(e) => setSelected(e.target.value)}>
            {o.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} — {c.property}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <ConnectionCard key={conn.id} conn={conn} me={me} schedule={o.schedule} onChanged={() => void overview.reload()} />
      {conn.periods.length ? <PerformanceView key={`${conn.id}:${conn.property}:${conn.periods[0]!.end}`} conn={conn} me={me} /> : <EmptyState title="No search data imported yet">Choose the property and use “Sync now”, or wait for the daily import. Search Console data arrives about two days late.</EmptyState>}
    </div>
  );
}

function ConnectionCard({ conn, me, schedule, onChanged }: { conn: Conn; me: Me; schedule: string; onChanged: () => void }) {
  const [choosing, setChoosing] = useState(false);
  const [props, setProps] = useState<{ siteUrl: string; permissionLevel: string; verified: boolean; selected: boolean; kind: string }[] | null>(null);
  const [pick, setPick] = useState(conn.property);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const end = new Date(Date.now() - 3 * 86_400_000);
  const [from, setFrom] = useState(day(new Date(end.getTime() - 6 * 86_400_000)));
  const [to, setTo] = useState(day(end));
  const canChoose = me.roles.some((r) => ADMINS.includes(r));
  const canSync = me.roles.some((r) => OPERATORS.includes(r));
  const loadProps = async () => {
    setError(null);
    setChoosing(true);
    try {
      const r = await api<{ properties: NonNullable<typeof props> }>('GET', `/v1/seo/search-console/${conn.id}/properties`);
      setProps(r.properties);
    } catch (e) {
      setError(e);
    }
  };
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api('PUT', `/v1/seo/search-console/${conn.id}/property`, { siteUrl: pick });
      setChoosing(false);
      setNotice(`This connection now reads ${pick}.`);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const sync = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const r = await api<{ rows: number }>('POST', '/v1/seo/search-console/sync', { connectionId: conn.id, startDate: from, endDate: to });
      setNotice(`Imported ${r.rows} query × page rows for ${periodLabel({ start: from, end: to })}.`);
      onChanged();
    } catch (e) {
      setError(e);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const s = conn.lastSync;
  return (
    <section className="card" aria-labelledby="sc-conn-title">
      <header className="card-head">
        <h2 className="card-title" id="sc-conn-title">
          <Ico name="search" size={19} /> {conn.displayName}
        </h2>
        <Badge value={conn.status} />
        {conn.healthStatus !== 'unknown' ? <Badge value={conn.healthStatus} /> : null}
        {conn.lastData?.stale ? <Badge value="stale" /> : null}
      </header>
      <div className="kv">
        <div className="kv-row">
          <span>Property</span>
          <strong>
            <span className="mono">{conn.property}</span>
            {conn.propertySelected ? '' : ' (the property it was connected with)'}
          </strong>
        </div>
        <div className="kv-row">
          <span>Permission</span>
          <strong>{conn.permissionLevel ?? 'Checked when you choose the property'}</strong>
        </div>
        <div className="kv-row">
          <span>Last sync</span>
          <strong>{s ? `${s.status === 'ok' ? 'Succeeded' : 'Failed'} ${relativeTime(s.at)} (${s.trigger === 'scheduled' ? 'daily import' : 'manual'})${s.period ? ` · ${periodLabel(s.period)}` : ''}${s.rows !== undefined ? ` · ${s.rows} rows` : ''}` : 'Never'}</strong>
        </div>
        <div className="kv-row">
          <span>Newest data</span>
          <strong>{conn.lastData ? `Imported ${relativeTime(conn.lastData.at)}` : 'None yet'}</strong>
        </div>
      </div>
      {s?.status === 'failed' ? (
        <p className="notice error small" role="alert">
          The last sync failed: {s.error ?? 'unknown error'}. Check that the authorized user is still a verified user of the property and that the OAuth grant has webmasters.readonly; reconnect in Connections if the token was revoked.
        </p>
      ) : null}
      <p className="small muted">{schedule}</p>
      <ErrorNotice error={error} />
      {notice ? (
        <p className="notice small" role="status">
          {notice}
        </p>
      ) : null}
      <div className="row">
        {canChoose ? (
          <button type="button" className="small-btn" onClick={() => void (choosing ? setChoosing(false) : loadProps())}>
            {choosing ? 'Close' : 'Choose property'}
          </button>
        ) : null}
      </div>
      {choosing ? (
        props ? (
          <fieldset className="stack-xs">
            <legend className="small">Properties the authorized user can see</legend>
            {props.map((p) => (
              <label key={p.siteUrl} className="small">
                <input type="radio" name={`prop-${conn.id}`} value={p.siteUrl} checked={pick === p.siteUrl} disabled={!p.verified} onChange={() => setPick(p.siteUrl)} /> <span className="mono">{p.siteUrl}</span> · {p.kind === 'domain' ? 'Domain property' : 'URL prefix'} ·{' '}
                {p.verified ? p.permissionLevel : 'not verified (cannot be used)'}
              </label>
            ))}
            <button type="button" className="btn" disabled={busy || pick === conn.property} onClick={() => void save()}>
              Use this property
            </button>
          </fieldset>
        ) : !error ? (
          <LoadingRows label="Asking Google for the property list…" />
        ) : null
      ) : null}
      {canSync ? (
        <div className="inline-form compact">
          <label htmlFor={`sc-from-${conn.id}`}>From</label>
          <input id={`sc-from-${conn.id}`} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <label htmlFor={`sc-to-${conn.id}`}>To</label>
          <input id={`sc-to-${conn.id}`} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          <button type="button" className="small-btn" disabled={busy || conn.status !== 'active' || !from || !to} onClick={() => void sync()}>
            {busy ? 'Working…' : 'Sync now'}
          </button>
        </div>
      ) : (
        <p className="small muted">An owner, admin or growth operator can sync on demand.</p>
      )}
    </section>
  );
}

function PerformanceView({ conn, me }: { conn: Conn; me: Me }) {
  const [periodKey, setPeriodKey] = useState(`${conn.periods[0]!.start}..${conn.periods[0]!.end}`);
  const [tab, setTab] = useState<'queries' | 'pages'>('queries');
  const [start, end] = periodKey.split('..') as [string, string];
  const qs = new URLSearchParams({ siteUrl: conn.property, periodStart: start, periodEnd: end });
  const perf = useApi<Performance>(`/v1/seo/search-console/performance?${qs}`);
  const opp = useApi<{ rows: Opportunity[]; method: string; note: string }>(`/v1/seo/opportunities/grounded?${qs}`);
  const [ideas, setIdeas] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canPropose = me.roles.some((r) => OPERATORS.includes(r));
  const propose = async () => {
    setError(null);
    try {
      const r = await api<{ created: number }>('POST', '/v1/seo/opportunities/ideas', { limit: 5, siteUrl: conn.property, periodStart: start, periodEnd: end });
      setIdeas(`${r.created} idea${r.created === 1 ? '' : 's'} added to the Idea Lab, each citing its Search Console evidence.`);
    } catch (e) {
      setError(e);
    }
  };
  const t = perf.data?.totals;
  const rows = perf.data ? (tab === 'queries' ? perf.data.queries : perf.data.pages) : [];
  return (
    <>
      <section className="card" aria-labelledby="sc-perf">
        <header className="card-head">
          <h2 className="card-title" id="sc-perf">
            <Ico name="chart" size={19} /> Search performance
          </h2>
          <label className="mini-select" htmlFor="sc-period">
            <span className="sr-only">Reported period</span>
            <select id="sc-period" value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
              {conn.periods.map((p) => (
                <option key={`${p.start}..${p.end}`} value={`${p.start}..${p.end}`}>
                  {periodLabel(p)} ({p.rows} rows)
                </option>
              ))}
            </select>
          </label>
        </header>
        {perf.error ? <ErrorNotice error={perf.error} /> : null}
        {!perf.data ? (
          <LoadingRows />
        ) : !t ? (
          <p className="small muted">No rows for this period.</p>
        ) : (
          <>
            <div className="glance-grid">
              {[
                ['Clicks', t.clicks.toLocaleString()],
                ['Impressions', t.impressions.toLocaleString()],
                ['Click-through rate', pct(t.ctr)],
                ['Average position', pos(t.position)],
                ['Queries', t.queries.toLocaleString()],
                ['Pages', t.pages.toLocaleString()],
              ].map(([label, value]) => (
                <div key={label} className="glance-tile quiet">
                  <span>
                    <span className="glance-label">{label}</span>
                    <span className="glance-value">{value}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="seg" role="tablist" aria-label="Breakdown">
              <button type="button" role="tab" aria-selected={tab === 'queries'} className="seg-btn" onClick={() => setTab('queries')}>
                Queries
              </button>
              <button type="button" role="tab" aria-selected={tab === 'pages'} className="seg-btn" onClick={() => setTab('pages')}>
                Pages
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{tab === 'queries' ? 'Query' : 'Page'}</th>
                    <th scope="col">Clicks</th>
                    <th scope="col">Impressions</th>
                    <th scope="col">CTR</th>
                    <th scope="col">Position</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key ?? '(none)'}>
                      <td data-label={tab === 'queries' ? 'Query' : 'Page'}>{tab === 'pages' && r.key ? <span className="mono">{r.key}</span> : (r.key ?? '(no page)')}</td>
                      <td data-label="Clicks">{r.clicks.toLocaleString()}</td>
                      <td data-label="Impressions">{r.impressions.toLocaleString()}</td>
                      <td data-label="CTR">{pct(r.ctr)}</td>
                      <td data-label="Position">{pos(r.position)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="small muted">
              {perf.data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="sc-opp">
        <header className="card-head">
          <h2 className="card-title" id="sc-opp">
            <Ico name="bulb" size={19} /> Opportunities to review
          </h2>
          {canPropose && opp.data?.rows.length ? (
            <button type="button" className="small-btn" onClick={() => void propose()}>
              Turn the top 5 into ideas
            </button>
          ) : null}
        </header>
        <ErrorNotice error={error} />
        {ideas ? (
          <p className="notice small" role="status">
            {ideas} <a href="/app/market">Open the Idea Lab</a>
          </p>
        ) : null}
        {opp.error ? <ErrorNotice error={opp.error} /> : null}
        {!opp.data ? (
          <LoadingRows />
        ) : opp.data.rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Query</th>
                  <th scope="col">Page</th>
                  <th scope="col">Impressions</th>
                  <th scope="col">CTR</th>
                  <th scope="col">Position</th>
                </tr>
              </thead>
              <tbody>
                {opp.data.rows.map((r) => (
                  <tr key={`${r.query}|${r.page_url}`}>
                    <td data-label="Query">{r.query}</td>
                    <td data-label="Page">{r.page_url ? <span className="mono">{r.page_url}</span> : '—'}</td>
                    <td data-label="Impressions">{Number(r.impressions).toLocaleString()}</td>
                    <td data-label="CTR">{pct(Number(r.ctr))}</td>
                    <td data-label="Position">{pos(Number(r.position))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">No query in this period ranks at positions 4–20 with a below-median click-through rate and at least 100 impressions.</p>
        )}
        {opp.data ? (
          <p className="small muted">
            {opp.data.method}. {opp.data.note}
          </p>
        ) : null}
      </section>
    </>
  );
}

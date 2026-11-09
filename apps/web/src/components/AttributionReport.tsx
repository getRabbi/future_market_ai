import { useMemo, useState } from 'react';
import { formatDay } from '../lib/format.js';
import { BarList } from './Chart.js';
import { Ico } from './Icons.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const ATTRIBUTION_CALLS = [
  { method: 'GET', path: '/v1/app/attribution/apps' },
  { method: 'GET', path: '/v1/app/attribution' },
  { method: 'GET', path: '/v1/brands' },
] as const;

interface AppRow {
  platform: 'ios' | 'android';
  appId: string;
  name: string | null;
  brandId: string | null;
  brandName: string | null;
  storeReports: boolean;
  telemetry: boolean;
}
interface Campaign {
  campaign: string;
  identity: { status: 'unregistered' | 'post' | 'program' | 'brand_mismatch'; brandId?: string | null; programId?: string | null; postId?: string | null };
  storeReported: { available: boolean; acquisitions: number | null; visitors: number | null; reportedDays: number; reportedThrough: string | null; note: string };
  telemetry: { installs: number; firstOpens: number | null; activations: number | null; methods: string[] } | null;
  content: { posts: { postId: string | null; programId: string | null; channel: string | null }[]; paidDrafts: { draftId: string; platform: string; name: string; status: string }[] };
  telemetryCoverageOfStore: number | null;
}
interface Step {
  key: string;
  label: string;
  value: number | null;
}
interface Report {
  campaigns: Campaign[];
  funnel: { store: { basis: string; campaigns: number; steps: Step[] }; telemetry: { basis: string; campaigns: number; steps: Step[] }; note: string };
  coverage: { periodDays: number; storeReportedThrough: string | null; storeLagDays: number | null; campaigns: number; withStoreReport: number; withTelemetry: number; withBoth: number; registered: number; excludedStoreDays: number };
  missingData: { key: string; detail: string; action: string }[];
  incrementality: { basis: string; experiments: { experimentId: string; name: string; targetMetric: string }[]; note?: string };
  windows: Record<string, string>;
  notes: string[];
}

const PERIODS = [
  { key: '28', label: 'Last 28 days' },
  { key: '56', label: 'Last 56 days' },
  { key: '90', label: 'Last 90 days' },
];
const n = (v: number | null | undefined) => (v === null || v === undefined ? 'Not reported' : v.toLocaleString());
const WINDOW_LABELS: Record<string, string> = { telemetryFirstOpen: 'Telemetry first-open window', telemetryActivation: 'Telemetry activation window', storeReport: 'Store report attribution' };
const IDENTITY: Record<Campaign['identity']['status'], string> = { post: 'One post', program: 'A content program', unregistered: 'Not registered', brand_mismatch: 'Another brand (check the link)' };

/**
 * Apps & Intelligence › Attribution report (P3-08): store-reported acquisitions and consented app
 * telemetry per campaign, side by side and never added, with coverage, freshness and what is
 * missing. Without a completed experiment the report is descriptive, and it says so.
 */
export function AttributionReport() {
  const apps = useApi<AppRow[]>('/v1/app/attribution/apps');
  const brands = useApi<{ id: string; name: string }[]>('/v1/brands');
  const [brand, setBrand] = useState('');
  const [selection, setSelection] = useState('');
  const [period, setPeriod] = useState('28');
  const [filter, setFilter] = useState('');
  const list = (apps.data ?? []).filter((a) => !brand || a.brandId === brand);
  const selected = list.find((a) => `${a.platform}:${a.appId}` === selection) ?? list[0];
  if (apps.error) return <ErrorNotice error={apps.error} />;
  if (!apps.data) return <LoadingRows label="Loading applications…" />;
  if (!apps.data.length)
    return (
      <EmptyState
        title="No application to report on yet"
        action={
          <a className="btn" href="/app/apps?tab=accounts">
            Connect a developer account
          </a>
        }
      >
        Attribution needs an app: connect a Google Play or App Store Connect developer account (store reports), link the app to a brand in Channels & Accounts, or send consented installs from your app backend.
      </EmptyState>
    );
  return (
    <div className="stack">
      <section className="card" aria-label="Report filters">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="at-brand">Brand</label>
            <select
              id="at-brand"
              value={brand}
              onChange={(e) => {
                setBrand(e.target.value);
                setSelection('');
              }}
            >
              <option value="">All brands</option>
              {(brands.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="at-app">Application</label>
            <select id="at-app" value={selected ? `${selected.platform}:${selected.appId}` : ''} onChange={(e) => setSelection(e.target.value)} disabled={!list.length}>
              {list.map((a) => (
                <option key={`${a.platform}:${a.appId}`} value={`${a.platform}:${a.appId}`}>
                  {a.name ?? a.appId} ({a.platform === 'android' ? 'Google Play' : 'App Store'})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="at-period">Period</label>
            <select id="at-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="at-campaign">Campaign contains</label>
            <input id="at-campaign" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="e.g. lessons_2611" />
          </div>
        </div>
        {selected ? (
          <p className="small muted">
            {selected.brandName ? `Brand: ${selected.brandName}. ` : 'Not linked to a brand. '}
            Sources: {selected.platform === 'android' ? (selected.storeReports ? 'Google Play reports' : 'no Google Play reports yet') : 'App Store reports (no campaign dimension)'} · {selected.telemetry ? 'app telemetry' : 'no app telemetry'}.
          </p>
        ) : null}
      </section>
      {brand && !list.length ? (
        <EmptyState title="This brand has no linked application">Link the brand’s app in Channels & Accounts to report on it.</EmptyState>
      ) : selected ? (
        <AppReport key={`${selected.platform}:${selected.appId}:${period}:${brand}`} app={selected} days={Number(period)} brandId={brand && selected.brandId === brand ? brand : null} filter={filter} />
      ) : null}
    </div>
  );
}

function AppReport({ app, days, brandId, filter }: { app: AppRow; days: number; brandId: string | null; filter: string }) {
  const query = useMemo(() => {
    const now = new Date();
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const p = new URLSearchParams({ appId: app.appId, platform: app.platform, from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() });
    if (brandId) p.set('brandId', brandId);
    return p;
  }, [app.appId, app.platform, days, brandId]);
  const report = useApi<Report>(`/v1/app/attribution?${query}`);
  if (report.error) return <ErrorNotice error={report.error} />;
  if (!report.data) return <LoadingRows label="Building the attribution report…" />;
  const r = report.data;
  const term = filter.trim().toLowerCase();
  const rows = r.campaigns.filter((c) => !term || c.campaign.toLowerCase().includes(term));
  const c = r.coverage;
  return (
    <>
      <section className="card" aria-labelledby="at-coverage">
        <header className="card-head">
          <h2 className="card-title" id="at-coverage">
            <Ico name="clock" size={19} /> Coverage and freshness
          </h2>
        </header>
        <div className="glance-grid">
          <div className="glance-tile quiet">
            <span>
              <span className="glance-label">Store report published through</span>
              <span className="glance-value">{c.storeReportedThrough ? formatDay(c.storeReportedThrough) : app.platform === 'ios' ? 'No campaigns (iOS)' : 'Not yet'}</span>
              {c.storeLagDays ? <span className="glance-note">{c.storeLagDays} newest day(s) not published yet — unknown, not zero</span> : null}
            </span>
          </div>
          <div className="glance-tile quiet">
            <span>
              <span className="glance-label">Campaigns</span>
              <span className="glance-value">{c.campaigns}</span>
              <span className="glance-note">
                {c.withStoreReport} in store reports · {c.withTelemetry} in telemetry · {c.withBoth} in both
              </span>
            </span>
          </div>
          <div className="glance-tile quiet">
            <span>
              <span className="glance-label">Registered to content</span>
              <span className="glance-value">
                {c.registered} of {c.campaigns}
              </span>
              <span className="glance-note">From the campaign registry, never guessed from UTM labels</span>
            </span>
          </div>
        </div>
      </section>

      <div className="grid-2">
        <Funnel title="Store report (Google Play)" icon="phone" f={r.funnel.store} unavailable={app.platform === 'ios'} />
        <Funnel title="App telemetry (consented)" icon="trend" f={r.funnel.telemetry} unavailable={false} />
      </div>
      <p className="small muted">{r.funnel.note}</p>

      <section className="card" aria-labelledby="at-campaigns">
        <header className="card-head">
          <h2 className="card-title" id="at-campaigns">
            Campaigns
          </h2>
          <span className="small muted">Store and telemetry columns are separate measurements; no row has a combined total.</span>
        </header>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th scope="col">Belongs to</th>
                  <th scope="col">Store visitors</th>
                  <th scope="col">Store acquisitions</th>
                  <th scope="col">Telemetry installs</th>
                  <th scope="col">First opens</th>
                  <th scope="col">Activations</th>
                  <th scope="col">Telemetry ÷ store</th>
                  <th scope="col">Paid campaigns</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.campaign}>
                    <td data-label="Campaign">
                      <span className="mono">{x.campaign}</span>
                    </td>
                    <td data-label="Belongs to">
                      {IDENTITY[x.identity.status]}
                      {x.identity.postId ? (
                        <>
                          {' · '}
                          <a href="/app/calendar">post</a>
                        </>
                      ) : null}
                    </td>
                    <td data-label="Store visitors" title={x.storeReported.note}>
                      {app.platform === 'ios' ? 'Not available' : n(x.storeReported.visitors)}
                    </td>
                    <td data-label="Store acquisitions" title={x.storeReported.note}>
                      {app.platform === 'ios' ? 'Not available' : n(x.storeReported.acquisitions)}
                      {x.storeReported.reportedDays ? <span className="small muted"> ({x.storeReported.reportedDays} days)</span> : null}
                    </td>
                    <td data-label="Telemetry installs">{x.telemetry ? x.telemetry.installs.toLocaleString() : 'No telemetry'}</td>
                    <td data-label="First opens">{x.telemetry ? n(x.telemetry.firstOpens) : '—'}</td>
                    <td data-label="Activations">{x.telemetry ? n(x.telemetry.activations) : '—'}</td>
                    <td data-label="Telemetry ÷ store">{x.telemetryCoverageOfStore === null ? '—' : `${Math.round(x.telemetryCoverageOfStore * 100)}%`}</td>
                    <td data-label="Paid campaigns">{x.content.paidDrafts.length ? x.content.paidDrafts.map((d) => `${d.name} (${d.status})`).join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : r.campaigns.length ? (
          <p className="small muted">No campaign matches “{filter}”.</p>
        ) : (
          <p className="small muted">No campaign in this period.</p>
        )}
        <p className="small muted">“Telemetry ÷ store” describes how much of the store’s count the consented backend observes; it is not a conversion rate.</p>
      </section>

      {r.missingData.length ? (
        <section className="card" aria-labelledby="at-missing">
          <header className="card-head">
            <h2 className="card-title" id="at-missing">
              <Ico name="alert" size={19} /> What is missing and why
            </h2>
          </header>
          <ul className="row-list">
            {r.missingData.map((m) => (
              <li key={m.key}>
                <span>
                  <strong>{m.detail.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => formatDay(d))}</strong>
                  <span className="small muted"> {m.action}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card" aria-labelledby="at-causal">
        <header className="card-head">
          <h2 className="card-title" id="at-causal">
            What this does and does not show
          </h2>
          <Badge value={r.incrementality.basis === 'none' ? 'descriptive' : 'experiment'} />
        </header>
        {r.incrementality.basis === 'none' ? (
          <p className="small">{r.incrementality.note}</p>
        ) : (
          <ul className="small">
            {r.incrementality.experiments.map((e) => (
              <li key={e.experimentId}>
                <a href="/app/experiments">{e.name}</a> measured {e.targetMetric}
              </li>
            ))}
          </ul>
        )}
        <ul className="small muted">
          {r.notes.map((x) => (
            <li key={x}>{x}</li>
          ))}
          {Object.entries(r.windows).map(([k, w]) => (
            <li key={k}>
              {WINDOW_LABELS[k] ?? k}: {w}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Funnel({ title, icon, f, unavailable }: { title: string; icon: 'phone' | 'trend'; f: { basis: string; campaigns: number; steps: Step[] }; unavailable: boolean }) {
  return (
    <section className="card" aria-label={title}>
      <header className="card-head">
        <h3 className="card-title">
          <Ico name={icon} size={18} /> {title}
        </h3>
        <span className="small muted">
          {f.campaigns} campaign{f.campaigns === 1 ? '' : 's'}
        </span>
      </header>
      {unavailable || !f.steps.length ? <p className="small muted">{f.basis}</p> : <BarList label={title} rows={f.steps.map((s) => ({ name: s.label, value: s.value }))} />}
      {!unavailable && f.steps.length ? <p className="small muted">{f.basis}</p> : null}
    </section>
  );
}

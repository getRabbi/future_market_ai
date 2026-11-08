import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call these screens make (checked against the API's routes in catalog.test.ts). */
export const CHANNEL_GROWTH_CALLS = [
  { method: 'GET', path: '/v1/social/analytics' },
  { method: 'POST', path: '/v1/social/connections/:id/analytics/sync' },
  { method: 'GET', path: '/v1/ads/drafts' },
  { method: 'GET', path: '/v1/ads/creation-status' },
  { method: 'POST', path: '/v1/ads/drafts' },
  { method: 'PUT', path: '/v1/ads/drafts/:id' },
  { method: 'POST', path: '/v1/ads/drafts/:id/submit' },
  { method: 'POST', path: '/v1/ads/drafts/:id/cancel' },
  { method: 'GET', path: '/v1/connections' },
  { method: 'GET', path: '/v1/brands' },
  { method: 'GET', path: '/v1/assets' },
] as const;

interface PlatformReport {
  platform: string;
  definitions: Record<string, { label: string; definition: string; unit: string }>;
  connections: { id: string; displayName: string }[];
  freshness: { lastRunAt: string | null; lastStatus: string | null; lastError: string | null; stale: boolean; lastObservedOn: string | null };
  account: { ref: string; metrics: Record<string, { value: number | null; status: string }> }[];
  posts: { ref: string; caption: string | null; url: string | null; metrics: Record<string, { value: number | null; status: string }> }[];
  totals: Record<string, { value: number | null; posts: number; of: number; complete: boolean }>;
  coverage: { verifiedPosts: number; postsWithData: number };
}

const fmt = (v: number | null, unit?: string) => (v === null ? 'not reported' : unit === 'rate' ? `${(v * 100).toFixed(1)}%` : v.toLocaleString());

/**
 * Social platform results (P3-05): one card per platform, each in that platform's own metric
 * definitions. Platforms are never added together; a value the platform did not report shows as
 * "not reported", and a total over only some posts is marked partial.
 */
export function SocialAnalytics({ me }: { me: Me }) {
  const report = useApi<PlatformReport[]>('/v1/social/analytics');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canSync = me.roles.some((r) => ['owner', 'admin', 'growth_operator', 'analyst'].includes(r));
  const sync = async (id: string) => {
    setError(null);
    setBusy(id);
    try {
      await api('POST', `/v1/social/connections/${id}/analytics/sync`);
      await report.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  if (report.error) return <ErrorNotice error={report.error} />;
  if (!report.data) return <LoadingRows label="Loading platform results…" />;
  if (!report.data.length) return <EmptyState title="No Instagram, TikTok, YouTube or LinkedIn results yet">Connect an account in Connections; results are imported daily once posts are verified on the platform.</EmptyState>;
  return (
    <section className="stack" aria-label="Social platform results">
      <p className="small muted">Each platform counts differently (a TikTok view is not a YouTube view), so results are shown per platform and never added together.</p>
      <ErrorNotice error={error} />
      {report.data.map((p) => (
        <article key={p.platform} className="card">
          <header className="card-head">
            <h3 className="card-title">{p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}</h3>
            <span className="small muted">
              {p.coverage.postsWithData} of {p.coverage.verifiedPosts} verified posts reported · {p.freshness.lastRunAt ? `imported ${relativeTime(p.freshness.lastRunAt)}` : 'never imported'}
            </span>
            {p.freshness.stale ? <Badge value="stale" /> : null}
            {p.freshness.lastStatus ? <Badge value={p.freshness.lastStatus} /> : null}
          </header>
          {p.freshness.lastError ? <p className="notice small">Last import failed: {p.freshness.lastError}</p> : null}
          {p.account.map((a) => (
            <p key={a.ref} className="small">
              {Object.entries(a.metrics)
                .map(([k, m]) => `${p.definitions[k]?.label ?? k}: ${fmt(m.value, p.definitions[k]?.unit)}`)
                .join(' · ')}
            </p>
          ))}
          <div className="kv">
            {Object.entries(p.totals).map(([k, t]) => (
              <div key={k} className="kv-row" title={p.definitions[k]?.definition}>
                <span>{p.definitions[k]?.label ?? k}</span>
                <strong>
                  {fmt(t.value, p.definitions[k]?.unit)}
                  {t.value !== null && !t.complete ? ` (partial: ${t.posts} of ${t.of} posts)` : ''}
                </strong>
              </div>
            ))}
          </div>
          <details>
            <summary className="small">Per post and definitions</summary>
            <ul className="small">
              {p.posts.map((post) => (
                <li key={post.ref}>
                  {post.url ? (
                    <a href={post.url} target="_blank" rel="noreferrer noopener">
                      {post.caption ?? post.ref}
                    </a>
                  ) : (
                    (post.caption ?? post.ref)
                  )}
                  :{' '}
                  {Object.entries(post.metrics)
                    .map(([k, m]) => `${p.definitions[k]?.label ?? k} ${fmt(m.value, p.definitions[k]?.unit)}`)
                    .join(', ')}
                </li>
              ))}
            </ul>
            <dl className="small">
              {Object.entries(p.definitions).map(([k, d]) => (
                <div key={k}>
                  <dt>{d.label}</dt>
                  <dd>{d.definition}</dd>
                </div>
              ))}
            </dl>
          </details>
          {canSync
            ? p.connections.map((c) => (
                <button key={c.id} type="button" className="small-btn" disabled={busy !== null} onClick={() => void sync(c.id)}>
                  Import now: {c.displayName}
                </button>
              ))
            : null}
        </article>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Paid campaign drafts (P3-06)                                        */
/* ------------------------------------------------------------------ */

interface DraftRow {
  id: string;
  platform: 'meta' | 'google_ads';
  name: string;
  status: string;
  statusReason: string | null;
  problems: string[];
  actionId: string | null;
  externalCampaignId: string | null;
  geographies: string[];
  spec: Record<string, any>;
  version: number;
  updatedAt: string;
}

const days = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));

/**
 * Brief → objective → targeting → budget → creative → review → approval → create → verify →
 * monitor. Campaigns are created PAUSED after a finance approval with two-factor; creation is
 * disabled until the owner authorizes it, and the screen says so.
 */
export function CampaignDrafts({ me }: { me: Me }) {
  const drafts = useApi<DraftRow[]>('/v1/ads/drafts');
  const status = useApi<Record<'meta' | 'google_ads', { enabled: boolean; reason: string }>>('/v1/ads/creation-status');
  const [editing, setEditing] = useState<DraftRow | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canEdit = me.roles.some((r) => ['owner', 'admin', 'growth_operator'].includes(r));
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await drafts.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">New paid campaigns</h2>
        {canEdit ? (
          <button type="button" className="btn" onClick={() => setEditing(editing ? null : 'new')}>
            {editing ? 'Close' : 'New campaign draft'}
          </button>
        ) : null}
      </header>
      {status.data
        ? (['meta', 'google_ads'] as const).map((p) => (
            <p key={p} className="small">
              <Badge value={status.data![p].enabled ? 'ready' : 'disabled'} /> {p === 'meta' ? 'Meta' : 'Google Ads'}: {status.data![p].reason}
            </p>
          ))
        : null}
      <p className="small muted">A campaign is created paused and checked on the platform. Turning it on is a separate change that also needs approval. Every draft states its budget, end date and the most it can spend.</p>
      <ErrorNotice error={error} />
      {editing ? (
        <DraftForm
          draft={editing === 'new' ? null : editing}
          onSaved={() => {
            setEditing(null);
            void drafts.reload();
          }}
        />
      ) : null}
      {!drafts.data ? (
        <LoadingRows />
      ) : drafts.data.length ? (
        <ul className="row-list">
          {drafts.data.map((d) => (
            <li key={d.id} className="row-item">
              <div className="row">
                <div>
                  <strong>{d.name}</strong>{' '}
                  <span className="small muted">
                    {d.platform === 'meta' ? 'Meta' : 'Google Ads'} · {d.geographies.join(', ')} · {(d.spec.dailyBudget?.amountMicros ?? 0) / 1e6} {d.spec.dailyBudget?.currency}/day · cap {(d.spec.lifetimeCap?.amountMicros ?? 0) / 1e6} {d.spec.lifetimeCap?.currency} · {relativeTime(d.updatedAt)}
                  </span>
                  {d.statusReason ? <div className="small muted">{d.statusReason}</div> : null}
                  {d.externalCampaignId ? <div className="small">Provider campaign: {d.externalCampaignId}</div> : null}
                  {d.problems.length ? (
                    <ul className="small findings">
                      {d.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="row-actions">
                  <Badge value={d.status} />
                  {canEdit && (d.status === 'draft' || d.status === 'failed') ? (
                    <>
                      <button type="button" className="small-btn" onClick={() => setEditing(d)}>
                        Edit
                      </button>
                      <button type="button" className="small-btn" disabled={d.problems.length > 0} onClick={() => void act(() => api('POST', `/v1/ads/drafts/${d.id}/submit`))}>
                        Submit for approval
                      </button>
                      <button type="button" className="small-btn" onClick={() => void act(() => api('POST', `/v1/ads/drafts/${d.id}/cancel`))}>
                        Cancel
                      </button>
                    </>
                  ) : null}
                  {d.actionId ? (
                    <a className="small-btn" href={`/app/approvals?id=${d.actionId}`}>
                      Approval
                    </a>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No campaign drafts">Draft a campaign: objective, countries, budget, end date, creative and landing page.</EmptyState>
      )}
    </section>
  );
}

function DraftForm({ draft, onSaved }: { draft: DraftRow | null; onSaved: () => void }) {
  const conns = useApi<{ id: string; provider: string; displayName: string; status: string }[]>('/v1/connections');
  const brands = useApi<{ id: string; name: string }[]>('/v1/brands');
  const media = useApi<{ id: string; kind: string; title: string; sha256: string; publishEligible: boolean }[]>('/v1/assets');
  const s = draft?.spec ?? {};
  const [platform, setPlatform] = useState<'meta' | 'google_ads'>(draft?.platform ?? 'meta');
  const [connectionId, setConnectionId] = useState<string>((draft as unknown as { connectionId?: string })?.connectionId ?? '');
  const [brandId, setBrandId] = useState<string>((draft as unknown as { brandId?: string })?.brandId ?? '');
  const [name, setName] = useState(draft?.name ?? '');
  const [countries, setCountries] = useState((draft?.geographies ?? ['US']).join(', '));
  const [currency, setCurrency] = useState<string>(s.dailyBudget?.currency ?? 'USD');
  const [daily, setDaily] = useState<number>((s.dailyBudget?.amountMicros ?? 5_000_000) / 1e6);
  const [start, setStart] = useState<string>(String(s.startTime ?? s.startDate ?? '').slice(0, 10));
  const [end, setEnd] = useState<string>(String(s.endTime ?? s.endDate ?? '').slice(0, 10));
  const [landing, setLanding] = useState<string>(s.creative?.link ?? s.ad?.finalUrl ?? '');
  const [utm, setUtm] = useState<string>(s.urlTags ?? s.ad?.finalUrlSuffix ?? 'utm_source=paid&utm_medium=cpc&utm_campaign=');
  const [message, setMessage] = useState<string>(s.creative?.message ?? '');
  const [headline, setHeadline] = useState<string>(s.creative?.headline ?? '');
  const [imageId, setImageId] = useState<string>(s.creative?.image?.assetId ?? '');
  const [objective, setObjective] = useState<string>(s.objective ?? 'OUTCOME_TRAFFIC');
  const [headlines, setHeadlines] = useState<string>((s.ad?.headlines ?? []).join('\n'));
  const [descriptions, setDescriptions] = useState<string>((s.ad?.descriptions ?? []).join('\n'));
  const [keywords, setKeywords] = useState<string>((s.keywords ?? []).map((k: { text: string }) => k.text).join('\n'));
  const [geoIds, setGeoIds] = useState<string>((s.geoTargetConstants ?? [2840]).join(', '));
  const [error, setError] = useState<unknown>(null);
  const accounts = (conns.data ?? []).filter((c) => c.provider === platform && c.status === 'active');
  const images = (media.data ?? []).filter((a) => a.kind === 'image' && a.publishEligible);
  const n = start && end ? (platform === 'meta' ? days(start, end) : days(start, end) + 1) : 0;
  const save = async () => {
    setError(null);
    const geographies = countries
      .split(/[\s,]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    const money = (v: number) => ({ amountMicros: Math.round(v * 1e6), currency });
    const cap = money(daily * n);
    const spec =
      platform === 'meta'
        ? {
            objective,
            dailyBudget: money(daily),
            startTime: `${start}T00:00:00Z`,
            endTime: `${end}T00:00:00Z`,
            targeting: { countries: geographies, ageMin: 18, ageMax: 65, publisherPlatforms: null },
            optimizationGoal: 'LINK_CLICKS',
            billingEvent: 'IMPRESSIONS',
            creative: { pageId: '', message, link: landing, headline, callToAction: 'LEARN_MORE', image: { assetId: imageId, sha256: images.find((i) => i.id === imageId)?.sha256 ?? '' } },
            urlTags: utm,
            lifetimeCap: cap,
          }
        : {
            dailyBudget: money(daily),
            startDate: start,
            endDate: end,
            geoTargetConstants: geoIds
              .split(/[\s,]+/)
              .filter(Boolean)
              .map(Number),
            languageConstants: [],
            bidding: { strategy: 'MAXIMIZE_CLICKS', cpcBidCeiling: null },
            adGroup: { name: `${name} ad group`, cpcBid: null },
            ad: { finalUrl: landing, finalUrlSuffix: utm, headlines: headlines.split('\n').filter(Boolean), descriptions: descriptions.split('\n').filter(Boolean), path1: null, path2: null },
            keywords: keywords
              .split('\n')
              .filter(Boolean)
              .map((text) => ({ text, matchType: 'PHRASE' })),
            lifetimeCap: cap,
          };
    if (platform === 'meta') {
      const page = (conns.data ?? []).find((c) => c.id === connectionId);
      (spec as { creative: { pageId: string } }).creative.pageId = (page as unknown as { externalAccountId?: string })?.externalAccountId ?? '';
    }
    const body = { platform, connectionId, brandId: brandId || null, name, geographies, spec, ...(draft ? { expectedVersion: draft.version } : {}) };
    try {
      if (draft) await api('PUT', `/v1/ads/drafts/${draft.id}`, body);
      else await api('POST', '/v1/ads/drafts', body);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="stack-xs">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="cd-platform">Platform</label>
          <select id="cd-platform" value={platform} onChange={(e) => setPlatform(e.target.value as 'meta' | 'google_ads')} disabled={Boolean(draft)}>
            <option value="meta">Meta (Facebook & Instagram)</option>
            <option value="google_ads">Google Ads (Search)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="cd-conn">Ad account</label>
          <select id="cd-conn" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">Choose</option>
            {accounts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cd-brand">Brand</label>
          <select id="cd-brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">Choose</option>
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cd-name">Campaign name</label>
          <input id="cd-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {platform === 'meta' ? (
          <div className="field">
            <label htmlFor="cd-obj">Objective</label>
            <select id="cd-obj" value={objective} onChange={(e) => setObjective(e.target.value)}>
              {['OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES'].map((o) => (
                <option key={o} value={o}>
                  {o.replace('OUTCOME_', '').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="cd-geo">Countries (ISO codes)</label>
          <input id="cd-geo" value={countries} onChange={(e) => setCountries(e.target.value)} />
        </div>
        {platform === 'google_ads' ? (
          <div className="field">
            <label htmlFor="cd-gtc">Google location ids</label>
            <input id="cd-gtc" value={geoIds} onChange={(e) => setGeoIds(e.target.value)} placeholder="2840 (United States)" />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="cd-cur">Currency (the ad account’s)</label>
          <input id="cd-cur" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        </div>
        <div className="field">
          <label htmlFor="cd-daily">Daily budget</label>
          <input id="cd-daily" type="number" min={1} step="0.01" value={daily} onChange={(e) => setDaily(Number(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="cd-start">Start</label>
          <input id="cd-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cd-end">End</label>
          <input id="cd-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <p className="small">
        Most it can spend: {(daily * n).toFixed(2)} {currency} ({n} day{n === 1 ? '' : 's'} × {daily} {currency}).
      </p>
      <div className="field">
        <label htmlFor="cd-land">Landing page (one of the brand’s destinations)</label>
        <input id="cd-land" value={landing} onChange={(e) => setLanding(e.target.value)} placeholder="https://" />
      </div>
      <div className="field">
        <label htmlFor="cd-utm">Tracking parameters</label>
        <input id="cd-utm" value={utm} onChange={(e) => setUtm(e.target.value)} />
      </div>
      {platform === 'meta' ? (
        <>
          <div className="field">
            <label htmlFor="cd-msg">Primary text</label>
            <textarea id="cd-msg" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cd-head">Headline</label>
            <input id="cd-head" value={headline} onChange={(e) => setHeadline(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cd-img">Image (publish-eligible)</label>
            <select id="cd-img" value={imageId} onChange={(e) => setImageId(e.target.value)}>
              <option value="">Choose</option>
              {images.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="cd-hl">Headlines (3–15, one per line, ≤30 characters)</label>
            <textarea id="cd-hl" rows={3} value={headlines} onChange={(e) => setHeadlines(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cd-ds">Descriptions (2–4, one per line, ≤90 characters)</label>
            <textarea id="cd-ds" rows={2} value={descriptions} onChange={(e) => setDescriptions(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cd-kw">Keywords (one per line)</label>
            <textarea id="cd-kw" rows={3} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          </div>
        </>
      )}
      <ErrorNotice error={error} />
      <button type="button" className="btn primary" disabled={!connectionId || !name || !start || !end} onClick={() => void save()}>
        Save draft and check it
      </button>
    </div>
  );
}

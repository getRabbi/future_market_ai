import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, DataTable, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const BRAND_CALLS = [
  { method: 'GET', path: '/v1/brands' },
  { method: 'POST', path: '/v1/brands' },
  { method: 'GET', path: '/v1/brands/:id' },
  { method: 'POST', path: '/v1/brands/:id/channels' },
  { method: 'POST', path: '/v1/brands/:id/apps' },
  { method: 'POST', path: '/v1/brands/:id/programs' },
  { method: 'GET', path: '/v1/social/platforms' },
  { method: 'GET', path: '/v1/media/providers' },
  { method: 'GET', path: '/v1/connections' },
  { method: 'GET', path: '/v1/content/programs' },
] as const;

interface BrandRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  version: number;
  channels: number;
  apps: number;
  programs: number;
}
interface BrandDetail {
  brand: BrandRow;
  profile: { audience: { countries: string[]; languages: string[] }; objectives: string[]; limits: { maxPostsPerDayPerChannel: number; monthlyAdBudgetUsd: number } };
  channels: { connectionId: string; provider: string; displayName: string; status: string }[];
  apps: { platform: string; appId: string; listingUrl: string }[];
  programs: { id: string; pack: string; status: string }[];
  products: { id: string; name: string }[];
  approvedClaims: { id: string; text: string }[];
}
interface Platform {
  platform: string;
  status: string;
  reasons: string[];
  automatedPublishing: boolean;
  connections: { id: string; displayName: string }[];
  lastVerifiedPostAt: string | null;
  engagement: string;
  analytics: string;
}
interface MediaSource {
  id: string;
  kind: string;
  enabled: boolean;
  reason: string;
  requires: string[];
}
interface Connection {
  id: string;
  provider: string;
  displayName: string;
}
interface Program {
  id: string;
  connectionId: string;
  pack: string;
}

const OBJECTIVES = ['awareness', 'engagement', 'traffic', 'installs', 'activation', 'retention', 'sales', 'leads'] as const;
const PLATFORM_NAME: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', x: 'X', reddit: 'Reddit', youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn' };
const list = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function BrandStudioView({ me }: { me: Me }) {
  const canEdit = ['owner', 'admin', 'growth_operator'].some((r) => me.roles?.includes(r));
  const brands = useApi<BrandRow[]>('/v1/brands');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <section className="card">
        <h2>Brands</h2>
        <p className="small muted">Each brand has its own voice, audience, destinations and limits. A channel account or an app belongs to one brand, so results map to the content that produced them.</p>
        <ErrorNotice error={brands.error} />
        {!brands.data && !brands.error ? <LoadingRows /> : null}
        {brands.data && !brands.data.length ? <EmptyState title="No brand yet">Create one below; existing content programs keep working without a brand.</EmptyState> : null}
        {brands.data?.length ? <DataTable rows={brands.data.map((b) => ({ id: b.id, name: b.name, slug: b.slug, status: b.status, channels: b.channels, apps: b.apps, programs: b.programs }))} columns={['name', 'slug', 'status', 'channels', 'apps', 'programs']} onRowClick={(r) => setOpen(String(r.id))} /> : null}
        {open ? <BrandPanel key={open} id={open} canEdit={canEdit} onChanged={() => void brands.reload()} /> : null}
        {canEdit ? <NewBrand onCreated={(id) => (void brands.reload(), setOpen(id))} /> : null}
      </section>
      <Platforms />
      <MediaSources />
    </>
  );
}

function NewBrand({ onCreated }: { onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: '', slug: '', countries: '', languages: '', objectives: [] as string[], background: '#0F1E45', ink: '#FFFFFF', accent: '#FFC845', onAccent: '#0B3A2F' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await api<{ id: string }>('POST', '/v1/brands', {
        name: form.name,
        slug: form.slug,
        profile: { audience: { countries: list(form.countries).map((c) => c.toUpperCase()), languages: list(form.languages) }, objectives: form.objectives, visual: { palette: { background: form.background, ink: form.ink, accent: form.accent, onAccent: form.onAccent } } },
      });
      onCreated(b.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>Add a brand</summary>
      <ErrorNotice error={error} />
      <div className="form-grid">
        <label>
          Name
          <input value={form.name} onChange={set('name')} maxLength={120} />
        </label>
        <label>
          Short id (lower-case, dashes)
          <input value={form.slug} onChange={set('slug')} maxLength={48} placeholder="eps-topik-bangla" />
        </label>
        <label>
          Countries (ISO codes)
          <input value={form.countries} onChange={set('countries')} placeholder="BD" />
        </label>
        <label>
          Languages
          <input value={form.languages} onChange={set('languages')} placeholder="bn, ko" />
        </label>
        {(['background', 'ink', 'accent', 'onAccent'] as const).map((k) => (
          <label key={k}>
            {k === 'onAccent' ? 'Text on accent' : k[0]!.toUpperCase() + k.slice(1)} colour
            <input type="color" value={form[k]} onChange={set(k)} />
          </label>
        ))}
      </div>
      <fieldset className="field group">
        <legend>Objectives</legend>
        {OBJECTIVES.map((o) => (
          <label key={o} className="check">
            <input type="checkbox" checked={form.objectives.includes(o)} onChange={(e) => setForm({ ...form, objectives: e.target.checked ? [...form.objectives, o] : form.objectives.filter((x) => x !== o) })} /> {o}
          </label>
        ))}
      </fieldset>
      <p className="small muted">Text colours must reach 4.5:1 contrast; paid budget starts at $0 and posting at one post per channel per day.</p>
      <button type="button" className="btn primary" disabled={busy || !form.name || !form.slug} onClick={() => void submit()}>
        Create brand
      </button>
    </details>
  );
}

function BrandPanel({ id, canEdit, onChanged }: { id: string; canEdit: boolean; onChanged: () => void }) {
  const detail = useApi<BrandDetail>(`/v1/brands/${id}`);
  const conns = useApi<Connection[]>('/v1/connections');
  const programs = useApi<Program[]>('/v1/content/programs');
  const [error, setError] = useState<unknown>(null);
  const [connectionId, setConnectionId] = useState('');
  const [listing, setListing] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await detail.reload();
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return <LoadingRows />;
  const d = detail.data;
  const linked = new Set(d.channels.map((c) => c.connectionId));
  const assignable = (programs.data ?? []).filter((p) => linked.has(p.connectionId) && !d.programs.some((x) => x.id === p.id));
  return (
    <div className="card nested">
      <h3>
        {d.brand.name} <Badge value={d.brand.status} />
      </h3>
      <p className="small muted">
        Audience {d.profile.audience.countries.join(', ') || 'not set'} · languages {d.profile.audience.languages.join(', ') || 'not set'} · objectives {d.profile.objectives.join(', ') || 'not set'} · up to {d.profile.limits.maxPostsPerDayPerChannel} post(s) per channel per day · paid budget $
        {d.profile.limits.monthlyAdBudgetUsd}/month
      </p>
      <ErrorNotice error={error} />
      <DataTable rows={d.channels.map((c) => ({ account: c.displayName, provider: c.provider, status: c.status }))} columns={['account', 'provider', 'status']} empty="No channel account linked." />
      <DataTable rows={d.apps.map((a) => ({ app: a.appId, platform: a.platform, listing: a.listingUrl }))} columns={['app', 'platform', 'listing']} empty="No application linked." />
      <p className="small muted">
        {d.programs.length} content program(s) · {d.products.length} product fact(s) · {d.approvedClaims.length} approved claim(s)
      </p>
      {canEdit ? (
        <div className="form-grid">
          <label>
            Link a channel account
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">Choose…</option>
              {(conns.data ?? [])
                .filter((c) => !linked.has(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.provider})
                  </option>
                ))}
            </select>
            <button type="button" className="btn" disabled={!connectionId} onClick={() => void run(() => api('POST', `/v1/brands/${id}/channels`, { connectionId }))}>
              Link
            </button>
          </label>
          <label>
            Link a store listing
            <input value={listing} onChange={(e) => setListing(e.target.value)} placeholder="https://play.google.com/store/apps/details?id=…" />
            <button type="button" className="btn" disabled={!listing} onClick={() => void run(() => api('POST', `/v1/brands/${id}/apps`, { platform: listing.includes('apps.apple.com') ? 'ios' : 'android', listingUrl: listing.trim() }))}>
              Link app
            </button>
          </label>
          {assignable.map((p) => (
            <button key={p.id} type="button" className="btn" onClick={() => void run(() => api('POST', `/v1/brands/${id}/programs`, { programId: p.id }))}>
              Assign the {p.pack} program
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Platforms() {
  const p = useApi<Platform[]>('/v1/social/platforms');
  return (
    <section className="card">
      <h2>Platforms</h2>
      <p className="small muted">What each platform can really do for this organization now. “Live, verified” needs a post confirmed by read-back in the last 14 days.</p>
      <ErrorNotice error={p.error} />
      {!p.data && !p.error ? <LoadingRows /> : null}
      {p.data ? (
        <ul className="tight">
          {p.data.map((x) => (
            <li key={x.platform}>
              <strong>{PLATFORM_NAME[x.platform] ?? x.platform}</strong> <Badge value={x.status} /> {x.automatedPublishing ? <span className="small">automated publishing available</span> : <span className="small muted">no automated publishing</span>}
              <div className="small muted">
                {x.reasons.join(' ')} {x.lastVerifiedPostAt ? `Last verified post ${relativeTime(x.lastVerifiedPostAt)}.` : ''}
              </div>
              <div className="small muted">
                Engagement: {x.engagement} Analytics: {x.analytics}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function MediaSources() {
  const m = useApi<MediaSource[]>('/v1/media/providers');
  return (
    <section className="card">
      <h2>Image sources</h2>
      <p className="small muted">Every image passes the same checks (licence, size and aspect, content hash, provenance). Sources without credentials and a rights record stay off; the branded templates are always available.</p>
      <ErrorNotice error={m.error} />
      {!m.data && !m.error ? <LoadingRows /> : null}
      {m.data ? <DataTable rows={m.data.map((s) => ({ source: s.id, enabled: s.enabled ? 'on' : 'off', why: s.reason, needs: s.requires.join('; ') || '—' }))} columns={['source', 'enabled', 'why', 'needs']} /> : null}
    </section>
  );
}

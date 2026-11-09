import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const UNIVERSAL_CALLS = [
  { method: 'GET', path: '/v1/studio/programs' },
  { method: 'PUT', path: '/v1/content/programs' },
  { method: 'GET', path: '/v1/studio/programs/:id/items' },
  { method: 'GET', path: '/v1/studio/programs/:id/insights' },
  { method: 'GET', path: '/v1/studio/programs/:id/research' },
  { method: 'POST', path: '/v1/studio/programs/:id/ideas/generate' },
  { method: 'POST', path: '/v1/studio/programs/:id/ideas' },
  { method: 'POST', path: '/v1/studio/programs/:id/sync' },
  { method: 'GET', path: '/v1/studio/items/:id/preview' },
  { method: 'POST', path: '/v1/studio/items/:id/brief' },
  { method: 'POST', path: '/v1/studio/items/:id/draft' },
  { method: 'POST', path: '/v1/studio/items/:id/validate' },
  { method: 'POST', path: '/v1/studio/items/:id/approve' },
  { method: 'POST', path: '/v1/studio/items/:id/reject' },
  { method: 'POST', path: '/v1/studio/items/:id/schedule' },
  { method: 'GET', path: '/v1/brands' },
  { method: 'GET', path: '/v1/brands/:id' },
  { method: 'GET', path: '/v1/assets' },
] as const;

const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok'] as const;
const OBJECTIVES = ['awareness', 'engagement', 'traffic', 'installs', 'activation', 'retention', 'sales', 'leads'] as const;
/** The pipeline in reading order; stages are only changed by the server. */
const COLUMNS: { title: string; stages: string[]; help: string }[] = [
  { title: 'Ideas', stages: ['idea'], help: 'Proposed by you or the AI from approved claims and evidence.' },
  { title: 'Briefs', stages: ['brief'], help: 'Objective, audience, key message, approved claims and a tagged link.' },
  { title: 'Drafts', stages: ['draft'], help: 'Written by you or drafted by the AI; validate to check claims, brand rules and platform limits.' },
  { title: 'Ready for approval', stages: ['validated'], help: 'Passed validation. Someone other than the author approves.' },
  { title: 'Approved', stages: ['approved'], help: 'Schedule it; publishing still goes through your publishing policy.' },
  { title: 'Scheduled & publishing', stages: ['scheduled', 'published'], help: 'Counts as published only after the platform confirms it by read-back.' },
  { title: 'Verified & measured', stages: ['verified', 'measured', 'learned'], help: 'Results are read from the platform; missing results stay unknown, never zero.' },
  { title: 'Stopped', stages: ['rejected', 'failed'], help: 'Rejected by a reviewer, or the post failed. Rework from the brief.' },
];

interface GeneralProgram {
  id: string;
  name: string | null;
  brandId: string;
  connectionId: string;
  status: string;
  settings: { campaign?: string; campaignIdentity?: string };
  plan: { language: string; objective: string; platforms: string[]; pillars: { key: string; name: string; description: string }[]; postsPerWeek: number; destinationUrl: string | null; cta: string };
  stages: Record<string, number>;
}
interface Item {
  id: string;
  stage: string;
  pillar: string;
  platform: string;
  title: string;
  origin: 'ai' | 'manual';
  idea: { angle?: string; hook?: string };
  brief: { keyMessage?: string; destination?: string | null; claims?: { id: string; text: string }[] };
  draft: { text?: string; origin?: string; assetIds?: string[] };
  validation: { passed?: boolean; problems?: string[]; warnings?: string[] };
  campaign: string | null;
  scheduledAt: string | null;
  statusReason: string | null;
  metrics: { url?: string; engagement?: number };
  version: number;
  updatedAt: string;
}
interface Insight {
  pillar: string;
  posts: number;
  meanEngagement: number | null;
  sufficient: boolean;
  note: string;
}
interface BrandRow {
  id: string;
  name: string;
  slug: string;
}
interface BrandDetail {
  brand: BrandRow;
  profile: { destinations?: { kind: string; url: string; label?: string }[]; audience?: { description?: string } };
  channels: { connectionId: string; provider: string; displayName: string; status: string }[];
}

/**
 * Universal Content Studio (P3-01): content programs for any brand. One board per program shows
 * every item in its real pipeline stage; each button calls the server, which enforces the stage
 * order, grounding, validation, four-eyes approval and publishing through the execution gateway.
 */
export function UniversalStudio({ me }: { me: Me }) {
  const programs = useApi<GeneralProgram[]>('/v1/studio/programs');
  const brands = useApi<BrandRow[]>('/v1/brands');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canEdit = me.roles.some((r) => r === 'owner' || r === 'admin' || r === 'growth_operator');
  if (programs.error) return <ErrorNotice error={programs.error} />;
  if (!programs.data) return <LoadingRows label="Loading brand programs…" />;
  const program = programs.data.find((p) => p.id === sel) ?? programs.data[0];
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? 'Brand';
  return (
    <div className="stack">
      <section className="card">
        <header className="card-head">
          <h2 className="card-title">Brand programs</h2>
          {canEdit ? (
            <button type="button" className="btn" onClick={() => setCreating(!creating)}>
              {creating ? 'Close' : 'New brand program'}
            </button>
          ) : null}
        </header>
        <p className="small muted">For any business: pick a brand, its channels and content pillars. Ideas and drafts use only the brand’s approved claims; every post is validated, approved by a second person and published through your publishing policy.</p>
        {creating ? (
          <ProgramForm
            onDone={() => {
              setCreating(false);
              void programs.reload();
            }}
          />
        ) : null}
        {programs.data.length ? (
          <div className="field">
            <label htmlFor="us-program">Program</label>
            <select id="us-program" value={program?.id ?? ''} onChange={(e) => setSel(e.target.value)}>
              {programs.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {brandName(p.brandId)} · {p.name ?? 'Program'} ({p.status})
                </option>
              ))}
            </select>
          </div>
        ) : !creating ? (
          <EmptyState title="No brand program yet">Create a brand in Channels › Brands, link its channel accounts, then start a program here.</EmptyState>
        ) : null}
      </section>
      {program ? <ProgramBoard key={program.id} program={program} canEdit={canEdit} onChange={() => void programs.reload()} /> : null}
    </div>
  );
}

function ProgramForm({ onDone }: { onDone: () => void }) {
  const brands = useApi<BrandRow[]>('/v1/brands');
  const [brandId, setBrandId] = useState('');
  const detail = useApi<BrandDetail>(brandId ? `/v1/brands/${brandId}` : null);
  const [connectionId, setConnectionId] = useState('');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('en');
  const [objective, setObjective] = useState<string>('engagement');
  const [audience, setAudience] = useState('');
  const [pillars, setPillars] = useState('how_to | How-to | Practical tips\nproduct | Product facts | What the product really does');
  const [platforms, setPlatforms] = useState<string[]>(['facebook']);
  const [postsPerWeek, setPostsPerWeek] = useState(3);
  const [destinationUrl, setDestinationUrl] = useState('');
  const [cta, setCta] = useState('');
  const [campaign, setCampaign] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const parsed = pillars
        .split('\n')
        .map((l) => l.split('|').map((x) => x.trim()))
        .filter((p) => p[0])
        .map(([key, n, description]) => ({ key: key!, name: n || key!, description: description ?? '' }));
      await api('PUT', '/v1/content/programs', {
        kind: 'general',
        brandId,
        connectionId,
        name,
        plan: { language, objective, audience, pillars: parsed, platforms, postsPerWeek, destinationUrl: destinationUrl || null, cta, hashtags: [] },
        settings: campaign ? { campaign, campaignIdentity: 'per_post' } : { campaignIdentity: 'per_post' },
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-xs">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pf-brand">Brand</label>
          <select id="pf-brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">Choose a brand</option>
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pf-channel">Main channel</label>
          <select id="pf-channel" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} disabled={!detail.data}>
            <option value="">Choose a linked account</option>
            {(detail.data?.channels ?? []).map((c) => (
              <option key={c.connectionId} value={c.connectionId}>
                {c.displayName} ({c.provider})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pf-name">Program name</label>
          <input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly tips" />
        </div>
        <div className="field">
          <label htmlFor="pf-lang">Language</label>
          <input id="pf-lang" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en, bn, ko…" />
        </div>
        <div className="field">
          <label htmlFor="pf-obj">Objective</label>
          <select id="pf-obj" value={objective} onChange={(e) => setObjective(e.target.value)}>
            {OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pf-ppw">Posts per week</label>
          <input id="pf-ppw" type="number" min={1} max={14} value={postsPerWeek} onChange={(e) => setPostsPerWeek(Number(e.target.value))} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pf-aud">Audience</label>
        <textarea id="pf-aud" rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder={detail.data?.profile.audience?.description ?? 'Who the posts are for'} />
      </div>
      <div className="field">
        <label htmlFor="pf-pillars">Content pillars (one per line: key | name | description)</label>
        <textarea id="pf-pillars" rows={4} value={pillars} onChange={(e) => setPillars(e.target.value)} />
      </div>
      <fieldset className="field">
        <legend>Platforms (the brand needs a linked account for each)</legend>
        <div className="choice-chips">
          {PLATFORMS.map((p) => (
            <label key={p} className="chip-check">
              <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => setPlatforms(e.target.checked ? [...platforms, p] : platforms.filter((x) => x !== p))} /> {p}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pf-dest">Link destination (optional)</label>
          <select id="pf-dest" value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)}>
            <option value="">No link</option>
            {(detail.data?.profile.destinations ?? [])
              .filter((d) => d.url.startsWith('https://'))
              .map((d) => (
                <option key={d.url} value={d.url}>
                  {d.label ?? d.url}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pf-cta">Call to action</label>
          <input id="pf-cta" value={cta} onChange={(e) => setCta(e.target.value)} placeholder="See this week’s offer" />
        </div>
        <div className="field">
          <label htmlFor="pf-camp">Campaign name (optional)</label>
          <input id="pf-camp" value={campaign} onChange={(e) => setCampaign(e.target.value.toLowerCase())} placeholder="chosen for you if empty" />
        </div>
      </div>
      <p className="small muted">Each post gets its own campaign tag derived from the program’s campaign, so results of different programs and brands never mix.</p>
      <ErrorNotice error={error} />
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={busy || !brandId || !connectionId || !name || !platforms.length} onClick={() => void save()}>
          Create program
        </button>
      </div>
    </div>
  );
}

function ProgramBoard({ program, canEdit, onChange }: { program: GeneralProgram; canEdit: boolean; onChange: () => void }) {
  const items = useApi<Item[]>(`/v1/studio/programs/${program.id}/items`);
  const insights = useApi<Insight[]>(`/v1/studio/programs/${program.id}/insights`);
  const research = useApi<{ claims: { id: string; text: string }[]; evidence: { id: string; summary: string }[] }>(`/v1/studio/programs/${program.id}/research`);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const reload = async () => {
    await items.reload();
    await insights.reload();
    onChange();
  };
  const run = async (key: string, fn: () => Promise<unknown>, done?: (r: unknown) => string | null) => {
    setError(null);
    setNote(null);
    setBusy(key);
    try {
      const r = await fn();
      setNote(done ? done(r) : null);
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const generate = () =>
    run(
      'generate',
      () => api('POST', `/v1/studio/programs/${program.id}/ideas/generate`, { count: 5 }),
      (r) => {
        const o = r as { status: string; reason?: string; items?: unknown[]; dropped?: { title: string; reason: string }[] };
        if (o.status !== 'created') return `No AI ideas: ${o.reason}. You can add ideas yourself.`;
        return `${o.items?.length ?? 0} idea(s) added${o.dropped?.length ? `; ${o.dropped.length} dropped (${o.dropped.map((d) => d.reason).join('; ')})` : ''}.`;
      },
    );
  return (
    <div className="stack">
      <section className="card">
        <header className="card-head">
          <h2 className="card-title">{program.name}</h2>
          <span className="small muted">
            campaign <code>{program.settings.campaign}</code> · {program.plan.platforms.join(', ')} · {program.plan.postsPerWeek}/week · {program.plan.language}
          </span>
        </header>
        <p className="small">
          Pillars: {program.plan.pillars.map((p) => p.name).join(' · ')}. Grounded in {research.data?.claims.length ?? 0} approved claim(s) and {research.data?.evidence.length ?? 0} evidence record(s).
        </p>
        {research.data && !research.data.claims.length ? <p className="notice small">This brand has no approved product claims yet, so posts cannot state product facts. Add claims in Knowledge & claims.</p> : null}
        {canEdit ? (
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={busy !== null || program.status !== 'active'} onClick={() => void generate()}>
              Suggest ideas with AI
            </button>
            <button type="button" className="btn" onClick={() => setManual(!manual)}>
              {manual ? 'Close' : 'Add an idea'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'sync',
                  () => api('POST', `/v1/studio/programs/${program.id}/sync`),
                  (r) => `Checked posts: ${JSON.stringify(r)}`,
                )
              }
            >
              Check published posts
            </button>
          </div>
        ) : null}
        {manual ? <ManualIdea program={program} onDone={() => void reload().then(() => setManual(false))} /> : null}
        {note ? <p className="small">{note}</p> : null}
        <ErrorNotice error={error} />
      </section>
      {items.error ? <ErrorNotice error={items.error} /> : null}
      {!items.data ? (
        <LoadingRows />
      ) : (
        <div className="grid-2">
          {COLUMNS.map((col) => {
            const rows = items.data!.filter((i) => col.stages.includes(i.stage));
            return (
              <section key={col.title} className="card" aria-label={col.title}>
                <header className="card-head">
                  <h3 className="card-title">
                    {col.title} <span className="small muted">({rows.length})</span>
                  </h3>
                </header>
                <p className="small muted">{col.help}</p>
                {rows.length ? (
                  <ul className="row-list">
                    {rows.map((i) => (
                      <ItemCard key={i.id} item={i} canEdit={canEdit} busy={busy} run={run} />
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">Nothing here.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
      <section className="card">
        <header className="card-head">
          <h3 className="card-title">What past posts did</h3>
        </header>
        {insights.data?.length ? (
          <ul className="small">
            {insights.data.map((i) => (
              <li key={i.pillar}>
                <strong>{program.plan.pillars.find((p) => p.key === i.pillar)?.name ?? i.pillar}</strong>: {i.posts} measured post(s){i.meanEngagement === null ? '' : `, average engagement ${i.meanEngagement.toFixed(1)}`} — {i.note}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No measured posts yet. Results appear a few days after a post is verified, when the platform reports them.</p>
        )}
      </section>
    </div>
  );
}

function ManualIdea({ program, onDone }: { program: GeneralProgram; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [angle, setAngle] = useState('');
  const [pillar, setPillar] = useState(program.plan.pillars[0]?.key ?? '');
  const [platform, setPlatform] = useState(program.plan.platforms[0] ?? 'facebook');
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    try {
      await api('POST', `/v1/studio/programs/${program.id}/ideas`, { title, angle, pillar, platform });
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="stack-xs">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="mi-title">Title</label>
          <input id="mi-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="mi-pillar">Pillar</label>
          <select id="mi-pillar" value={pillar} onChange={(e) => setPillar(e.target.value)}>
            {program.plan.pillars.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mi-platform">Platform</label>
          <select id="mi-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {program.plan.platforms.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="mi-angle">What the post says and why it matters</label>
        <textarea id="mi-angle" rows={2} value={angle} onChange={(e) => setAngle(e.target.value)} />
      </div>
      <ErrorNotice error={error} />
      <button type="button" className="btn primary" disabled={!title || angle.length < 10} onClick={() => void save()}>
        Add idea
      </button>
    </div>
  );
}

function ItemCard({ item, canEdit, busy, run }: { item: Item; canEdit: boolean; busy: string | null; run: (key: string, fn: () => Promise<unknown>, done?: (r: unknown) => string | null) => Promise<void> }) {
  const [caption, setCaption] = useState('');
  const [writing, setWriting] = useState(false);
  const [media, setMedia] = useState<string[]>(item.draft.assetIds ?? []);
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  const k = (a: string) => `${a}:${item.id}`;
  const disabled = busy !== null;
  return (
    <li className="row-item">
      <div className="row">
        <div>
          <strong>{item.title}</strong>
          <div className="small muted">
            {item.platform} · {item.pillar} · {item.origin === 'ai' ? 'AI idea' : 'your idea'} · {relativeTime(item.updatedAt)}
          </div>
        </div>
        <Badge value={item.stage} />
      </div>
      {item.idea.angle && item.stage === 'idea' ? <p className="small">{item.idea.angle}</p> : null}
      {item.brief.keyMessage && item.stage === 'brief' ? (
        <p className="small">
          {item.brief.keyMessage}
          {item.brief.claims?.length ? ` · claims: ${item.brief.claims.map((c) => `“${c.text}”`).join(', ')}` : ''}
        </p>
      ) : null}
      {item.draft.text ? <pre className="studio-caption small">{item.draft.text}</pre> : null}
      {item.draft.assetIds?.length ? (
        <p className="small muted">
          {item.draft.assetIds.length} media file{item.draft.assetIds.length === 1 ? '' : 's'} attached{item.platform === 'instagram' && item.draft.assetIds.length > 1 ? ' (published as one carousel)' : ''}
        </p>
      ) : null}
      {item.validation.problems?.length ? (
        <ul className="small findings">
          {item.validation.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {item.statusReason ? <p className="small muted">{item.statusReason}</p> : null}
      {item.metrics.url ? (
        <a className="small" href={item.metrics.url} target="_blank" rel="noreferrer noopener">
          View the verified post
        </a>
      ) : null}
      {canEdit ? (
        <div className="row-actions">
          {item.stage === 'idea' || item.stage === 'rejected' ? (
            <button type="button" className="small-btn" disabled={disabled} onClick={() => void run(k('brief'), () => api('POST', `/v1/studio/items/${item.id}/brief`, {}))}>
              Write brief
            </button>
          ) : null}
          {['brief', 'draft', 'validated', 'approved'].includes(item.stage) ? (
            <>
              <button type="button" className="small-btn" disabled={disabled} onClick={() => void run(k('ai'), () => api('POST', `/v1/studio/items/${item.id}/draft`, { assetIds: item.draft.assetIds ?? [] }))}>
                Draft with AI
              </button>
              <button type="button" className="small-btn" onClick={() => setWriting(!writing)}>
                {item.draft.text ? 'Edit caption & media' : 'Write caption'}
              </button>
            </>
          ) : null}
          {item.stage === 'draft' ? (
            <button type="button" className="small-btn" disabled={disabled} onClick={() => void run(k('validate'), () => api('POST', `/v1/studio/items/${item.id}/validate`))}>
              Validate
            </button>
          ) : null}
          {item.stage === 'validated' ? (
            <button type="button" className="small-btn" disabled={disabled} onClick={() => void run(k('approve'), () => api('POST', `/v1/studio/items/${item.id}/approve`))}>
              Approve
            </button>
          ) : null}
          {item.stage === 'approved' ? (
            <>
              <input aria-label="Publish at" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              <button type="button" className="small-btn" disabled={disabled || !when} onClick={() => void run(k('schedule'), () => api('POST', `/v1/studio/items/${item.id}/schedule`, { scheduledAt: new Date(when).toISOString() }))}>
                Schedule
              </button>
            </>
          ) : null}
          {['idea', 'brief', 'draft', 'validated', 'approved', 'failed'].includes(item.stage) ? (
            <>
              <input aria-label="Reason" placeholder="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="small-btn" disabled={disabled || reason.length < 3} onClick={() => void run(k('reject'), () => api('POST', `/v1/studio/items/${item.id}/reject`, { reason }))}>
                Reject
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {writing ? (
        <div className="stack-xs">
          <textarea aria-label="Caption" rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="The call to action, link and hashtags are added from the brief." />
          <MediaPicker platform={item.platform} value={media} onChange={setMedia} />
          <button
            type="button"
            className="small-btn"
            disabled={disabled || !caption.trim()}
            onClick={() =>
              void run(k('write'), async () => {
                await api('POST', `/v1/studio/items/${item.id}/draft`, { caption, assetIds: media, expectedVersion: item.version });
                setWriting(false);
              })
            }
          >
            Save draft
          </button>
        </div>
      ) : null}
    </li>
  );
}

const MEDIA_HINT: Record<string, string> = {
  facebook: 'Up to 10 images (a photo post cannot also carry a link preview).',
  instagram: 'One image or video, or 2–10 for a carousel.',
  tiktok: 'Exactly one video.',
  youtube: 'Exactly one video.',
  linkedin: 'Images are optional.',
  x: 'Up to 4 images.',
};

/**
 * Publish-eligible images and videos (rights recorded, not revoked) for a Studio draft, including
 * licensed stock and rendered Video Studio files. Platform limits are checked again at validation.
 */
function MediaPicker({ platform, value, onChange }: { platform: string; value: string[]; onChange: (ids: string[]) => void }) {
  const list = useApi<{ id: string; kind: string; title: string; publishEligible: boolean; origin?: string }[]>('/v1/assets');
  const usable = (list.data ?? []).filter((a) => a.publishEligible && (a.kind === 'image' || a.kind === 'video'));
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id].slice(0, 10) : value.filter((x) => x !== id));
  return (
    <fieldset className="stack-xs">
      <legend className="small">
        Media ({value.length} selected) — {MEDIA_HINT[platform] ?? 'Optional.'}
      </legend>
      {list.error ? <ErrorNotice error={list.error} /> : null}
      {!list.data ? (
        <LoadingRows label="Loading media…" />
      ) : usable.length ? (
        <div className="pick-list">
          {usable.map((a) => (
            <label key={a.id} className="small">
              <input type="checkbox" checked={value.includes(a.id)} disabled={!value.includes(a.id) && value.length >= 10} onChange={(e) => toggle(a.id, e.target.checked)} /> {a.title}{' '}
              <span className="muted">
                ({a.kind}
                {a.origin && a.origin !== 'upload' ? `, ${a.origin}` : ''})
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="small muted">
          No publish-eligible media yet. Upload or render media with rights recorded in <a href="/app/assets">Asset studio</a>.
        </p>
      )}
    </fieldset>
  );
}

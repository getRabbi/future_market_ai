import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { readableText, relativeTime } from '../lib/format.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const CONTENT_CALLS = [
  { method: 'GET', path: '/v1/content/packs' },
  { method: 'GET', path: '/v1/content/programs' },
  { method: 'PUT', path: '/v1/content/programs' },
  { method: 'GET', path: '/v1/content/programs/:id/overview' },
  { method: 'GET', path: '/v1/content/plan-items/:id/preview' },
  { method: 'GET', path: '/v1/content/community/groups' },
  { method: 'POST', path: '/v1/content/community/groups' },
  { method: 'PATCH', path: '/v1/content/community/groups/:id' },
  { method: 'POST', path: '/v1/content/community/groups/:id/share-kit' },
  { method: 'GET', path: '/v1/content/community/shares' },
  { method: 'POST', path: '/v1/content/community/shares/:id/confirm' },
  { method: 'GET', path: '/v1/connections' },
] as const;

interface Pack {
  id: string;
  title: string;
  version: string;
  units: number;
  vocabulary: number;
  letters: number;
  grammar: number;
}
export interface Program {
  id: string;
  connectionId: string;
  pack: string;
  status: 'active' | 'paused';
  settings: { appCtaPerWeek?: number; linkPerWeek?: number; campaign?: string };
}
export interface PlanItem {
  id: string;
  day: string;
  kind: string;
  objective: string;
  segment: string;
  template: string;
  palette: string;
  rationale: string;
  status: string;
  statusReason: string | null;
  postId: string | null;
  engagement: number | null;
  learningEligible: boolean;
  metrics: { reactions?: number | null; comments?: number | null; shares?: number | null; url?: string | null; observedAt?: string };
  unit: { korean: string } | null;
}
export interface StudioOverview {
  program: Program;
  today: string;
  calendar: PlanItem[];
  history: PlanItem[];
  learning: { measuredPosts: number; phase: string; notes: string[] };
  planNotes: string[];
  measurement: { publishedPosts: number; measuredPosts: number; linkPosts: number; notes: string[] };
}
interface Group {
  id: string;
  url: string;
  name: string;
  audience: string;
  permission: string;
  status: string;
  relevance: number;
  relevanceNotes: string;
  lastSharedAt: string | null;
}
interface Share {
  id: string;
  groupId: string;
  kind: string;
  caption: string;
  status: string;
  createdAt: string;
}

export const KIND: Record<string, string> = { vocab: 'Word', hangul: 'Hangul', grammar: 'Grammar', quiz: 'Review quiz', mistake: 'Common mistake', dialogue: 'Conversation', reading: 'Notice reading', challenge: 'Weekly challenge', feature: 'App capability' };
export const OBJECTIVE: Record<string, string> = { EDUCATE: 'Teach', ENGAGE: 'Ask for answers', DISCOVER: 'Mention the app', VISIT_APP: 'Store link', INSTALL_APP: 'Install', RETAIN: 'Return' };
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Content studio (D-040): the Page's daily lesson posts, their cards and results, and the community workspace. */
export function ContentStudioView({ me }: { me: Me }) {
  const programs = useApi<Program[]>('/v1/content/programs');
  const [sel, setSel] = useState<string | null>(null);
  if (programs.error) return <ErrorNotice error={programs.error} />;
  if (!programs.data) return <LoadingRows label="Loading the content studio…" />;
  const program = programs.data.find((p) => p.id === sel) ?? programs.data[0];
  return (
    <div className="stack">
      {program ? <ProgramView program={program} onChange={() => void programs.reload()} me={me} /> : <EnableProgram onDone={() => void programs.reload()} />}
      {programs.data.length > 1 ? (
        <div className="field">
          <label htmlFor="cs-program">Page</label>
          <select id="cs-program" value={program?.id ?? ''} onChange={(e) => setSel(e.target.value)}>
            {programs.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.pack} · {p.connectionId.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <CommunityView />
    </div>
  );
}

function EnableProgram({ onDone }: { onDone: () => void }) {
  const packs = useApi<Pack[]>('/v1/content/packs');
  const conns = useApi<{ id: string; provider: string; displayName: string; status: string }[]>('/v1/connections');
  const [error, setError] = useState<unknown>(null);
  const pages = (conns.data ?? []).filter((c) => c.provider === 'meta' && c.status === 'active');
  const enable = async (connectionId: string, pack: string) => {
    setError(null);
    try {
      await api('PUT', '/v1/content/programs', { connectionId, pack });
      onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card">
      <header>
        <h2>Daily lessons for your Facebook Page</h2>
      </header>
      <p className="small">The studio plans seven days of lesson posts from a verified lesson bank, draws a branded card for each and lets the Autopilot publish one a day under your publishing policy. Korean on posts and cards always comes from the bank, never from an AI model.</p>
      <ErrorNotice error={error} />
      {!pages.length ? (
        <EmptyState title="No Facebook Page connected">Connect your Page in Connections first.</EmptyState>
      ) : (
        <ul className="tight">
          {(packs.data ?? []).flatMap((p) =>
            pages.map((c) => (
              <li key={`${p.id}:${c.id}`}>
                <strong>{c.displayName}</strong> — {p.title} ({p.vocabulary} words, {p.letters} Hangul letters, {p.grammar} grammar points, {p.units} lessons in all){' '}
                <button type="button" className="btn primary" onClick={() => void enable(c.id, p.id)}>
                  Start daily lessons
                </button>
              </li>
            )),
          )}
        </ul>
      )}
    </section>
  );
}

function ProgramView({ program, onChange, me }: { program: Program; onChange: () => void; me: Me }) {
  const ov = useApi<StudioOverview>(`/v1/content/programs/${program.id}/overview`);
  const [preview, setPreview] = useState<{ id: string; image?: string; caption?: string | null; error?: unknown } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const toggle = async () => {
    setError(null);
    try {
      await api('PUT', '/v1/content/programs', { connectionId: program.connectionId, pack: program.pack, status: program.status === 'active' ? 'paused' : 'active', settings: program.settings });
      onChange();
    } catch (err) {
      setError(err);
    }
  };
  const show = async (id: string) => {
    setPreview({ id });
    try {
      const p = await api<{ image: string; caption: string | null }>('GET', `/v1/content/plan-items/${id}/preview`);
      setPreview({ id, image: p.image, caption: p.caption });
    } catch (err) {
      setPreview({ id, error: err });
    }
  };
  if (ov.error) return <ErrorNotice error={ov.error} />;
  if (!ov.data) return <LoadingRows label="Planning the next seven days…" />;
  const o = ov.data;
  const canEdit = ['owner', 'admin', 'growth_operator'].some((r) => me.roles?.includes(r));
  return (
    <>
      <section className="card">
        <header>
          <h2>Next seven days</h2>
          <span className="small muted">
            {program.pack} · <Badge value={program.status} />{' '}
            {canEdit ? (
              <button type="button" className="btn" onClick={() => void toggle()}>
                {program.status === 'active' ? 'Pause lessons' : 'Resume lessons'}
              </button>
            ) : null}
          </span>
        </header>
        <ErrorNotice error={error} />
        <p className="small muted">Image source: branded lesson templates with licensed Korean and Bangla fonts. The studio uses these templates while no approved image provider is configured.</p>
        <div className="studio-grid">
          {o.calendar.map((i) => (
            <article key={i.id} className="studio-day">
              <div className="small muted">
                {day(i.day)}
                {i.day === o.today ? ' · today' : ''}
              </div>
              <strong>{KIND[i.kind] ?? i.kind}</strong>
              {i.unit ? <div lang="ko">{i.unit.korean}</div> : null}
              <div className="small">
                {OBJECTIVE[i.objective] ?? i.objective} · <Badge value={i.status} />
              </div>
              <p className="small muted">{i.rationale}</p>
              <button type="button" className="btn" onClick={() => void show(i.id)}>
                Preview card
              </button>
            </article>
          ))}
        </div>
        {preview ? (
          <div className="studio-preview">
            {preview.error ? <ErrorNotice error={preview.error} /> : null}
            {!preview.image && !preview.error ? <LoadingRows label="Rendering the card…" /> : null}
            {preview.image ? <img src={preview.image} alt="Card preview" width={360} height={450} /> : null}
            {preview.caption ? <pre className="studio-caption">{preview.caption}</pre> : null}
          </div>
        ) : null}
        {o.planNotes.length ? (
          <ul className="tight small">
            {o.planNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <section className="card">
        <header>
          <h2>Published lessons and what they achieved</h2>
          <span className="small muted">
            {o.measurement.publishedPosts} published · {o.measurement.measuredPosts} comparable observations
          </span>
        </header>
        {o.history.length ? (
          <ul className="tight small">
            {o.history.slice(0, 14).map((i) => (
              <li key={i.id}>
                {day(i.day)} — {KIND[i.kind] ?? i.kind} {i.unit ? <span lang="ko">{i.unit.korean}</span> : null} · <Badge value={i.status} />
                {i.metrics.url ? (
                  <>
                    {' '}
                    ·{' '}
                    <a href={i.metrics.url} target="_blank" rel="noreferrer">
                      post
                    </a>
                  </>
                ) : null}
                {i.metrics.observedAt
                  ? ` · reactions ${i.metrics.reactions ?? 'unavailable'}, comments ${i.metrics.comments ?? 'unavailable'}, shares ${i.metrics.shares ?? 'unavailable'} (read ${relativeTime(i.metrics.observedAt)}) · ${i.engagement === null ? 'score unavailable' : i.learningEligible ? 'comparable score' : 'provisional score'}`
                  : i.status === 'published'
                    ? ' · awaiting measurement'
                    : ''}
                {i.statusReason ? <span className="muted"> · {readableText(i.statusReason)}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing published yet">The first lesson goes out in the goal's next cycle.</EmptyState>
        )}
        <ul className="tight small muted">
          {[...o.learning.notes, ...o.measurement.notes].map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

const PERMISSIONS: { key: string; label: string }[] = [
  { key: 'unknown', label: 'Not sure yet' },
  { key: 'members_may_post', label: 'Members may post' },
  { key: 'admin_approval', label: 'Posts need admin approval' },
  { key: 'admin_only', label: 'Only admins post' },
  { key: 'owned', label: 'Our own group' },
];

function CommunityView() {
  const groups = useApi<Group[]>('/v1/content/community/groups');
  const shares = useApi<Share[]>('/v1/content/community/shares');
  const [form, setForm] = useState({ url: '', name: '', audience: '', rules: '', permission: 'unknown' });
  const [error, setError] = useState<unknown>(null);
  const [kit, setKit] = useState<{ groupId: string; planItemId: string }>({ groupId: '', planItemId: '' });
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([groups.reload(), shares.reload()]);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card">
      <header>
        <h2>Community groups</h2>
        <span className="small muted">You share; FUTUREGROW never posts to or joins groups</span>
      </header>
      <p className="small">
        Meta removed group publishing for apps in 2024, so lessons reach groups only when you share them where the group's rules allow. List the groups here; the studio ranks them by topic, prepares a share kit (lesson text plus card, no links) or a polite request to the admins, and records what you confirm.
      </p>
      <ErrorNotice error={error} />
      {groups.data?.length ? (
        <ul className="tight small">
          {groups.data.map((g) => (
            <li key={g.id}>
              <a href={g.url} target="_blank" rel="noreferrer">
                {g.name}
              </a>{' '}
              · {PERMISSIONS.find((p) => p.key === g.permission)?.label} · relevance {Math.round(g.relevance * 100)}% · <Badge value={g.status} /> {g.lastSharedAt ? `· last shared ${relativeTime(g.lastSharedAt)}` : ''}
              <div className="muted">{g.relevanceNotes}</div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No groups yet">Add Korean-learning groups you are a member of or would like to share in.</EmptyState>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('POST', '/v1/content/community/groups', form);
            setForm({ url: '', name: '', audience: '', rules: '', permission: 'unknown' });
          });
        }}
      >
        <div className="field">
          <label htmlFor="cg-url">Group link</label>
          <input id="cg-url" required placeholder="https://www.facebook.com/groups/…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cg-name">Group name</label>
          <input id="cg-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cg-aud">Who is in it</label>
          <input id="cg-aud" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cg-rules">Posting rules (paste from the group)</label>
          <textarea id="cg-rules" rows={2} value={form.rules} onChange={(e) => setForm({ ...form, rules: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cg-perm">Posting permission</label>
          <select id="cg-perm" value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value })}>
            {PERMISSIONS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn">
          Add group
        </button>
      </form>
      {groups.data?.length ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api('POST', `/v1/content/community/groups/${kit.groupId}/share-kit`, { planItemId: kit.planItemId || null }));
          }}
        >
          <div className="field">
            <label htmlFor="ck-group">Prepare a share for</label>
            <select id="ck-group" required value={kit.groupId} onChange={(e) => setKit({ ...kit, groupId: e.target.value })}>
              <option value="">Choose a group</option>
              {groups.data.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ck-item">Published lesson id (leave empty for an admin request)</label>
            <input id="ck-item" value={kit.planItemId} onChange={(e) => setKit({ ...kit, planItemId: e.target.value.trim() })} />
          </div>
          <button type="submit" className="btn">
            Prepare share kit
          </button>
        </form>
      ) : null}
      {shares.data?.length ? (
        <ul className="tight small">
          {shares.data.slice(0, 10).map((s) => (
            <li key={s.id}>
              {groups.data?.find((g) => g.id === s.groupId)?.name ?? 'group'} · {s.kind === 'permission_request' ? 'admin request' : 'lesson'} · <Badge value={s.status} /> {relativeTime(s.createdAt)}
              <pre className="studio-caption">{s.caption}</pre>
              {s.status === 'prepared' ? (
                <>
                  <button type="button" className="btn" onClick={() => void run(() => api('POST', `/v1/content/community/shares/${s.id}/confirm`, { status: 'shared' }))}>
                    I shared it
                  </button>{' '}
                  <button type="button" className="btn" onClick={() => void run(() => api('POST', `/v1/content/community/shares/${s.id}/confirm`, { status: 'declined' }))}>
                    Not shared / declined
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

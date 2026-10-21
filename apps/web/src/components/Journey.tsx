import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { api, CHANGED_EVENT, type Me } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { sectionBySlug } from '../lib/catalog.js';
import { canDo, evaluate, type JourneyView, neighbours, PIPELINE, type ProbeKey, type Progress, RANKS, SECTION_FLOWS, STAGES, type Stage, stageOf, type Task, TOTAL_XP } from '../lib/journey.js';

type Row = Record<string, unknown>;

export const sectionTitle = (slug: string) => sectionBySlug(slug)?.title ?? slug;
export const sectionHref = (slug: string) => `/app/${slug === 'overview' ? '' : slug}`;

/* ------------------------------------------------------------------ */
/* Progress: probed from live data, cached per tab for quick page loads */
/* ------------------------------------------------------------------ */

interface Snapshot {
  at: number;
  progress: Progress;
  /** Actions waiting for approval (sidebar badge). */
  pending: number | null;
}

const STALE_MS = 45_000;
const cacheKey = (me: Me) => `fg.journey.${me.tenantId}.${me.userId}`;

function readCache(me: Me): Snapshot | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(me));
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

function writeCache(me: Me, s: Snapshot): void {
  try {
    sessionStorage.setItem(cacheKey(me), JSON.stringify(s));
  } catch {
    /* storage unavailable: progress is simply re-read on the next page */
  }
}

/** Each check reads existing list endpoints; a check the role cannot read stays unknown (null). */
async function probe(me: Me): Promise<Snapshot> {
  const rows = (path: string) => api<unknown>('GET', path).then((d) => (Array.isArray(d) ? (d as Row[]) : []));
  const has = (path: string, test: (r: Row) => boolean = () => true) => rows(path).then((list) => list.some(test));
  const settle = (p: Promise<boolean>): Promise<boolean | null> => p.catch(() => null);
  const either = async (a: Promise<boolean | null>, b: Promise<boolean | null>) => {
    const [x, y] = await Promise.all([a, b]);
    return x || y ? true : x === null && y === null ? null : false;
  };
  const connections = rows('/v1/connections');
  const teamSize = async () => {
    const r = await authClient.organization.listMembers({ query: { organizationId: me.tenantId } });
    if (r.error) throw new Error(r.error.message ?? 'members unavailable');
    const data = r.data as { members?: unknown[]; total?: number } | unknown[] | null;
    return Array.isArray(data) ? data.length : (data?.total ?? data?.members?.length ?? 0);
  };
  const checks: Record<Exclude<ProbeKey, 'mfa'>, Promise<boolean | null>> = {
    team: settle(teamSize().then((n) => n >= 2)),
    policy: settle(api<{ configured?: boolean }>('GET', '/v1/governance/policy').then((p) => p.configured === true)),
    aiLimit: settle(api<{ limitUsd: number | null }>('GET', '/v1/governance/ai-budget').then((b) => b.limitUsd !== null)),
    connected: settle(connections.then((c) => c.length > 0)),
    healthy: settle(connections.then((c) => c.some((x) => x.status === 'active' && x.healthStatus === 'healthy'))),
    evidence: settle(has('/v1/evidence?limit=1')),
    claim: settle(has('/v1/knowledge/claims?status=approved', (c) => c.status === 'approved')),
    customerData: either(settle(has('/v1/customers/ingestion-keys', (k) => k.status === 'active')), settle(has('/v1/customers?limit=1'))),
    competitor: settle(has('/v1/competitors')),
    series: settle(has('/v1/analytics/series')),
    idea: settle(has('/v1/ideas')),
    decision: settle(has('/v1/brain/decisions')),
    brief: settle(has('/v1/creative/briefs')),
    asset: settle(has('/v1/assets')),
    experiment: settle(has('/v1/experiments')),
    launch: either(settle(has('/v1/social/posts')), settle(has('/v1/lifecycle/journeys'))),
    verified: settle(has('/v1/actions?status=VERIFIED&limit=1')),
  };
  const keys = Object.keys(checks) as (keyof typeof checks)[];
  const [values, pending] = await Promise.all([
    Promise.all(keys.map((k) => checks[k])),
    rows('/v1/actions?status=APPROVAL_REQUIRED&limit=200').then(
      (a) => a.length,
      () => null,
    ),
  ]);
  return { at: Date.now(), progress: Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Progress, pending };
}

interface JourneyState {
  view: JourneyView;
  progress: Progress;
  pending: number | null;
  /** False until the first probe (or a cached one) is available. */
  loaded: boolean;
  me: Me;
}

const JourneyContext = createContext<JourneyState | null>(null);

export function JourneyProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(() => readCache(me));
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const s = await probe(me);
      writeCache(me, s);
      setSnap(s);
    } finally {
      busy.current = false;
    }
  }, [me]);

  useEffect(() => {
    const cached = readCache(me);
    if (!cached || Date.now() - cached.at > STALE_MS) void refresh();
    // Any successful change (create, approve, connect…) re-checks progress shortly after.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 700);
    };
    window.addEventListener(CHANGED_EVENT, onChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CHANGED_EVENT, onChange);
    };
  }, [me, refresh]);

  // Two-factor is per user and already known from /v1/me.
  const progress: Progress = { ...(snap?.progress ?? {}), mfa: me.mfaVerified };
  const value: JourneyState = { view: evaluate(progress, me.roles), progress, pending: snap?.pending ?? null, loaded: snap !== null, me };
  return <JourneyContext.Provider value={value}>{children}</JourneyContext.Provider>;
}

export function useJourney(): JourneyState | null {
  return useContext(JourneyContext);
}

type TaskState = 'done' | 'next' | 'todo';

function taskState(t: Task, j: JourneyState): TaskState {
  if (j.progress[t.id] === true) return 'done';
  if (!j.loaded) return 'todo';
  return j.view.next?.id === t.id ? 'next' : 'todo';
}

/** done / next / null for a section's tasks (navigation markers). */
export function sectionState(slug: string, j: JourneyState | null): 'done' | 'next' | null {
  if (!j?.loaded) return null;
  const tasks = STAGES.flatMap((s) => s.tasks).filter((t) => t.section === slug);
  if (tasks.length === 0) return null;
  if (j.view.next?.section === slug) return 'next';
  return tasks.every((t) => j.progress[t.id] === true) ? 'done' : null;
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

const ICON_PATHS: Record<IconName, ReactNode> = {
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  bolt: <path d="M13 3L5 13h6l-1 8 8-10h-6l1-8z" />,
};

type IconName = 'check' | 'arrow' | 'arrow-left' | 'lock' | 'bolt';

/** Decorative stroke icons; the surrounding text always carries the meaning. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      {ICON_PATHS[name]}
    </svg>
  );
}

/** Circular progress (0–1) with the rank level in the middle. */
export function RankRing({ value, level, size = 96, label }: { value: number; level: number; size?: number; label?: string }) {
  const id = useId();
  const stroke = Math.max(4, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? `Rank ${level}, ${pct}% of the journey complete`} className="rank-ring">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent-2)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={stroke} />
      {pct > 0 ? <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id}g)`} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} /> : null}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="rank-ring-level" style={{ fontSize: size * 0.34 }}>
        {level}
      </text>
    </svg>
  );
}

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}

function rankProgress(view: JourneyView): number {
  if (!view.nextRank) return 1;
  return (view.xp - view.rank.minXp) / (view.nextRank.minXp - view.rank.minXp);
}

/* ------------------------------------------------------------------ */
/* Sidebar rank                                                        */
/* ------------------------------------------------------------------ */

export function SidebarRank() {
  const j = useJourney();
  if (!j) return null;
  const { view } = j;
  return (
    <a className="side-rank" href="/app/" aria-label={`Rank ${view.rank.level}: ${view.rank.name}. ${view.done} of ${view.total} journey tasks done. Open the overview.`}>
      <RankRing value={view.xp / TOTAL_XP} level={view.rank.level} size={46} />
      <div className="side-rank-body">
        <div className="side-rank-name">{view.rank.name}</div>
        <Bar value={view.done / view.total} label="Journey tasks done" />
        <div className="side-rank-meta">{j.loaded ? `${view.done} of ${view.total} tasks · ${view.xp} XP` : 'Checking progress…'}</div>
      </div>
    </a>
  );
}

/* ------------------------------------------------------------------ */
/* Overview: rank, next step, roadmap, pipeline                        */
/* ------------------------------------------------------------------ */

export function JourneyHero() {
  const j = useJourney();
  if (!j) return null;
  if (!j.loaded) {
    return (
      <div className="hero" aria-busy="true">
        <div className="hero-rank card">
          <RankRing value={0} level={1} size={116} label="Checking your rank" />
          <div className="hero-rank-body">
            <div className="eyebrow">Your rank</div>
            <p className="muted">Checking your progress…</p>
          </div>
        </div>
        <div className="hero-next card">
          <div className="eyebrow">Do this next</div>
          <p>Working out your next step from your live data…</p>
        </div>
      </div>
    );
  }
  const { view } = j;
  const next = view.next;
  const nextStage = next ? STAGES.find((s) => s.tasks.includes(next)) : undefined;
  const blocked = next ? !canDo(next, j.me.roles) : false;
  return (
    <div className="hero">
      <div className="hero-rank card">
        <RankRing value={view.xp / TOTAL_XP} level={view.rank.level} size={116} />
        <div className="hero-rank-body">
          <div className="eyebrow">Your rank</div>
          <div className="hero-rank-name">{view.rank.name}</div>
          <p className="small muted">{view.rank.meaning}</p>
          <Bar value={rankProgress(view)} label="Progress to the next rank" />
          <p className="small hero-rank-next">{view.nextRank ? `${view.nextRank.minXp - view.xp} XP to ${view.nextRank.name}` : 'Top rank reached: every stage is complete.'}</p>
          <p className="small muted">
            {view.done} of {view.total} tasks · {view.xp} / {TOTAL_XP} XP
          </p>
        </div>
      </div>
      <div className={`hero-next card${next ? '' : ' complete'}`}>
        {next ? (
          <>
            <div className="eyebrow">
              <Icon name="bolt" size={14} /> Do this next{nextStage ? ` · Stage ${nextStage.n} of ${STAGES.length}` : ''}
            </div>
            <h2 className="hero-next-title">{next.title}</h2>
            <p>{next.why}</p>
            <p className="small hero-next-how">
              <strong>How:</strong> {next.how}
            </p>
            {blocked ? <p className="small hero-next-blocked">This step needs an owner or admin. Ask one of them, or carry on with a later step.</p> : null}
            <div className="row">
              <a className="btn primary lg" href={sectionHref(next.section)}>
                Go to {sectionTitle(next.section)} <Icon name="arrow" />
              </a>
              <span className="xp">+{next.xp} XP</span>
            </div>
          </>
        ) : (
          <>
            <div className="eyebrow">Journey complete</div>
            <h2 className="hero-next-title">Your growth loop is verified end to end.</h2>
            <p>Keep it running: review approvals daily, watch alerts, and verify the audit chain regularly.</p>
            <a className="btn primary lg" href="/app/approvals">
              Open Actions &amp; approvals <Icon name="arrow" />
            </a>
          </>
        )}
      </div>
    </div>
  );
}

export function RankLadder() {
  const j = useJourney();
  if (!j) return null;
  // Nothing is highlighted until progress has been checked once.
  const level = j.loaded ? j.view.rank.level : 0;
  return (
    <ol className="ladder" aria-label="Ranks">
      {RANKS.map((r) => {
        const state = r.level < level ? 'reached' : r.level === level ? 'current' : 'locked';
        return (
          <li key={r.level} className={`ladder-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="ladder-badge">{state === 'reached' ? <Icon name="check" size={14} /> : r.level}</span>
            <span className="ladder-name">{r.name}</span>
            <span className="ladder-xp">{r.minXp} XP</span>
          </li>
        );
      })}
    </ol>
  );
}

function TaskItem({ task, j, here }: { task: Task; j: JourneyState; here?: boolean }) {
  const state = taskState(task, j);
  const blocked = state !== 'done' && !canDo(task, j.me.roles);
  return (
    <li className={`task ${state}`}>
      <span className="task-icon" aria-hidden="true">
        {state === 'done' ? <Icon name="check" size={14} /> : state === 'next' ? <Icon name="arrow" size={14} /> : null}
      </span>
      <div className="task-body">
        <div className="task-title">
          <span>{task.title}</span>
          <span className="sr-only">{state === 'done' ? ' (done)' : state === 'next' ? ' (do this next)' : ' (to do)'}</span>
          <span className="xp">+{task.xp} XP</span>
          {blocked ? (
            <span className="chip">
              <Icon name="lock" size={11} /> owner or admin
            </span>
          ) : null}
        </div>
        <div className="task-why">{task.why}</div>
        {state !== 'done' ? <div className="task-how">{task.how}</div> : null}
      </div>
      {state !== 'done' && !here ? (
        <a className={`btn${state === 'next' ? ' primary' : ''}`} href={sectionHref(task.section)}>
          {state === 'next' ? 'Start' : 'Open'}
        </a>
      ) : null}
      {state !== 'done' && here ? <span className="here">On this page</span> : null}
    </li>
  );
}

export function Roadmap() {
  const j = useJourney();
  if (!j) return null;
  return (
    <ol className="roadmap">
      {j.view.stages.map(({ stage, done, state: checked }) => {
        const state = j.loaded ? checked : 'upcoming';
        const stageXp = stage.tasks.reduce((n, t) => n + t.xp, 0);
        return (
          <li key={stage.n} className={`road-stage ${state}`}>
            <span className="road-marker" aria-hidden="true">
              {state === 'done' ? <Icon name="check" size={16} /> : stage.n}
            </span>
            <details className="road-card" open={state === 'current'}>
              <summary>
                <div className="road-head">
                  <div className="eyebrow">
                    Stage {stage.n} of {STAGES.length}
                    {` · ${stageXp} XP`}
                    {state === 'current' ? <span className="pill now">You are here</span> : null}
                    {state === 'done' ? <span className="pill ok">Complete</span> : null}
                  </div>
                  <h3>{stage.title}</h3>
                  <p className="small muted">{stage.tagline}</p>
                </div>
                <span className="road-count">
                  {j.loaded ? done : '–'}/{stage.tasks.length}
                </span>
              </summary>
              <ul className="task-list">
                {stage.tasks.map((t) => (
                  <TaskItem key={t.id} task={t} j={j} />
                ))}
              </ul>
              <p className="small muted road-sections">
                Pages in this stage:{' '}
                {stage.sections.map((s, i) => (
                  <span key={s}>
                    {i ? ' · ' : ''}
                    <a href={sectionHref(s)}>{sectionTitle(s)}</a>
                  </span>
                ))}
              </p>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

export function Pipeline() {
  return (
    <ol className="pipeline">
      {PIPELINE.map((p, i) => (
        <li key={p.label}>
          <a href={sectionHref(p.section)}>
            <span className="pipe-n">{i + 1}</span>
            <span className="pipe-label">{p.label}</span>
            <span className="pipe-detail">{p.detail}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Section pages: stage banner, "how this works", previous / next      */
/* ------------------------------------------------------------------ */

export function FlowSteps({ steps }: { steps: string[] }) {
  return (
    <ol className="flow" aria-label="How this works">
      {steps.map((s, i) => (
        <li key={s}>
          <span className="flow-step">
            <span className="flow-n">{i + 1}</span>
            <span>{s}</span>
          </span>
          {i < steps.length - 1 ? (
            <span className="flow-arrow" aria-hidden="true">
              <Icon name="arrow" size={14} />
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function StageBanner({ slug }: { slug: string }) {
  const j = useJourney();
  const stage: Stage | undefined = stageOf(slug);
  const flow = SECTION_FLOWS[slug];
  if (!stage && !flow) return null;
  const entry = stage && j?.loaded ? j.view.stages.find((s) => s.stage === stage) : undefined;
  const tasks = stage ? stage.tasks.filter((t) => t.section === slug) : slug === 'approvals' ? STAGES.flatMap((s) => s.tasks).filter((t) => t.section === slug) : [];
  return (
    <section className={`stage-banner${entry ? ` ${entry.state}` : ''}`} aria-label={stage ? `Stage ${stage.n}: ${stage.title}` : 'How this works'}>
      {stage ? (
        <div className="stage-banner-head">
          <span className="stage-num" aria-hidden="true">
            {entry?.state === 'done' ? <Icon name="check" size={18} /> : stage.n}
          </span>
          <div className="stage-banner-title">
            <div className="eyebrow">
              Stage {stage.n} of {STAGES.length}
              {entry?.state === 'current' ? <span className="pill now">You are here</span> : null}
              {entry?.state === 'done' ? <span className="pill ok">Complete</span> : null}
            </div>
            <div className="stage-banner-name">{stage.title}</div>
            <p className="small muted">{stage.tagline}</p>
          </div>
          {entry ? (
            <div className="stage-banner-progress">
              <span className="road-count">
                {entry.done}/{stage.tasks.length}
              </span>
              <span className="small muted">stage tasks</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {j && tasks.length ? (
        <ul className="task-list">
          {tasks.map((t) => (
            <TaskItem key={t.id} task={t} j={j} here />
          ))}
        </ul>
      ) : null}
      {flow ? (
        <div className="flow-wrap">
          <div className="eyebrow">How this works</div>
          <FlowSteps steps={flow} />
        </div>
      ) : null}
    </section>
  );
}

export function SectionPager({ slug }: { slug: string }) {
  const { prev, next } = neighbours(slug);
  const label = (s: string) => {
    const st = stageOf(s);
    return st ? `Stage ${st.n} · ${st.title}` : 'Daily';
  };
  return (
    <nav className="pager" aria-label="Previous and next page">
      {prev ? (
        <a className="pager-link prev" href={sectionHref(prev)}>
          <span className="eyebrow">
            <Icon name="arrow-left" size={12} /> Previous · {label(prev)}
          </span>
          <span className="pager-title">{sectionTitle(prev)}</span>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a className="pager-link next" href={sectionHref(next)}>
          <span className="eyebrow">
            Next · {label(next)} <Icon name="arrow" size={12} />
          </span>
          <span className="pager-title">{sectionTitle(next)}</span>
        </a>
      ) : null}
    </nav>
  );
}

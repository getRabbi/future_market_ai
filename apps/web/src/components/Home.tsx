import { useMemo, useState } from 'react';
import { type ActivityItem, type AuditRow, activityFromAudit, BLOCKER_LEVEL_LABEL, type Blocker, blockers, type ConnectionLite, glance, nextBestAction, SIGNIFICANT_KINDS, type StoreAccountLite, verifiedTitle } from '../lib/dashboard.js';
import { relativeTime } from '../lib/format.js';
import { pageBySlug } from '../lib/nav.js';
import { type AnyIcon, Ico } from './Icons.js';
import { currentStepLabel, JourneyStepper, useJourney } from './Journey.js';
import { GrowthSummary, PERIODS, PerformancePanel, type PeriodKey, PeriodSelect, rangeText, useStoreOverview } from './Performance.js';
import { failed, isAdmin, listOrEmpty, useWorkspace } from './Shell.js';
import { Drawer, ErrorNotice, useApi } from './ui.js';

const PERIOD_KEY = 'fg.home.period';

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function readPeriod(): PeriodKey {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    return PERIODS.some((p) => p.key === v) ? (v as PeriodKey) : 'r28';
  } catch {
    return 'r28';
  }
}

export function Home() {
  const [period, setPeriod] = useState<PeriodKey>(readPeriod);
  const days = PERIODS.find((p) => p.key === period)!.days;
  const overview = useStoreOverview(days);
  // Shared by several cards: one request each.
  const audit = useApi<AuditRow[]>('/v1/governance/audit?limit=250');
  const status = useApi<SystemStatus>('/v1/system/status');
  const choose = (k: PeriodKey) => {
    setPeriod(k);
    try {
      localStorage.setItem(PERIOD_KEY, k);
    } catch {
      /* not remembered */
    }
  };
  const covered = rangeText(overview.data);
  return (
    <div className="home">
      <div className="home-head">
        <div>
          <p className="home-greeting">{greeting()}!</p>
          <h1>Your growth at a glance</h1>
          <p className="home-lede">FUTUREGROW runs your growth plan, publishes content, tracks performance, and tells you what to do next.</p>
        </div>
        <div className="home-period">
          <PeriodSelect value={period} onChange={choose} id="home-period" />
          <span className="home-range" aria-live="polite">
            {overview.data ? (covered ?? 'No reported days yet') : overview.error ? 'Reports unavailable' : 'Checking report dates…'}
          </span>
        </div>
      </div>
      <div className="home-grid">
        <JourneyCard />
        <GlanceCard />
        <NextActionCard />
        <PerformancePanel overview={overview} days={days} />
        <BlockersCard />
        <SystemHealthCard status={status} />
        <GrowthSummary overview={overview} />
        <RecentActivityCard audit={audit} />
        <CompletionsCard audit={audit} status={status} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Journey                                                             */
/* ------------------------------------------------------------------ */

function JourneyCard() {
  const j = useJourney();
  const label = currentStepLabel(j);
  return (
    <section className="card journey-card area-journey" aria-labelledby="home-journey">
      <header className="card-head">
        <h2 className="card-title big" id="home-journey">
          Your growth journey
          {label ? <span className="pill step-pill">{label}</span> : <span className="pill step-pill muted">Checking…</span>}
        </h2>
        <a className="pill-link" href="/app/journey">
          View full journey <Ico name="arrow-right" size={15} />
        </a>
      </header>
      <p className="card-sub">A simple path to set up, launch, and grow — with AI and automation on your side.</p>
      <JourneyStepper />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* At a glance                                                         */
/* ------------------------------------------------------------------ */

function GlanceCard() {
  const { attention, autopilot, me } = useWorkspace();
  const goals = listOrEmpty(attention.goals);
  const g = glance(goals);
  return (
    <section className="card glance area-glance" aria-labelledby="home-glance" aria-busy={!g}>
      <h2 className="card-title big" id="home-glance">
        At a glance
      </h2>
      {failed(attention.goals) ? (
        <ErrorNotice error={attention.goals.error} />
      ) : !g ? (
        <div className="glance-grid skeleton-block" role="status">
          <span className="sr-only">Loading goals…</span>
          <span className="sk-tile" />
          <span className="sk-tile" />
          <span className="sk-tile" />
        </div>
      ) : (
        <>
          <div className="glance-grid">
            <a className="glance-main" href="/app/goals">
              <span className="glance-icon">
                <Ico name="target" size={24} />
              </span>
              <span>
                <span className="glance-label">Active goals</span>
                <span className="glance-value">{g.active}</span>
              </span>
            </a>
            <a className="glance-tile ok" href="/app/goals?filter=active">
              <Ico name="check-circle" size={20} />
              <span>
                <span className="glance-label">On track</span>
                <span className="glance-value">{g.onTrack}</span>
              </span>
            </a>
            <a className={`glance-tile ${g.attention ? 'warn' : 'quiet'}`} href="/app/goals?filter=attention">
              <Ico name="alert-triangle" size={20} />
              <span>
                <span className="glance-label">Needs attention</span>
                <span className="glance-value">{g.attention}</span>
              </span>
            </a>
          </div>
          <p className="glance-note">
            {g.active === 0 && g.paused === 0 ? (
              autopilot?.available && !autopilot.enabled ? (
                <>The Autopilot is off. {isAdmin(me) ? <a href="/app/setup">Turn it on</a> : 'Ask an owner or admin to turn it on.'}</>
              ) : (
                <>
                  No goals yet. <a href="/app/goals#new">Create your first goal</a>
                </>
              )
            ) : (
              [g.notMeasured ? `${g.notMeasured} not measured yet (data has not arrived — not a problem)` : null, g.paused ? `${g.paused} paused` : null].filter(Boolean).join(' · ') || 'Every active goal has a measured result.'
            )}
          </p>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Next best action                                                    */
/* ------------------------------------------------------------------ */

const TONE_ICON: Record<string, AnyIcon> = { critical: 'alert-triangle', action: 'calendar', setup: 'setup', calm: 'check-circle' };

function NextActionCard() {
  const { me, autopilot, attention: a } = useWorkspace();
  const j = useJourney();
  const errors = [a.approvals, a.escalated, a.incidents, a.killSwitches, a.goals].filter(failed);
  const next = nextBestAction({
    stopped: autopilot?.stopped,
    killSwitches: listOrEmpty(a.killSwitches),
    escalated: listOrEmpty(a.escalated),
    approvals: listOrEmpty(a.approvals),
    inbox: a.inbox.data,
    incidents: listOrEmpty(a.incidents),
    goals: listOrEmpty(a.goals),
    journeyNext: j?.view.next,
    journeyLoaded: Boolean(j?.loaded),
    userId: me.userId,
    pageTitle: (s) => pageBySlug(s)?.title ?? s,
  });
  return (
    <section className={`card next-card area-next ${next?.tone ?? 'loading'}`} aria-labelledby="home-next" aria-busy={!next && !errors.length}>
      <header className="card-head">
        <h2 className="card-title big" id="home-next">
          <Ico name="bolt" size={21} className="next-bolt" /> Next best action
        </h2>
      </header>
      <p className="card-sub">{next?.tone === 'calm' ? 'All clear for now.' : 'Do this now to keep your growth on track.'}</p>
      {errors.length ? (
        <div className="notice error" role="alert">
          <strong>Could not check everything that may need you.</strong>
          <div className="small">Some lists did not load, so this card does not claim that nothing needs attention. Try again in a moment.</div>
        </div>
      ) : !next ? (
        <div className="next-item skeleton-block" role="status">
          <span className="sr-only">Working out your next best action…</span>
          <span className="sk-line" />
          <span className="sk-line short" />
        </div>
      ) : (
        <>
          <a className="next-item" href={next.primary.href}>
            <span className="next-icon">
              <Ico name={TONE_ICON[next.tone]!} size={20} />
            </span>
            <span className="next-body">
              <strong>{next.title}</strong>
              <span>{next.text}</span>
              {next.meta ? <span className="next-meta">{next.meta}</span> : null}
            </span>
            <Ico name="chevron-right" size={18} className="next-chev" />
          </a>
          <div className="next-buttons">
            <a className="btn primary lg" href={next.primary.href}>
              {next.primary.label}
            </a>
            {next.secondary ? (
              <a className="btn lg" href={next.secondary.href}>
                {next.secondary.label}
              </a>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Blockers                                                            */
/* ------------------------------------------------------------------ */

const LEVEL_ICON: Record<Blocker['level'], AnyIcon> = { critical: 'alert-circle', action: 'alert-triangle', external: 'plug', optional: 'chart', info: 'info' };

function BlockersCard() {
  const { me, attention: a } = useWorkspace();
  const accounts = useApi<{ accounts: StoreAccountLite[] }>('/v1/app-intelligence/accounts');
  const connections = useApi<ConnectionLite[]>('/v1/connections');
  const policy = useApi<{ configured: boolean }>('/v1/governance/policy');
  const [open, setOpen] = useState<Blocker | 'all' | null>(null);
  const list = blockers({
    killSwitches: listOrEmpty(a.killSwitches),
    incidents: listOrEmpty(a.incidents),
    goals: listOrEmpty(a.goals),
    storeAccounts: accounts.data?.accounts ?? (accounts.error ? [] : null),
    connections: connections.data ?? (connections.error ? [] : null),
    policyConfigured: policy.data ? policy.data.configured : null,
    userId: me.userId,
  });
  const ready = list !== null && (accounts.data || accounts.error) && (connections.data || connections.error);
  const shown = (list ?? []).slice(0, 3);
  return (
    <section className="card blockers area-blockers" aria-labelledby="home-blockers" aria-busy={!ready}>
      <header className="card-head">
        <h2 className="card-title big" id="home-blockers">
          <Ico name="alert-circle" size={21} className={list?.some((b) => b.level === 'critical') ? 'tone-danger' : list?.length ? 'tone-warn' : 'tone-ok'} /> Blockers {ready ? `(${list!.length})` : ''}
        </h2>
        {ready && list!.length ? (
          <button type="button" className="link-btn" onClick={() => setOpen('all')}>
            View all <Ico name="arrow-right" size={15} />
          </button>
        ) : null}
      </header>
      {!ready ? (
        <div className="skeleton-block" role="status">
          <span className="sr-only">Checking for blockers…</span>
          <span className="sk-row" />
          <span className="sk-row" />
        </div>
      ) : list!.length === 0 ? (
        <div className="calm">
          <Ico name="check-circle" size={20} />
          <span>Nothing is blocked. Optional provider limits and data that has not arrived yet show up here as information, never as failures.</span>
        </div>
      ) : (
        <ul className="blocker-list">
          {shown.map((b) => (
            <li key={b.id}>
              <button type="button" className={`blocker ${b.level}`} onClick={() => setOpen(b)}>
                <span className="blocker-icon">
                  <Ico name={LEVEL_ICON[b.level]} size={20} />
                </span>
                <span className="blocker-body">
                  <strong>{b.title}</strong>
                  <span>{b.detail}</span>
                  <span className={`level ${b.level}`}>{BLOCKER_LEVEL_LABEL[b.level]}</span>
                </span>
                <Ico name="chevron-right" size={18} className="next-chev" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <Drawer title={open === 'all' ? 'Blockers' : open.title} onClose={() => setOpen(null)}>
          {(open === 'all' ? (list ?? []) : [open]).map((b) => (
            <div key={b.id} className={`blocker-detail ${b.level}`}>
              <span className={`level ${b.level}`}>{BLOCKER_LEVEL_LABEL[b.level]}</span>
              {open === 'all' ? <h3>{b.title}</h3> : null}
              <p>{b.detail}</p>
              <p className="small muted">{b.impact}</p>
              <a className="btn primary" href={b.remedy.href}>
                {b.remedy.label}
              </a>
            </div>
          ))}
        </Drawer>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* System health                                                       */
/* ------------------------------------------------------------------ */

type ComponentState = 'ok' | 'stale' | 'failing' | 'unknown' | 'not_configured';
interface SystemStatus {
  ok: boolean;
  checkedAt: string;
  components: Partial<Record<'database' | 'worker' | 'backups' | 'analytics_queue' | 'media_queue', { state: ComponentState; ageSeconds?: number }>>;
  alertDelivery?: 'configured' | 'not_configured';
}

const age = (s: number | undefined) => (s === undefined ? '' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172_800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`);

function stateWord(kind: 'worker' | 'database' | 'backups' | 'jobs', s: ComponentState | undefined): { word: string; tone: string } {
  if (!s) return { word: 'Unknown', tone: 'muted' };
  if (s === 'ok') return { word: kind === 'database' ? 'Healthy' : kind === 'backups' ? 'Up to date' : kind === 'jobs' ? 'Running' : 'Online', tone: 'ok' };
  if (s === 'not_configured') return { word: 'Not set up', tone: 'muted' };
  if (s === 'stale') return { word: kind === 'backups' ? 'Out of date' : 'Delayed', tone: 'warn' };
  if (s === 'failing') return { word: 'Failing', tone: 'danger' };
  return { word: 'Unknown', tone: 'muted' };
}

type Loadable<T> = { data: T | null; error: unknown };

export function SystemHealthCard({ status }: { status: Loadable<SystemStatus> }) {
  const s = status.data;
  const jobs: ComponentState | undefined = s
    ? [s.components.analytics_queue?.state, s.components.media_queue?.state].includes('failing')
      ? 'failing'
      : [s.components.analytics_queue?.state, s.components.media_queue?.state].includes('stale')
        ? 'stale'
        : s.components.analytics_queue?.state === 'ok' && s.components.media_queue?.state === 'ok'
          ? 'ok'
          : 'unknown'
    : undefined;
  const items: { key: string; label: string; icon: AnyIcon; word: string; tone: string; title: string }[] = s
    ? [
        { key: 'api', label: 'API', icon: 'server', word: 'Online', tone: 'ok', title: `Answered at ${new Date(s.checkedAt).toLocaleTimeString()}` },
        { key: 'worker', label: 'Worker', icon: 'layers', ...stateWord('worker', s.components.worker?.state), title: s.components.worker?.ageSeconds !== undefined ? `Last scheduled run ${age(s.components.worker.ageSeconds)}` : 'No recent run recorded' },
        { key: 'database', label: 'Database', icon: 'database', ...stateWord('database', s.components.database?.state), title: 'Reachable from the API' },
        { key: 'backups', label: 'Backups', icon: 'cloud', ...stateWord('backups', s.components.backups?.state), title: s.components.backups?.ageSeconds !== undefined ? `Last verified backup ${age(s.components.backups.ageSeconds)}` : 'No backup recorded' },
        { key: 'jobs', label: 'Jobs', icon: 'refresh', ...stateWord('jobs', jobs), title: 'Forecast and media job queues' },
      ]
    : [];
  const unavailable = status.error;
  return (
    <section className="card health area-health" aria-labelledby="home-health" aria-busy={!s && !unavailable}>
      <header className="card-head">
        <h2 className="card-title big" id="home-health">
          <Ico name="shield" size={21} /> System health
          {s ? <span className={`pill ${s.ok ? 'ok' : 'warn'}`}>{s.ok ? 'All systems operational' : 'Needs attention'}</span> : null}
        </h2>
      </header>
      {unavailable ? (
        <p className="small muted">Status is temporarily unavailable from this page. The API answered your other requests, so the product itself is reachable.</p>
      ) : !s ? (
        <div className="health-grid skeleton-block" role="status">
          <span className="sr-only">Checking system health…</span>
          <span className="sk-tile" />
          <span className="sk-tile" />
          <span className="sk-tile" />
          <span className="sk-tile" />
        </div>
      ) : (
        <>
          <ul className="health-grid">
            {items.map((i) => (
              <li key={i.key} className={`health-tile ${i.tone}`} title={i.title}>
                <Ico name={i.icon} size={20} />
                <strong>{i.label}</strong>
                <span>{i.word}</span>
              </li>
            ))}
          </ul>
          <p className="health-foot">
            Checked {relativeTime(s.checkedAt)}
            {s.components.backups?.ageSeconds !== undefined ? ` · last backup ${age(s.components.backups.ageSeconds)}` : ''} · external alert delivery {s.alertDelivery === 'configured' ? 'configured' : 'not configured'}
          </p>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Recent activity and completions                                     */
/* ------------------------------------------------------------------ */

export const KIND_ICON: Record<ActivityItem['kind'], AnyIcon> = { publish: 'send', content: 'layers', store: 'download', autopilot: 'refresh', approval: 'check-circle', governance: 'shield', connection: 'plug', data: 'file', team: 'users', other: 'clock' };

export function stamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function RecentActivityCard({ audit }: { audit: Loadable<AuditRow[]> }) {
  const { me } = useWorkspace();
  const items = activityFromAudit(audit.data, me.userId, 5, SIGNIFICANT_KINDS);
  return (
    <section className="card activity area-activity" aria-labelledby="home-activity" aria-busy={!items && !audit.error}>
      <header className="card-head">
        <h2 className="card-title big" id="home-activity">
          <Ico name="clock" size={21} /> Recent activity
        </h2>
        <a className="link-btn" href="/app/activity">
          View all activity <Ico name="arrow-right" size={15} />
        </a>
      </header>
      {audit.error ? <ErrorNotice error={audit.error} /> : null}
      {!items && !audit.error ? (
        <div className="skeleton-block" role="status">
          <span className="sr-only">Loading recent activity…</span>
          <span className="sk-row" />
          <span className="sk-row" />
          <span className="sk-row" />
        </div>
      ) : items && items.length === 0 ? (
        <p className="small muted">Nothing has happened yet in this organization. Activity appears here as soon as anything is recorded.</p>
      ) : (
        <ul className="feed">
          {(items ?? []).map((i) => (
            <li key={i.key} className="feed-item">
              <span className={`feed-icon ${i.kind}`}>
                <Ico name={KIND_ICON[i.kind]} size={18} />
              </span>
              <span className="feed-body">
                {i.href ? <a href={i.href}>{i.title}</a> : <strong>{i.title}</strong>}
                <span className="feed-detail">{[i.actor, i.detail].filter(Boolean).join(' · ')}</span>
              </span>
              <time className="feed-time" dateTime={i.at}>
                {stamp(i.at)}
              </time>
              <span className={`status-pill ${i.status.tone}`}>{i.status.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Completion {
  key: string;
  title: string;
  at: string;
  href: string | null;
}

function CompletionsCard({ audit, status }: { audit: Loadable<AuditRow[]>; status: Loadable<SystemStatus> }) {
  const { attention } = useWorkspace();
  const verified = useApi<{ id: string; actionType: string; updatedAt: string }[]>('/v1/actions?status=VERIFIED&limit=10');
  const goals = attention.goals.data;
  const items = useMemo<Completion[] | null>(() => {
    if (!verified.data && !verified.error) return null;
    if (!audit.data && !audit.error) return null;
    if (!attention.goals.loaded) return null;
    const out: Completion[] = [];
    for (const a of verified.data ?? []) out.push({ key: `v-${a.id}`, title: verifiedTitle(a.actionType), at: a.updatedAt, href: `/app/approvals?id=${a.id}` });
    for (const g of goals ?? []) {
      const c = g.latestCycle;
      if (c?.status === 'completed' && c.finishedAt) out.push({ key: `c-${c.id}`, title: `Autopilot cycle ${c.seq} completed`, at: c.finishedAt, href: `/app/goals?id=${g.id}` });
    }
    for (const r of audit.data ?? []) {
      if (r.action === 'app.coverage.reconciled' || r.action === 'store.report.revised') out.push({ key: `s-${r.seq}`, title: 'Store reports imported', at: r.occurred_at, href: '/app/apps' });
      if (r.action === 'studio.post.superseded' || r.action === 'studio.post.expired') out.push({ key: `d-${r.seq}`, title: `Stale draft closed (${r.action.endsWith('superseded') ? 'superseded' : 'expired'})`, at: r.occurred_at, href: '/app/content' });
    }
    const b = status.data?.components.backups;
    if (b?.state === 'ok' && b.ageSeconds !== undefined) out.push({ key: 'backup', title: 'Backup completed and verified', at: new Date(Date.now() - b.ageSeconds * 1000).toISOString(), href: null });
    // One row per kind of import is enough here; the activity log has every row.
    const seen = new Set<string>();
    return out
      .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
      .filter((c) => {
        const k = c.title.startsWith('Store reports') ? 'store' : c.key;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 5);
  }, [verified.data, verified.error, audit.data, audit.error, attention.goals.loaded, goals, status.data]);
  return (
    <section className="card completions area-completions" aria-labelledby="home-done" aria-busy={!items}>
      <header className="card-head">
        <h2 className="card-title big" id="home-done">
          <Ico name="check-circle" size={21} className="tone-ok" /> Recent completions
        </h2>
      </header>
      {!items ? (
        <div className="skeleton-block" role="status">
          <span className="sr-only">Loading completions…</span>
          <span className="sk-row" />
          <span className="sk-row" />
          <span className="sk-row" />
        </div>
      ) : items.length === 0 ? (
        <p className="small muted">Nothing completed yet. Verified posts, finished Autopilot cycles, report imports and backups appear here.</p>
      ) : (
        <ul className="done-list">
          {items.map((c) => (
            <li key={c.key}>
              <Ico name="check-circle" size={19} className="tone-ok" />
              {c.href ? <a href={c.href}>{c.title}</a> : <span>{c.title}</span>}
              <time dateTime={c.at}>{new Date(c.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

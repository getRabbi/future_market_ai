import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { relativeTime, statusLabel } from '../lib/format.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, Logo, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const AUTOPILOT_CALLS = [
  { method: 'GET', path: '/v1/autopilot/status' },
  { method: 'PUT', path: '/v1/autopilot/settings' },
  { method: 'GET', path: '/v1/autopilot/readiness' },
  { method: 'POST', path: '/v1/autopilot/interpret' },
  { method: 'GET', path: '/v1/autopilot/goals' },
  { method: 'POST', path: '/v1/autopilot/goals' },
  { method: 'GET', path: '/v1/autopilot/goals/:id' },
  { method: 'POST', path: '/v1/autopilot/goals/:id/:command' },
  { method: 'GET', path: '/v1/autopilot/activity' },
  { method: 'GET', path: '/v1/autopilot/inbox' },
  { method: 'POST', path: '/v1/brain/decisions/:id/accept' },
  { method: 'POST', path: '/v1/brain/decisions/:id/reject' },
] as const;

export interface AutopilotStatus {
  available: boolean;
  enabled: boolean;
  stopped: string | null;
  modelAvailable: boolean;
}

type View = 'setup' | 'goals' | 'activity' | 'approvals' | 'results';
const VIEWS: { key: View; title: string; summary: string }[] = [
  { key: 'setup', title: 'Business setup', summary: 'What the Autopilot can use: connections, data, evidence, claims, AI and your rules.' },
  { key: 'goals', title: 'Growth goals', summary: 'Say what you want to achieve. The Autopilot plans it and keeps working while you are away.' },
  { key: 'activity', title: 'AI activity', summary: 'What the Autopilot is doing now, what it finished, what is blocked and why. Real records only.' },
  { key: 'approvals', title: 'Pending approvals', summary: 'Actions and drafts that wait for a person because your policy says so.' },
  { key: 'results', title: 'Results', summary: 'Measured outcomes against your baseline and the no-action forecast.' },
];

const CHANNELS: { key: string; label: string; help: string }[] = [
  { key: 'organic_social', label: 'Organic social posts', help: 'Facebook/Instagram/TikTok/YouTube posts; publishing waits for approval unless your policy allows it.' },
  { key: 'app_store', label: 'App Store listing', help: 'Store metadata changes (approval per your policy).' },
  { key: 'seo', label: 'Search (SEO)', help: 'Read-only site audits and keyword research.' },
  { key: 'email', label: 'Email', help: 'Consented lifecycle email only.' },
  { key: 'experiments', label: 'Experiments', help: 'Start A/B tests you designed.' },
  { key: 'offers', label: 'Offers & pricing', help: 'Discounts (always within your limits).' },
  { key: 'paid_ads', label: 'Paid ads', help: 'Only with a budget above $0.' },
];

const NEEDS: Record<string, { label: string; href: string }> = {
  data: { label: 'Add or connect KPI data', href: '/app/analytics' },
  connection: { label: 'Fix a connection', href: '/app/connections' },
  evidence: { label: 'Add evidence', href: '/app/evidence' },
  claims: { label: 'Approve claims', href: '/app/knowledge' },
  approval: { label: 'Review in Pending approvals', href: '?view=approvals' },
  configuration: { label: 'Check your rules', href: '/app/governance' },
  model: { label: 'Approve an AI model', href: '/app/governance' },
  budget: { label: 'Review the goal budget', href: '?view=goals' },
};

/* ------------------------------------------------------------------ */
/* Types (mirror the API's persisted rows)                             */
/* ------------------------------------------------------------------ */

interface Kpi {
  metricKey: string;
  label: string;
  unit: string;
  direction: 'increase' | 'decrease';
  target: number | null;
  targetChangePct: number | null;
}
interface Measurement {
  status: 'measured' | 'insufficient_data';
  label: string;
  unit: string;
  measuredAt: string;
  daysObserved: number;
  actual: number | null;
  baselinePerDay: number | null;
  baselineForSamePeriod: number | null;
  changeVsBaselinePct: number | null;
  target: number | null;
  progressPct: number | null;
  forecast: { expected: number; low: number; high: number; position: 'above' | 'within' | 'below'; days: number } | null;
  note: string;
}
interface Cycle {
  id: string;
  seq: number;
  status: string;
  trigger: string;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  plan: { steps: { kind: string; title: string; modules: string[]; reason: string }[]; notUsed: { modules: string[]; reason: string }[] };
}
interface Goal {
  id: string;
  title: string;
  statement: string;
  kpi: Kpi;
  market: string;
  startsAt: string;
  targetDate: string;
  channels: string[];
  adBudgetMicros: number;
  currency: string;
  autoSubmit: boolean;
  status: string;
  statusReason: string | null;
  nextRunAt: string | null;
  lastCycleAt: string | null;
  pendingTrigger: string | null;
  memory: { lastMeasurement?: Measurement | null; finalMeasurement?: Measurement; lessons?: string[]; blockedOn?: string[] };
  latestCycle?: Cycle | null;
  cycleCount?: number;
}
interface Task {
  id: string;
  goalId: string;
  cycleId: string;
  kind: string;
  title: string;
  modules: string[];
  status: string;
  reason: string;
  detail: string | null;
  needs: string | null;
  attempts: number;
  notBefore: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  refs: Record<string, string>;
}
interface Draft {
  draft: { title: string; statement: string; kpi: Kpi; market: string; targetDate: string; channels: string[]; adBudget: { amountMicros: number; currency: string }; autoSubmit: boolean; limits: { cadenceHours: number; maxCyclesPerDay: number; maxAiCallsPerDay: number; maxOpenActions: number }; siteUrl: string | null };
  understood: string[];
  assumptions: string[];
  check: string[];
}

const money = (micros: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits }));
const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
const canEdit = (me: Me) => me.roles.some((r) => ['owner', 'admin', 'growth_operator'].includes(r));
const isAdmin = (me: Me) => me.roles.some((r) => ['owner', 'admin'].includes(r));

function usePoll(reload: () => Promise<void>, ms = 15_000) {
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, ms);
    return () => window.clearInterval(t);
  }, [reload, ms]);
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export function AutopilotShell({ me, status, orgSelect, onStatus }: { me: Me; status: AutopilotStatus; orgSelect: ReactNode; onStatus: () => void }) {
  const initial = (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('view') : null) as View | null;
  const [view, setView] = useState<View>(initial && VIEWS.some((v) => v.key === initial) ? initial : 'goals');
  const inbox = useApi<{ approvals: unknown[]; decisions: unknown[]; drafts: unknown[] }>('/v1/autopilot/inbox');
  usePoll(inbox.reload, 30_000);
  const pending = (inbox.data?.approvals.length ?? 0) + (inbox.data?.decisions.length ?? 0) + (inbox.data?.drafts.length ?? 0);

  useEffect(() => {
    const onPop = () => {
      const v = new URLSearchParams(window.location.search).get('view') as View | null;
      if (v && VIEWS.some((x) => x.key === v)) setView(v);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (v: View) => {
    setView(v);
    window.history.pushState(null, '', `?view=${v}`);
    window.scrollTo({ top: 0 });
  };
  const current = VIEWS.find((v) => v.key === view)!;
  return (
    <div className="ap-shell">
      <header className="ap-top">
        <a className="brand" href="/app/">
          <Logo size={26} />
          <span>FUTUREGROW</span>
          <small>Autopilot beta</small>
        </a>
        <div className="ap-top-right">
          {orgSelect}
          <a className="btn" href="/app/advanced">
            Advanced workspace
          </a>
        </div>
      </header>
      <nav className="ap-tabs" aria-label="Autopilot">
        {VIEWS.map((v, i) => (
          <button key={v.key} type="button" className={`ap-tab${v.key === view ? ' active' : ''}`} aria-current={v.key === view ? 'page' : undefined} onClick={() => go(v.key)}>
            <span className="ap-tab-n">{i + 1}</span>
            {v.title}
            {v.key === 'approvals' && pending ? <span className="ap-count">{pending}</span> : null}
          </button>
        ))}
      </nav>
      <main className="ap-main" id="content">
        <h1>{current.title}</h1>
        <p className="muted">{current.summary}</p>
        {status.stopped ? (
          <div className="notice error" role="alert">
            <strong>The Autopilot is stopped.</strong> {status.stopped}. Release the emergency stop in <a href="/app/governance">Governance</a> to continue.
          </div>
        ) : null}
        {view === 'setup' ? <SetupView me={me} status={status} onStatus={onStatus} /> : null}
        {view === 'goals' ? <GoalsView me={me} go={go} /> : null}
        {view === 'activity' ? <ActivityView /> : null}
        {view === 'approvals' ? <ApprovalsView me={me} onChange={() => void inbox.reload()} /> : null}
        {view === 'results' ? <ResultsView /> : null}
      </main>
    </div>
  );
}

/** Shown in the classic workspace when the Autopilot is available but not switched on. */
export function AutopilotOffer({ me, onEnabled }: { me: Me; onEnabled: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/v1/autopilot/settings', { enabled: true });
      onEnabled();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card ap-offer">
      <header>
        <h2>Try the Autopilot (beta)</h2>
        <span className="pill">New</span>
      </header>
      <p className="small">Describe a business goal in one sentence. The Autopilot turns it into a plan, runs the research, ideas, forecasts and decisions by itself, and asks you only when your policy requires approval. Your rules, approvals and emergency stops stay exactly as they are.</p>
      <ErrorNotice error={error} />
      {isAdmin(me) ? (
        <button type="button" className="primary" disabled={busy} onClick={() => void enable()}>
          Turn on the Autopilot
        </button>
      ) : (
        <p className="small muted">Ask an owner or admin to turn it on.</p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Business setup                                                    */
/* ------------------------------------------------------------------ */

interface Readiness {
  policyConfigured: boolean;
  approvedMarkets: string[];
  categories: Record<string, string | null>;
  connections: { provider: string; status: string; displayName: string }[];
  evidence: number;
  approvedClaims: number;
  kpiSeries: { key: string; name: string }[];
  approvedModels: number;
  modelGateway: boolean;
  aiBudget: { limitUsd: number | null; spentUsd: number };
  mfaVerified: boolean;
}

function Check({ ok, title, children, href, action }: { ok: boolean | 'partial'; title: string; children: ReactNode; href: string; action: string }) {
  return (
    <li className={`ap-check ${ok === true ? 'ok' : ok === 'partial' ? 'partial' : 'todo'}`}>
      <span className="ap-check-mark" aria-hidden="true">
        {ok === true ? '✓' : ok === 'partial' ? '•' : '!'}
      </span>
      <div className="ap-check-body">
        <strong>{title}</strong>
        <div className="small muted">{children}</div>
      </div>
      <a className="btn small-btn" href={href}>
        {action}
      </a>
    </li>
  );
}

function SetupView({ me, status, onStatus }: { me: Me; status: AutopilotStatus; onStatus: () => void }) {
  const r = useApi<Readiness>('/v1/autopilot/readiness');
  const [error, setError] = useState<unknown>(null);
  const toggle = async () => {
    setError(null);
    try {
      await api('PUT', '/v1/autopilot/settings', { enabled: !status.enabled });
      onStatus();
    } catch (err) {
      setError(err);
    }
  };
  if (r.error) return <ErrorNotice error={r.error} />;
  if (!r.data) return <LoadingRows label="Checking your setup…" />;
  const d = r.data;
  const active = d.connections.filter((c) => c.status === 'active');
  const auto = Object.entries(d.categories)
    .filter(([, v]) => v === 'pre_authorized_within_limits')
    .map(([k]) => statusLabel(k));
  return (
    <div className="stack">
      <section className="card">
        <header>
          <h2>Readiness</h2>
          <span className="small muted">Live from your workspace</span>
        </header>
        <ul className="ap-checks">
          <Check ok={d.policyConfigured && d.approvedMarkets.length > 0 ? true : d.policyConfigured ? 'partial' : false} title="Your rules (autonomy policy)" href="/app/governance" action="Open rules">
            {d.policyConfigured ? `Configured. Runs on its own: ${auto.length ? auto.join(', ') : 'nothing (everything waits for approval)'}. Approved markets: ${d.approvedMarkets.join(', ') || 'none'}.` : 'Not configured: every action will wait for your approval.'}
          </Check>
          <Check ok={active.length > 0} title="Connections" href="/app/connections" action="Connect">
            {d.connections.length ? d.connections.map((c) => `${c.displayName} (${c.provider}, ${statusLabel(c.status).toLowerCase()})`).join('; ') : 'No accounts connected. Connect App Store Connect for downloads, Meta for posts.'}
          </Check>
          <Check ok={d.kpiSeries.length > 0} title="Data to measure" href="/app/analytics" action="Add data">
            {d.kpiSeries.length ? `KPI series: ${d.kpiSeries.map((s) => s.name).join(', ')}.` : 'No KPI data yet. Downloads arrive from App Store Connect; other metrics can be uploaded.'}
          </Check>
          <Check ok={d.evidence > 0} title="Evidence" href="/app/evidence" action="Add evidence">
            {d.evidence ? `${d.evidence} admitted evidence records. Ideas and actions must cite them.` : 'No evidence yet: the Autopilot will not invent facts, so ideas wait for evidence.'}
          </Check>
          <Check ok={d.approvedClaims > 0} title="Approved claims" href="/app/knowledge" action="Approve claims">
            {d.approvedClaims ? `${d.approvedClaims} approved claims content may state.` : 'No approved claims: content drafts stay blocked until you approve what may be said.'}
          </Check>
          <Check ok={d.modelGateway && d.approvedModels > 0} title="AI model" href="/app/governance" action="Models">
            {d.modelGateway && d.approvedModels > 0 ? `${d.approvedModels} approved model(s). AI spend this month: $${d.aiBudget.spentUsd.toFixed(2)}${d.aiBudget.limitUsd !== null ? ` of $${d.aiBudget.limitUsd}` : ''}.` : 'No approved AI model is available.'}
          </Check>
          <Check ok={me.mfaVerified} title="Two-factor sign-in" href="/app/settings" action="Security">
            {me.mfaVerified ? 'This session can approve actions.' : 'Approving actions needs a two-factor session.'}
          </Check>
        </ul>
      </section>
      <section className="card">
        <header>
          <h2>Autopilot</h2>
          <Badge value={status.enabled ? 'enabled' : 'disabled'} />
        </header>
        <p className="small">When on, the worker pursues your active goals every few minutes, even when nobody is signed in. Consequential actions still pass your rules, approvals, spending limits and emergency stops.</p>
        <ErrorNotice error={error} />
        {isAdmin(me) ? (
          <button type="button" className={status.enabled ? '' : 'primary'} onClick={() => void toggle()}>
            {status.enabled ? 'Turn the Autopilot off' : 'Turn the Autopilot on'}
          </button>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Growth goals                                                      */
/* ------------------------------------------------------------------ */

function GoalsView({ me, go }: { me: Me; go: (v: View) => void }) {
  const goals = useApi<Goal[]>('/v1/autopilot/goals');
  usePoll(goals.reload);
  return (
    <div className="stack">
      {canEdit(me) ? <GoalComposer onCreated={() => void goals.reload()} /> : null}
      {goals.error ? <ErrorNotice error={goals.error} /> : null}
      {!goals.data ? (
        <LoadingRows label="Loading goals…" />
      ) : goals.data.length === 0 ? (
        <EmptyState title="No goals yet">Describe what you want to achieve above, for example “Grow my app's organic downloads over the next 30 days with a $0 advertising budget.”</EmptyState>
      ) : (
        goals.data.map((g) => <GoalCard key={g.id} goal={g} me={me} onChange={() => void goals.reload()} go={go} />)
      )}
    </div>
  );
}

function GoalComposer({ onCreated }: { onCreated: () => void }) {
  const [text, setText] = useState('');
  const [d, setD] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const interpret = async () => {
    setBusy(true);
    setError(null);
    try {
      setD(await api<Draft>('POST', '/v1/autopilot/interpret', { text }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/autopilot/goals', d.draft);
      setD(null);
      setText('');
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<Draft['draft']>) => setD((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur));
  const setKpi = (patch: Partial<Kpi>) => setD((cur) => (cur ? { ...cur, draft: { ...cur.draft, kpi: { ...cur.draft.kpi, ...patch } } } : cur));
  return (
    <section className="card ap-composer">
      <header>
        <h2>New goal</h2>
      </header>
      <div className="field">
        <label htmlFor="ap-goal">What do you want to achieve?</label>
        <textarea id="ap-goal" rows={3} value={text} maxLength={2000} placeholder="Grow my app's organic downloads over the next 30 days with a $0 advertising budget." onChange={(e) => setText(e.target.value)} />
      </div>
      <button type="button" className="primary" disabled={busy || text.trim().length < 3} onClick={() => void interpret()}>
        Make a plan
      </button>
      <ErrorNotice error={error} />
      {d ? (
        <div className="ap-draft stack">
          {d.understood.length ? (
            <div className="notice ok small">
              <strong>Understood</strong>
              <ul className="tight">
                {d.understood.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {d.assumptions.length ? (
            <div className="notice warn small">
              <strong>Assumed — please check</strong>
              <ul className="tight">
                {d.assumptions.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ap-title">Goal name</label>
              <input id="ap-title" value={d.draft.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ap-kpi">Number to grow (metric key)</label>
              <input id="ap-kpi" value={d.draft.kpi.metricKey} onChange={(e) => setKpi({ metricKey: e.target.value.trim() })} />
              <span className="help">{d.draft.kpi.label}</span>
            </div>
            <div className="field">
              <label htmlFor="ap-pct">Target change (%)</label>
              <input id="ap-pct" type="number" value={d.draft.kpi.targetChangePct ?? ''} placeholder="optional" onChange={(e) => setKpi({ targetChangePct: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="ap-date">Target date</label>
              <input id="ap-date" type="date" value={d.draft.targetDate.slice(0, 10)} onChange={(e) => e.target.value && set({ targetDate: new Date(`${e.target.value}T23:59:00Z`).toISOString() })} />
            </div>
            <div className="field">
              <label htmlFor="ap-budget">Advertising budget for the whole goal (USD)</label>
              <input id="ap-budget" type="number" min={0} step={1} value={d.draft.adBudget.amountMicros / 1_000_000} onChange={(e) => set({ adBudget: { amountMicros: Math.max(0, Math.round(Number(e.target.value || 0) * 1_000_000)), currency: 'USD' } })} />
              <span className="help">$0 means no paid spend of any kind.</span>
            </div>
            <div className="field">
              <label htmlFor="ap-market">Market</label>
              <input id="ap-market" value={d.draft.market} maxLength={10} onChange={(e) => set({ market: e.target.value.toUpperCase() })} />
            </div>
          </div>
          <fieldset className="field">
            <legend>Channels the Autopilot may use</legend>
            <div className="choice-chips">
              {CHANNELS.map((c) => {
                const on = d.draft.channels.includes(c.key);
                const disabled = c.key === 'paid_ads' && d.draft.adBudget.amountMicros === 0;
                return (
                  <label key={c.key} className={`chip-check${on ? ' on' : ''}`} title={c.help}>
                    <input type="checkbox" checked={on && !disabled} disabled={disabled} onChange={() => set({ channels: on ? d.draft.channels.filter((x) => x !== c.key) : [...d.draft.channels, c.key] })} />
                    {c.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label className="row small">
            <input type="checkbox" checked={!d.draft.autoSubmit} onChange={(e) => set({ autoSubmit: !e.target.checked })} />
            Suggest only: I review every decision before it goes to the execution gateway
          </label>
          <button type="button" className="primary" disabled={busy || d.draft.channels.length === 0} onClick={() => void save()}>
            Start the Autopilot for this goal
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Progress({ m, kpi }: { m: Measurement | null | undefined; kpi: Kpi }) {
  if (m?.status !== 'measured') return <p className="small muted">No measured results yet{m?.note ? `: ${m.note}` : '.'}</p>;
  return (
    <div className="ap-progress">
      <div>
        <div className="stat">{num(m.actual)}</div>
        <div className="small muted">
          {kpi.label} over {m.daysObserved} day{m.daysObserved === 1 ? '' : 's'}
        </div>
      </div>
      {m.changeVsBaselinePct !== null ? (
        <div>
          <div className="stat">{`${m.changeVsBaselinePct >= 0 ? '+' : ''}${m.changeVsBaselinePct.toFixed(1)}%`}</div>
          <div className="small muted">vs the pre-goal daily average</div>
        </div>
      ) : null}
      {m.progressPct !== null ? (
        <div>
          <div className="stat">{`${m.progressPct.toFixed(0)}%`}</div>
          <div className="small muted">of the target ({num(m.target)})</div>
        </div>
      ) : null}
    </div>
  );
}

function GoalCard({ goal: g, me, onChange, go }: { goal: Goal; me: Me; onChange: () => void; go: (v: View) => void }) {
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const run = async (command: 'pause' | 'resume' | 'cancel' | 'run_now') => {
    setError(null);
    try {
      await api('POST', `/v1/autopilot/goals/${g.id}/${command}`);
      setConfirm(false);
      onChange();
    } catch (err) {
      setError(err);
    }
  };
  const m = g.memory.finalMeasurement ?? g.memory.lastMeasurement;
  const c = g.latestCycle;
  return (
    <section className="card ap-goal">
      <header>
        <h2>{g.title}</h2>
        <Badge value={g.status} />
      </header>
      <p className="small muted">“{g.statement}”</p>
      <div className="ap-facts small">
        <span>
          <strong>Measure:</strong> {g.kpi.label}
        </span>
        <span>
          <strong>Until:</strong> {g.targetDate.slice(0, 10)} ({daysLeft(g.targetDate)} days left)
        </span>
        <span>
          <strong>Ad budget:</strong> {money(g.adBudgetMicros, g.currency)}
        </span>
        <span>
          <strong>Channels:</strong> {g.channels.map((x) => CHANNELS.find((y) => y.key === x)?.label ?? x).join(', ')}
        </span>
        <span>
          <strong>Mode:</strong> {g.autoSubmit ? 'acts within your rules' : 'suggest only'}
        </span>
      </div>
      <Progress m={m} kpi={g.kpi} />
      <div className="ap-now small">
        {c ? (
          <>
            <strong>Cycle {c.seq}</strong> <Badge value={c.status} /> {c.status === 'running' ? `started ${relativeTime(c.startedAt)}` : c.finishedAt ? `finished ${relativeTime(c.finishedAt)}` : ''}
            {c.summary ? <div className="muted">{c.summary}</div> : null}
          </>
        ) : (
          <span className="muted">The first cycle starts within a minute.</span>
        )}
        {g.status === 'active' && g.nextRunAt && c?.status !== 'running' ? (
          <div className="muted">
            Next cycle {relativeTime(g.nextRunAt)}
            {g.pendingTrigger ? ` (${g.pendingTrigger})` : ''}.
          </div>
        ) : null}
        {g.statusReason ? <div className="muted">{g.statusReason}</div> : null}
      </div>
      <ErrorNotice error={error} />
      <div className="row">
        <button type="button" onClick={() => go('activity')}>
          See activity
        </button>
        {canEdit(me) && g.status === 'active' ? (
          <>
            <button type="button" onClick={() => void run('run_now')}>
              Run now
            </button>
            <button type="button" onClick={() => void run('pause')}>
              Pause
            </button>
          </>
        ) : null}
        {canEdit(me) && g.status === 'paused' ? (
          <button type="button" className="primary" onClick={() => void run('resume')}>
            Resume
          </button>
        ) : null}
        {canEdit(me) && (g.status === 'active' || g.status === 'paused') ? (
          confirm ? (
            <>
              <span className="small">Stop this goal for good?</span>
              <button type="button" className="danger" onClick={() => void run('cancel')}>
                Yes, cancel goal
              </button>
              <button type="button" onClick={() => setConfirm(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirm(true)}>
              Cancel goal
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 3. AI activity                                                       */
/* ------------------------------------------------------------------ */

function TaskItem({ t, goalTitle }: { t: Task; goalTitle?: string }) {
  const need = t.needs ? NEEDS[t.needs] : null;
  return (
    <li className={`ap-task ${t.status}`}>
      <div className="ap-task-head">
        <strong>{t.title}</strong>
        <Badge value={t.status} />
      </div>
      {t.detail ? <div className="small">{t.detail}</div> : null}
      <div className="small muted ap-task-meta">
        {goalTitle ? <span>{goalTitle}</span> : null}
        <span>{t.modules.join(' · ')}</span>
        <span>{relativeTime(t.finishedAt ?? t.updatedAt)}</span>
        {t.attempts > 1 ? <span>attempt {t.attempts}</span> : null}
      </div>
      {need ? (
        <a className="btn small-btn" href={need.href}>
          {need.label}
        </a>
      ) : null}
      <details className="small muted">
        <summary>Why this step</summary>
        {t.reason}
      </details>
    </li>
  );
}

function ActivityView() {
  const act = useApi<{ task: Task; goalTitle: string }[]>('/v1/autopilot/activity?limit=150');
  const goals = useApi<Goal[]>('/v1/autopilot/goals');
  const reload = useCallback(async () => {
    await Promise.all([act.reload(), goals.reload()]);
  }, [act.reload, goals.reload]);
  usePoll(reload);
  const rows = act.data ?? [];
  const latestCycles = useMemo(() => new Set((goals.data ?? []).map((g) => g.latestCycle?.id).filter(Boolean)), [goals.data]);
  if (act.error) return <ErrorNotice error={act.error} />;
  if (!act.data) return <LoadingRows label="Loading activity…" />;
  if (!rows.length) return <EmptyState title="Nothing has run yet">Create a goal; the first cycle starts within a minute and every step appears here as it happens.</EmptyState>;
  const now = rows.filter((r) => r.task.status === 'running' || r.task.status === 'waiting');
  const blocked = rows.filter((r) => (r.task.status === 'blocked' || r.task.status === 'failed') && latestCycles.has(r.task.cycleId));
  const done = rows.filter((r) => r.task.status === 'completed' || r.task.status === 'skipped').slice(0, 40);
  const next = rows.filter((r) => r.task.status === 'pending');
  const Section = ({ title, items, empty }: { title: string; items: typeof rows; empty: string }) => (
    <section className="card">
      <header>
        <h2>{title}</h2>
        <span className="small muted">{items.length}</span>
      </header>
      {items.length ? (
        <ul className="ap-tasks">
          {items.map((r) => (
            <TaskItem key={r.task.id} t={r.task} goalTitle={r.goalTitle} />
          ))}
        </ul>
      ) : (
        <p className="small muted">{empty}</p>
      )}
    </section>
  );
  return (
    <div className="stack">
      <Section title="Doing now" items={now} empty="Nothing is running at this moment." />
      <Section title="Blocked — needs you" items={blocked} empty="Nothing is blocked." />
      <Section title="Up next" items={next} empty="No steps are queued in the current cycles." />
      <section className="card">
        <header>
          <h2>Next cycles</h2>
        </header>
        <ul className="tight small">
          {(goals.data ?? [])
            .filter((g) => g.status === 'active')
            .map((g) => (
              <li key={g.id}>
                <strong>{g.title}</strong>: {g.latestCycle?.status === 'running' ? 'cycle in progress' : g.nextRunAt ? `next cycle ${relativeTime(g.nextRunAt)}` : 'not scheduled'}
              </li>
            ))}
        </ul>
      </section>
      <Section title="Completed" items={done} empty="Nothing completed yet." />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Pending approvals                                                 */
/* ------------------------------------------------------------------ */

interface Inbox {
  approvals: { id: string; actionType: string; statusReason: string | null; createdAt: string; goalTitle: string }[];
  otherApprovals: number;
  decisions: { id: string; objective: string; proposedAction: { actionType: string; params: Record<string, unknown> } | null; narrative: string | null; createdAt: string; goalTitle: string }[];
  drafts: { id: string; title: string; channel: string; createdAt: string }[];
}

function ApprovalsView({ me, onChange }: { me: Me; onChange: () => void }) {
  const inbox = useApi<Inbox>('/v1/autopilot/inbox');
  usePoll(inbox.reload);
  const [error, setError] = useState<unknown>(null);
  const decide = async (id: string, accept: boolean) => {
    setError(null);
    try {
      if (accept) await api('POST', `/v1/brain/decisions/${id}/accept`);
      else await api('POST', `/v1/brain/decisions/${id}/reject`, { reason: 'declined in the Autopilot inbox' });
      await inbox.reload();
      onChange();
    } catch (err) {
      setError(err);
    }
  };
  if (inbox.error) return <ErrorNotice error={inbox.error} />;
  if (!inbox.data) return <LoadingRows label="Loading approvals…" />;
  const d = inbox.data;
  const total = d.approvals.length + d.decisions.length + d.drafts.length;
  return (
    <div className="stack">
      <ErrorNotice error={error} />
      {total === 0 ? <EmptyState title="Nothing waits for you">When your policy requires a person, the action appears here with the reason.</EmptyState> : null}
      {d.approvals.length ? (
        <section className="card">
          <header>
            <h2>Actions to approve</h2>
          </header>
          <ul className="ap-tasks">
            {d.approvals.map((a) => (
              <li key={a.id} className="ap-task waiting">
                <div className="ap-task-head">
                  <strong>{statusLabel(a.actionType)}</strong>
                  <span className="small muted">{relativeTime(a.createdAt)}</span>
                </div>
                <div className="small">
                  For goal “{a.goalTitle}”. {a.statusReason}
                </div>
                <a className="btn primary small-btn" href={`/app/approvals?id=${a.id}`}>
                  Review exactly what will happen
                </a>
              </li>
            ))}
          </ul>
          <p className="small muted">Approval shows the exact payload, the policy reasons and needs a two-factor session; it is bound to that payload.</p>
        </section>
      ) : null}
      {d.decisions.length ? (
        <section className="card">
          <header>
            <h2>Decisions to review</h2>
          </header>
          <ul className="ap-tasks">
            {d.decisions.map((x) => (
              <li key={x.id} className="ap-task waiting">
                <div className="ap-task-head">
                  <strong>{x.proposedAction ? statusLabel(x.proposedAction.actionType) : 'No action'}</strong>
                  <span className="small muted">{relativeTime(x.createdAt)}</span>
                </div>
                <div className="small">
                  For goal “{x.goalTitle}”. {x.narrative}
                </div>
                {canEdit(me) ? (
                  <div className="row">
                    <button type="button" className="primary" onClick={() => void decide(x.id, true)}>
                      Go ahead
                    </button>
                    <button type="button" onClick={() => void decide(x.id, false)}>
                      Decline
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="small muted">Going ahead hands the decision to the execution gateway; your policy may still ask for an approval.</p>
        </section>
      ) : null}
      {d.drafts.length ? (
        <section className="card">
          <header>
            <h2>Content drafts</h2>
          </header>
          <ul className="ap-tasks">
            {d.drafts.map((b) => (
              <li key={b.id} className="ap-task waiting">
                <div className="ap-task-head">
                  <strong>{b.title}</strong>
                  <span className="small muted">{b.channel}</span>
                </div>
                <a className="btn small-btn" href="/app/creative">
                  Review the brief
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {d.otherApprovals ? (
        <p className="small">
          {d.otherApprovals} other action{d.otherApprovals === 1 ? '' : 's'} outside the Autopilot also wait: <a href="/app/approvals">open all approvals</a>.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Results                                                           */
/* ------------------------------------------------------------------ */

function ResultsView() {
  const goals = useApi<Goal[]>('/v1/autopilot/goals');
  const [sel, setSel] = useState<string | null>(null);
  const id = sel ?? goals.data?.[0]?.id ?? null;
  const detail = useApi<{ goal: Goal; cycles: Cycle[]; actions: { id: string; actionType: string; status: string; updatedAt: string }[] }>(id ? `/v1/autopilot/goals/${id}` : null);
  usePoll(detail.reload, 30_000);
  if (goals.error) return <ErrorNotice error={goals.error} />;
  if (!goals.data) return <LoadingRows label="Loading results…" />;
  if (!goals.data.length) return <EmptyState title="No goals yet">Results appear once a goal has measured data.</EmptyState>;
  const d = detail.data;
  const m = d ? (d.goal.memory.finalMeasurement ?? d.goal.memory.lastMeasurement) : null;
  const verified = d?.actions.filter((a) => a.status === 'VERIFIED').length ?? 0;
  return (
    <div className="stack">
      {goals.data.length > 1 ? (
        <div className="field">
          <label htmlFor="ap-res-goal">Goal</label>
          <select id="ap-res-goal" value={id ?? ''} onChange={(e) => setSel(e.target.value)}>
            {goals.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {detail.error ? <ErrorNotice error={detail.error} /> : null}
      {!d ? (
        <LoadingRows />
      ) : (
        <>
          <section className="card">
            <header>
              <h2>{d.goal.kpi.label}</h2>
              <span className="small muted">{m ? `measured ${relativeTime(m.measuredAt)}` : 'not measured yet'}</span>
            </header>
            <Progress m={m} kpi={d.goal.kpi} />
            {m?.status === 'measured' ? (
              <ul className="tight small">
                {m.baselineForSamePeriod !== null ? <li>Pre-goal baseline for the same number of days: {num(m.baselineForSamePeriod)}</li> : null}
                {m.forecast ? (
                  <li>
                    No-action forecast for {m.forecast.days} day{m.forecast.days === 1 ? '' : 's'}: {num(m.forecast.expected)} (80% range {num(m.forecast.low)}–{num(m.forecast.high)}). Actual is <strong>{m.forecast.position}</strong> the range.
                  </li>
                ) : (
                  <li>No forecast covers the measured days yet.</li>
                )}
              </ul>
            ) : null}
            {m?.note ? <p className="small muted">{m.note}</p> : null}
          </section>
          <section className="card">
            <header>
              <h2>Actions</h2>
              <span className="small muted">{verified} verified</span>
            </header>
            {d.actions.length ? (
              <ul className="tight small">
                {d.actions.map((a) => (
                  <li key={a.id}>
                    {statusLabel(a.actionType)} — <Badge value={a.status} /> {relativeTime(a.updatedAt)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No actions yet. Only independently verified actions count as done.</p>
            )}
          </section>
          <section className="card">
            <header>
              <h2>Cycles</h2>
            </header>
            <ul className="ap-tasks">
              {d.cycles.map((c) => (
                <li key={c.id} className={`ap-task ${c.status}`}>
                  <div className="ap-task-head">
                    <strong>Cycle {c.seq}</strong>
                    <Badge value={c.status} />
                  </div>
                  <div className="small">{c.summary ?? 'In progress.'}</div>
                  <details className="small muted">
                    <summary>Plan: modules used and left out</summary>
                    <ul className="tight">
                      {c.plan.steps.map((s) => (
                        <li key={s.kind}>
                          {s.title} ({s.modules.join(', ')}): {s.reason}
                        </li>
                      ))}
                      {c.plan.notUsed.map((n) => (
                        <li key={n.modules.join()}>
                          Not used {n.modules.join(', ')}: {n.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          </section>
          {d.goal.memory.lessons?.length ? (
            <section className="card">
              <header>
                <h2>What the Autopilot learned</h2>
              </header>
              <ul className="tight small">
                {d.goal.memory.lessons.slice(0, 12).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

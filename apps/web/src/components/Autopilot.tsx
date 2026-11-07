import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { actionName, actionStateLabel, type GoalLite, goalNeedsAttention } from '../lib/dashboard.js';
import { formatDay, readableText, relativeTime, statusLabel } from '../lib/format.js';
import { Ico } from './Icons.js';
import { GoalKpiChart } from './Performance.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

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
  data: { label: 'Add or connect KPI data', href: '/app/apps' },
  connection: { label: 'Fix a connection', href: '/app/connections' },
  evidence: { label: 'Add evidence', href: '/app/evidence' },
  claims: { label: 'Approve claims', href: '/app/knowledge' },
  approval: { label: 'Review in Approvals', href: '/app/approvals' },
  configuration: { label: 'Check your rules', href: '/app/governance' },
  model: { label: 'Approve an AI model', href: '/app/governance' },
  budget: { label: 'Review the goal budget', href: '/app/goals' },
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
interface CycleNote {
  taskId: string;
  kind: string;
  title: string;
  detail: string | null;
}
interface Cycle {
  id: string;
  seq: number;
  status: string;
  trigger: string;
  summary: string | null;
  /** Steps that had no data but did not block what the cycle delivered (e.g. a forecast next to a verified post). */
  unavailable?: CycleNote[];
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

/** Shown when the Autopilot is available but not switched on. */
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
  marketScopes?: Record<string, string[]>;
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

export function SetupView({ me, status, onStatus }: { me: Me; status: AutopilotStatus; onStatus: () => void }) {
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
            {d.policyConfigured
              ? `Configured. Runs on its own: ${auto.length ? auto.join(', ') : 'nothing (everything waits for approval)'}. Approved markets: ${d.approvedMarkets.map((m) => (d.marketScopes?.[m]?.length ? `${m} (${d.marketScopes[m]!.join(', ').replaceAll('_', ' ')})` : m)).join(', ') || 'none'}.`
              : 'Not configured: every action will wait for your approval.'}
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

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'paused', label: 'Paused' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const matches = (g: Goal, f: FilterKey) => (f === 'all' ? true : f === 'attention' ? g.status === 'active' && goalNeedsAttention(g as unknown as GoalLite) : f === 'completed' ? g.status === 'completed' || g.status === 'failed' : g.status === f);

/** Goals & OKRs: the list with filters, or one goal's details (`?id=`). */
export function GoalsView({ me, autopilot, onEnabled }: { me: Me; autopilot: AutopilotStatus | null; onEnabled: () => void }) {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const id = params.get('id');
  if (id) return <GoalDetail id={id} me={me} />;
  const f = params.get('filter');
  return <GoalList me={me} autopilot={autopilot} onEnabled={onEnabled} initialFilter={FILTERS.some((x) => x.key === f) ? (f as FilterKey) : 'all'} />;
}

function GoalList({ me, autopilot, onEnabled, initialFilter }: { me: Me; autopilot: AutopilotStatus | null; onEnabled: () => void; initialFilter: FilterKey }) {
  const goals = useApi<Goal[]>('/v1/autopilot/goals');
  usePoll(goals.reload);
  const [filter, setFilter] = useState<FilterKey>(initialFilter);
  const [composing, setComposing] = useState(() => typeof window !== 'undefined' && window.location.hash === '#new');
  const list = goals.data ?? [];
  const shown = list.filter((g) => matches(g, filter));
  const showComposer = canEdit(me) && (composing || (goals.data !== null && goals.data.length === 0));
  return (
    <div className="stack">
      {autopilot?.available && !autopilot.enabled ? <AutopilotOffer me={me} onEnabled={onEnabled} /> : null}
      <div className="toolbar">
        <fieldset className="seg">
          <legend className="sr-only">Filter goals</legend>
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} className={`seg-btn${filter === f.key ? ' on' : ''}`} onClick={() => setFilter(f.key)}>
              {f.label}
              {goals.data ? <span className="seg-count">{list.filter((g) => matches(g, f.key)).length}</span> : null}
            </button>
          ))}
        </fieldset>
        {canEdit(me) && !showComposer ? (
          <button type="button" className="primary" onClick={() => setComposing(true)}>
            <Ico name="plus" size={17} /> New goal
          </button>
        ) : null}
      </div>
      {showComposer ? (
        <GoalComposer
          onCreated={() => {
            setComposing(false);
            void goals.reload();
          }}
          onCancel={list.length ? () => setComposing(false) : undefined}
        />
      ) : null}
      {goals.error ? <ErrorNotice error={goals.error} /> : null}
      {!goals.data && !goals.error ? (
        <LoadingRows label="Loading goals…" />
      ) : goals.data && goals.data.length === 0 ? (
        <EmptyState title="No goals yet">{canEdit(me) ? "Describe what you want to achieve above, for example “Grow my app's organic downloads over the next 30 days with a $0 advertising budget.”" : 'An owner, admin or growth operator can create the first goal.'}</EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="No goals match this filter">
          <button type="button" className="link-btn" onClick={() => setFilter('all')}>
            Show all goals
          </button>
        </EmptyState>
      ) : (
        shown.map((g) => <GoalCard key={g.id} goal={g} me={me} onChange={() => void goals.reload()} />)
      )}
    </div>
  );
}

function GoalComposer({ onCreated, onCancel }: { onCreated: () => void; onCancel?: () => void }) {
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
    <section className="card ap-composer" id="new">
      <header className="card-head">
        <h2 className="card-title">New goal</h2>
        {onCancel ? (
          <button type="button" className="ghost" onClick={onCancel}>
            Close
          </button>
        ) : null}
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

export function Progress({ m, kpi }: { m: Measurement | null | undefined; kpi: Kpi }) {
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

function GoalCommands({ goal: g, me, onChange, compact = false }: { goal: Goal; me: Me; onChange: () => void; compact?: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (command: 'pause' | 'resume' | 'cancel' | 'run_now') => {
    setError(null);
    setBusy(true);
    try {
      await api('POST', `/v1/autopilot/goals/${g.id}/${command}`);
      setConfirm(false);
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit(me)) return null;
  return (
    <>
      <div className="row">
        {g.status === 'active' ? (
          <>
            <button type="button" disabled={busy} onClick={() => void run('run_now')}>
              <Ico name="play" size={15} /> Run now
            </button>
            <button type="button" disabled={busy} onClick={() => void run('pause')}>
              <Ico name="pause" size={15} /> Pause
            </button>
          </>
        ) : null}
        {g.status === 'paused' ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void run('resume')}>
            <Ico name="play" size={15} /> Resume
          </button>
        ) : null}
        {!compact && (g.status === 'active' || g.status === 'paused') ? (
          confirm ? (
            <>
              <span className="small">Stop this goal for good?</span>
              <button type="button" className="danger" disabled={busy} onClick={() => void run('cancel')}>
                Yes, cancel goal
              </button>
              <button type="button" onClick={() => setConfirm(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="ghost" onClick={() => setConfirm(true)}>
              Cancel goal
            </button>
          )
        ) : null}
      </div>
      <ErrorNotice error={error} />
    </>
  );
}

function forecastWords(g: Goal): string {
  const m = g.memory.finalMeasurement ?? g.memory.lastMeasurement;
  if (m?.forecast) return `Available: actual is ${m.forecast.position} the no-action range`;
  if ((g.latestCycle?.unavailable ?? []).some((n) => n.kind === 'forecast')) return 'Not available yet (no data; not blocking)';
  return 'Not available yet';
}

function GoalCard({ goal: g, me, onChange }: { goal: Goal; me: Me; onChange: () => void }) {
  const m = g.memory.finalMeasurement ?? g.memory.lastMeasurement;
  const c = g.latestCycle;
  const attention = g.status === 'active' && goalNeedsAttention(g as unknown as GoalLite);
  return (
    <section className="card ap-goal goal-card">
      <header className="goal-head">
        <div className="goal-name">
          <h2>{g.title}</h2>
          <p className="small muted">“{g.statement}”</p>
        </div>
        <div className="goal-badges">
          <Badge value={g.status} />
          {attention ? <span className="status-pill warn">Needs attention</span> : null}
        </div>
      </header>
      <Progress m={m} kpi={g.kpi} />
      {m?.status === 'measured' && m.progressPct !== null ? (
        <div className="goal-bar" role="progressbar" aria-label={`Progress toward the target of ${g.kpi.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, Math.max(0, m.progressPct)))}>
          <span style={{ width: `${Math.min(100, Math.max(0, m.progressPct))}%` }} />
        </div>
      ) : null}
      <dl className="goal-facts">
        <div>
          <dt>Measure</dt>
          <dd>{g.kpi.label}</dd>
        </div>
        <div>
          <dt>Until</dt>
          <dd>
            {formatDay(g.targetDate.slice(0, 10))} ({daysLeft(g.targetDate)} days left)
          </dd>
        </div>
        <div>
          <dt>Ad budget</dt>
          <dd>{money(g.adBudgetMicros, g.currency)}</dd>
        </div>
        <div>
          <dt>Channels</dt>
          <dd>{g.channels.map((x) => CHANNELS.find((y) => y.key === x)?.label ?? x).join(', ')}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{g.autoSubmit ? 'Acts within your rules' : 'Suggest only'}</dd>
        </div>
        <div>
          <dt>Forecast</dt>
          <dd>{forecastWords(g)}</dd>
        </div>
      </dl>
      <div className="ap-now small">
        {c ? (
          <>
            <strong>Cycle {c.seq}</strong> <Badge value={c.status} /> {c.status === 'running' ? `started ${relativeTime(c.startedAt)}` : c.finishedAt ? `finished ${relativeTime(c.finishedAt)}` : ''}
            {c.summary ? <div className="muted">{readableText(c.summary, { userId: me.userId })}</div> : null}
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
        {g.statusReason ? <div className="muted">{readableText(g.statusReason, { userId: me.userId })}</div> : null}
      </div>
      <div className="goal-actions">
        <a className="btn" href={`/app/goals?id=${g.id}`}>
          Details &amp; timeline <Ico name="arrow-right" size={15} />
        </a>
        <GoalCommands goal={g} me={me} onChange={onChange} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 3. AI activity                                                       */
/* ------------------------------------------------------------------ */

function TaskItem({ t, goalTitle, label }: { t: Task; goalTitle?: string; label?: string }) {
  const need = t.needs ? NEEDS[t.needs] : null;
  const shown = label ?? t.status;
  return (
    <li className={`ap-task ${shown}`}>
      <div className="ap-task-head">
        <strong>{t.title}</strong>
        <Badge value={shown} />
      </div>
      {t.detail ? <div className="small">{readableText(t.detail)}</div> : null}
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

export function ActivityView({ goalId }: { goalId?: string } = {}) {
  const act = useApi<{ task: Task; goalTitle: string }[]>(`/v1/autopilot/activity?limit=150${goalId ? `&goalId=${goalId}` : ''}`);
  const goals = useApi<Goal[]>('/v1/autopilot/goals');
  const reload = useCallback(async () => {
    await Promise.all([act.reload(), goals.reload()]);
  }, [act.reload, goals.reload]);
  usePoll(reload);
  const rows = act.data ?? [];
  const latestCycles = useMemo(() => new Set((goals.data ?? []).map((g) => g.latestCycle?.id).filter(Boolean)), [goals.data]);
  // A forecast without data next to a verified post is a limitation of that cycle, not a blocker.
  const unavailableIds = useMemo(() => new Set((goals.data ?? []).flatMap((g) => (g.latestCycle?.unavailable ?? []).map((n) => n.taskId))), [goals.data]);
  if (act.error) return <ErrorNotice error={act.error} />;
  if (!act.data) return <LoadingRows label="Loading activity…" />;
  if (!rows.length) return <EmptyState title="Nothing has run yet">Create a goal; the first cycle starts within a minute and every step appears here as it happens.</EmptyState>;
  const now = rows.filter((r) => r.task.status === 'running' || r.task.status === 'waiting');
  const blocked = rows.filter((r) => (r.task.status === 'blocked' || r.task.status === 'failed') && latestCycles.has(r.task.cycleId) && !unavailableIds.has(r.task.id));
  const unavailable = rows.filter((r) => unavailableIds.has(r.task.id));
  const done = rows.filter((r) => r.task.status === 'completed' || r.task.status === 'skipped').slice(0, 40);
  const next = rows.filter((r) => r.task.status === 'pending');
  const Section = ({ title, items, empty, label }: { title: string; items: typeof rows; empty: string; label?: string }) => (
    <section className="card">
      <header>
        <h2>{title}</h2>
        <span className="small muted">{items.length}</span>
      </header>
      {items.length ? (
        <ul className="ap-tasks">
          {items.map((r) => (
            <TaskItem key={r.task.id} t={r.task} goalTitle={r.goalTitle} label={label} />
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
      {unavailable.length ? <Section title="Not available yet — not blocking" items={unavailable} empty="" label="unavailable" /> : null}
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
  postDrafts?: PostDraft[];
}

interface PostDraft {
  id: string;
  caption: string;
  createdAt: string;
  claims: { id: string; text: string; status: string }[];
  review: { language?: string; market?: string; evidenceIds?: string[] };
  statusReason: string | null;
}

/** A post draft the Autopilot did not publish itself (D-035/D-036): a person schedules it (then policy and approval apply) or discards it. */
function PostDraftItem({ draft, editable, onDone, onError }: { draft: PostDraft; editable: boolean; onDone: () => void; onError: (err: unknown) => void }) {
  const [when, setWhen] = useState('');
  const act = async (path: string, body?: unknown) => {
    try {
      await api('POST', path, body);
      onDone();
    } catch (err) {
      onError(err);
    }
  };
  const evidence = draft.review.evidenceIds?.length ?? 0;
  return (
    <li className="ap-task waiting">
      <div className="ap-task-head">
        <strong>Exploratory post{draft.review.language === 'bn' ? ' (Bangla)' : ''}</strong>
        <span className="small muted">{relativeTime(draft.createdAt)}</span>
      </div>
      <p className="ap-draft-text" lang={draft.review.language}>
        {draft.caption}
      </p>
      <div className="small muted">
        {draft.claims.length ? `States ${draft.claims.length} approved claim${draft.claims.length === 1 ? '' : 's'}: ${draft.claims.map((c) => `“${c.text}”`).join(' · ')}. ` : 'States no product claim. '}
        Based on {evidence} evidence record{evidence === 1 ? '' : 's'}. Not forecast-validated.
        {draft.statusReason?.startsWith('Not published automatically') ? ` ${draft.statusReason}.` : ''}
      </div>
      {editable ? (
        <div className="row">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Publish time" />
          <button type="button" disabled={!when} onClick={() => void act(`/v1/social/drafts/${draft.id}/schedule`, { scheduledAt: new Date(when).toISOString(), geographies: draft.review.market ? [draft.review.market] : [] })}>
            Schedule (needs approval)
          </button>
          <button type="button" onClick={() => void act(`/v1/social/drafts/${draft.id}/discard`)}>
            Discard
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function ApprovalsInbox({ me, onChange, withActions = true }: { me: Me; onChange: () => void; withActions?: boolean }) {
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
  if (inbox.error) return (inbox.error as { status?: number }).status === 404 || (inbox.error as { status?: number }).status === 403 ? null : <ErrorNotice error={inbox.error} />;
  if (!inbox.data) return <LoadingRows label="Loading the Autopilot inbox…" />;
  const d = { ...inbox.data, approvals: withActions ? inbox.data.approvals : [] };
  const posts = d.postDrafts ?? [];
  const total = d.approvals.length + d.decisions.length + d.drafts.length + posts.length;
  const reload = () => {
    void inbox.reload();
    onChange();
  };
  return (
    <div className="stack inbox" id="inbox">
      <ErrorNotice error={error} />
      {total === 0 ? <EmptyState title="Nothing waits for you">{withActions ? 'When your policy requires a person, the action appears here with the reason.' : 'No Autopilot decisions or drafts wait for a person. Actions that need approval are listed below.'}</EmptyState> : null}
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
                  For goal “{a.goalTitle}”. {a.statusReason ? readableText(a.statusReason, { userId: me.userId }) : null}
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
      {posts.length ? (
        <section className="card">
          <header>
            <h2>Facebook post drafts</h2>
          </header>
          <ul className="ap-tasks">
            {posts.map((p) => (
              <PostDraftItem key={p.id} draft={p} editable={canEdit(me)} onDone={reload} onError={setError} />
            ))}
          </ul>
          <p className="small muted">
            Exploratory drafts from approved claims and your Page's own data, not validated by a forecast. The Autopilot publishes posts itself when your publishing policy allows it; these are the ones it did not (suggest-only goals, or posts the policy stopped). Scheduling one sends it through your policy and
            approval.
          </p>
        </section>
      ) : null}
      {withActions && d.otherApprovals ? (
        <p className="small">
          {d.otherApprovals} other action{d.otherApprovals === 1 ? '' : 's'} outside the Autopilot also wait: <a href="/app/approvals">open all approvals</a>.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. One goal: KPI, timeline, actions, decisions                        */
/* ------------------------------------------------------------------ */

interface DecisionRow {
  id: string;
  objective: string;
  narrative: string | null;
  status: string;
  goalId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const when = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export function GoalDetail({ id, me }: { id: string; me: Me }) {
  const detail = useApi<{ goal: Goal; cycles: Cycle[]; actions: { id: string; actionType: string; status: string; updatedAt: string }[] }>(`/v1/autopilot/goals/${id}`);
  const activity = useApi<{ task: Task; goalTitle: string }[]>(`/v1/autopilot/activity?goalId=${id}&limit=200`);
  const decisions = useApi<DecisionRow[]>('/v1/brain/decisions');
  const reload = useCallback(async () => {
    await Promise.all([detail.reload(), activity.reload()]);
  }, [detail.reload, activity.reload]);
  usePoll(reload, 30_000);
  if (detail.error) {
    return (
      <div className="stack">
        <a className="back-link" href="/app/goals">
          <Ico name="chevron-left" size={16} /> All goals
        </a>
        <ErrorNotice error={detail.error} />
      </div>
    );
  }
  if (!detail.data) return <LoadingRows label="Loading the goal…" />;
  const { goal: g, cycles, actions } = detail.data;
  const m = g.memory.finalMeasurement ?? g.memory.lastMeasurement;
  const verified = actions.filter((a) => a.status === 'VERIFIED').length;
  const tasksByCycle = new Map<string, Task[]>();
  for (const r of activity.data ?? []) tasksByCycle.set(r.task.cycleId, [...(tasksByCycle.get(r.task.cycleId) ?? []), r.task]);
  const myDecisions = (decisions.data ?? []).filter((d) => d.goalId === id).slice(0, 8);
  return (
    <div className="stack goal-detail">
      <a className="back-link" href="/app/goals">
        <Ico name="chevron-left" size={16} /> All goals
      </a>
      <section className="card">
        <header className="goal-head">
          <div className="goal-name">
            <h2>{g.title}</h2>
            <p className="small muted">“{g.statement}”</p>
          </div>
          <div className="goal-badges">
            <Badge value={g.status} />
          </div>
        </header>
        <dl className="goal-facts">
          <div>
            <dt>Started</dt>
            <dd>{formatDay(g.startsAt.slice(0, 10))}</dd>
          </div>
          <div>
            <dt>Until</dt>
            <dd>
              {formatDay(g.targetDate.slice(0, 10))} ({daysLeft(g.targetDate)} days left)
            </dd>
          </div>
          <div>
            <dt>Next run</dt>
            <dd>{g.status === 'active' ? (g.latestCycle?.status === 'running' ? 'Running now' : g.nextRunAt ? `${relativeTime(g.nextRunAt)} (${when(g.nextRunAt)})` : 'Not scheduled') : 'Not scheduled (goal is not active)'}</dd>
          </div>
          <div>
            <dt>Forecast</dt>
            <dd>{forecastWords(g)}</dd>
          </div>
          <div>
            <dt>Cycles</dt>
            <dd>{cycles.length}</dd>
          </div>
          <div>
            <dt>Verified actions</dt>
            <dd>{verified}</dd>
          </div>
        </dl>
        <GoalCommands goal={g} me={me} onChange={() => void reload()} />
      </section>

      <section className="card">
        <header className="card-head">
          <h2 className="card-title">{g.kpi.label}</h2>
          <span className="small muted">{m ? `measured ${relativeTime(m.measuredAt)}` : 'not measured yet'}</span>
        </header>
        <Progress m={m} kpi={g.kpi} />
        {m?.status === 'measured' ? (
          <ul className="tight small">
            {m.baselineForSamePeriod !== null ? <li>Pre-goal baseline for the same number of days: {num(m.baselineForSamePeriod)}</li> : null}
            {m.forecast ? (
              <li>
                No-action forecast for {m.forecast.days} day{m.forecast.days === 1 ? '' : 's'}: {num(m.forecast.expected)} (80% range {num(m.forecast.low)}–{num(m.forecast.high)}). Actual is <strong>{m.forecast.position}</strong> the range. This is an association, not proof of cause.
              </li>
            ) : (
              <li>No forecast covers the measured days yet.</li>
            )}
          </ul>
        ) : null}
        {m?.note ? <p className="small muted">{m.note}</p> : null}
        <GoalKpiChart metricKey={g.kpi.metricKey} label={g.kpi.label} since={g.startsAt} />
      </section>

      <section className="card" aria-labelledby="goal-timeline">
        <header className="card-head">
          <h2 className="card-title" id="goal-timeline">
            Execution timeline
          </h2>
          <span className="small muted">{cycles.length ? `${cycles.length} cycle${cycles.length === 1 ? '' : 's'}` : 'no cycles yet'}</span>
        </header>
        {cycles.length === 0 ? (
          <p className="small muted">The first cycle starts within a minute of the goal becoming active.</p>
        ) : (
          <ol className="goal-timeline">
            {cycles.map((c) => {
              const tasks = tasksByCycle.get(c.id) ?? [];
              const unavailable = new Set((c.unavailable ?? []).map((n) => n.taskId));
              return (
                <li key={c.id} className={`tl-item ${c.status}`}>
                  <span className="tl-dot" aria-hidden="true" />
                  <div className="tl-body">
                    <div className="tl-head">
                      <strong>Cycle {c.seq}</strong>
                      <Badge value={c.status} />
                      <span className="small muted">
                        {when(c.startedAt)}
                        {c.finishedAt ? ` → ${when(c.finishedAt)}` : ' · running'}
                      </span>
                    </div>
                    <p className="small">{c.summary ? readableText(c.summary, { userId: me.userId }) : 'In progress.'}</p>
                    {tasks.length ? (
                      <ul className="tl-steps">
                        {tasks.map((t) => {
                          const label = unavailable.has(t.id) ? 'unavailable' : t.status;
                          return (
                            <li key={t.id} className={`tl-step ${label}`}>
                              <Badge value={label === 'unavailable' ? 'Not available yet' : label} />
                              <span>
                                <strong>{t.title}</strong>
                                {t.detail ? <span className="muted"> — {readableText(t.detail, { userId: me.userId })}</span> : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    <details className="small muted">
                      <summary>Technical details</summary>
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
                        <li>
                          Trigger: {c.trigger} · cycle id <code>{c.id}</code>
                        </li>
                      </ul>
                    </details>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <div className="grid-2">
        <section className="card">
          <header className="card-head">
            <h2 className="card-title">Actions and verified results</h2>
            <span className="small muted">{verified} verified</span>
          </header>
          {actions.length ? (
            <ul className="row-list">
              {actions.map((a) => (
                <li key={a.id}>
                  <a href={`/app/approvals?id=${a.id}`}>{actionName(a.actionType)}</a>
                  <span className={`status-pill ${a.status === 'VERIFIED' ? 'ok' : a.status === 'APPROVAL_REQUIRED' ? 'warn' : ['FAILED', 'DENIED', 'REJECTED', 'ESCALATED', 'ROLLBACK_REQUIRED'].includes(a.status) ? 'danger' : 'info'}`}>{actionStateLabel(a.status)}</span>
                  <span className="small muted">{relativeTime(a.updatedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No actions yet. Only independently verified actions count as done.</p>
          )}
        </section>
        <section className="card">
          <header className="card-head">
            <h2 className="card-title">Recent decisions</h2>
            <a className="link-btn" href="/app/brain">
              Growth Brain <Ico name="arrow-right" size={15} />
            </a>
          </header>
          {decisions.error ? <ErrorNotice error={decisions.error} /> : null}
          {!decisions.data && !decisions.error ? (
            <LoadingRows />
          ) : myDecisions.length ? (
            <ul className="row-list">
              {myDecisions.map((d) => (
                <li key={d.id}>
                  <span>
                    <strong>{readableText(d.objective)}</strong>
                    {d.narrative ? <span className="small muted"> — {readableText(d.narrative).slice(0, 180)}</span> : null}
                  </span>
                  <Badge value={d.status} />
                  <span className="small muted">{relativeTime(d.decidedAt ?? d.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No decisions for this goal yet.</p>
          )}
        </section>
      </div>

      {g.memory.lessons?.length ? (
        <section className="card">
          <header className="card-head">
            <h2 className="card-title">What the Autopilot learned</h2>
          </header>
          <ul className="tight small">
            {g.memory.lessons.slice(0, 12).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6. Growth engine control center                                     */
/* ------------------------------------------------------------------ */

export function AutopilotCenter({ me, status, onStatus }: { me: Me; status: AutopilotStatus | null; onStatus: () => void }) {
  const goals = useApi<Goal[]>('/v1/autopilot/goals');
  const inbox = useApi<Inbox>('/v1/autopilot/inbox');
  usePoll(goals.reload, 30_000);
  const [error, setError] = useState<unknown>(null);
  const toggle = async () => {
    if (!status) return;
    setError(null);
    try {
      await api('PUT', '/v1/autopilot/settings', { enabled: !status.enabled });
      onStatus();
    } catch (err) {
      setError(err);
    }
  };
  if (!status?.available) return <EmptyState title="The Autopilot is not available on this server">The rest of FUTUREGROW keeps working; every module stays reachable from the navigation.</EmptyState>;
  const running = (goals.data ?? []).filter((g) => g.status === 'active' || g.status === 'paused');
  const waiting = inbox.data ? inbox.data.approvals.length + inbox.data.decisions.length + inbox.data.drafts.length + (inbox.data.postDrafts?.length ?? 0) : null;
  const engine = status.stopped
    ? { word: 'Stopped', tone: 'danger', text: `${status.stopped}. Release the emergency stop in Governance & Security to continue.` }
    : status.enabled
      ? { word: 'Running', tone: 'ok', text: 'The worker pursues your active goals on their schedule, even when nobody is signed in. Consequential actions still pass your rules, approvals, spending limits and emergency stops.' }
      : { word: 'Off', tone: 'muted', text: 'Nothing runs on its own. Goals and their history stay as they are.' };
  return (
    <div className="stack">
      <div className="grid-3">
        <section className="card engine">
          <div className="eyebrow">Engine</div>
          <div className="engine-state">
            <span className={`status-pill ${engine.tone}`}>{engine.word}</span>
            {status.enabled && !status.modelAvailable ? <span className="status-pill warn">No approved AI model</span> : null}
          </div>
          <p className="small">{engine.text}</p>
          <ErrorNotice error={error} />
          {isAdmin(me) ? (
            <button type="button" className={status.enabled ? '' : 'primary'} onClick={() => void toggle()}>
              {status.enabled ? 'Turn the Autopilot off' : 'Turn the Autopilot on'}
            </button>
          ) : (
            <p className="small muted">Only an owner or admin can switch the Autopilot on or off.</p>
          )}
        </section>
        <section className="card engine">
          <div className="eyebrow">Goals</div>
          <div className="engine-figure">{goals.data ? running.filter((g) => g.status === 'active').length : '…'}</div>
          <p className="small muted">{goals.data ? `running · ${running.filter((g) => g.status === 'paused').length} paused` : 'Loading goals…'}</p>
          <a className="btn" href="/app/goals">
            Open Goals &amp; OKRs
          </a>
        </section>
        <section className="card engine">
          <div className="eyebrow">Waiting for you</div>
          <div className="engine-figure">{waiting ?? '…'}</div>
          <p className="small muted">{waiting === null ? 'Checking the inbox…' : waiting ? 'approvals, decisions or drafts' : 'Nothing waits for a person'}</p>
          <a className={`btn${waiting ? ' primary' : ''}`} href="/app/approvals">
            Open Approvals
          </a>
        </section>
      </div>
      {running.length ? (
        <section className="card">
          <header className="card-head">
            <h2 className="card-title">Goals the engine works on</h2>
          </header>
          <ul className="row-list">
            {running.map((g) => (
              <li key={g.id} className="engine-goal">
                <span>
                  <a href={`/app/goals?id=${g.id}`}>
                    <strong>{g.title}</strong>
                  </a>
                  <span className="small muted"> · {g.status === 'paused' ? 'paused' : g.latestCycle?.status === 'running' ? 'cycle in progress' : g.nextRunAt ? `next cycle ${relativeTime(g.nextRunAt)}` : 'not scheduled'}</span>
                </span>
                <GoalCommands goal={g} me={me} onChange={() => void goals.reload()} compact />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ActivityView />
    </div>
  );
}

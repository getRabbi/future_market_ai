import { TASK_KINDS, type TaskKind, TERMINAL_TASK_STATUSES } from '@futuregrow/contracts';
import { goalCycles, goalTasks, growthDecisions, growthGoals, killSwitches, type Tx, tenantSettings, withSystem, withTenant } from '@futuregrow/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { CoreDeps } from '../../deps.js';
import { registerEventHandlers } from '../../event-handlers.js';
import { record } from '../../util.js';
import { isSystemHalted } from '../m24-governance/index.js';
import { autopilotAvailable, type GoalRow, goalKpi } from './goals.js';
import { AI_CALLS, AUTOPILOT, type CycleRow, EXECUTORS, measureGoal, type StepContext, type StepResult, type TaskRow } from './steps.js';

const ACTOR_REF = 'system:autopilot';
const MINUTE = 60_000;
const HOUR = 3_600_000;
/** A step that has not reported back within this time is treated as interrupted. */
export const LEASE_MS = 10 * MINUTE;
/** Event-triggered replans never start a cycle sooner than this after the previous one. */
export const MIN_CYCLE_GAP_MS = HOUR;
/** Model calls are spaced so a cycle stays inside free-tier provider rate limits. */
export const AI_STEP_GAP_MS = 90_000;
/** Steps one advance job may run before yielding (the next job continues). */
const STEPS_PER_ADVANCE = 4;

const tctx = (tenantId: string) => ({ tenantId, actor: ACTOR_REF });

type Limits = { cadenceHours: number; maxCyclesPerDay: number; maxAiCallsPerDay: number; maxOpenActions: number };
const limitsOf = (g: GoalRow): Limits => ({ cadenceHours: 24, maxCyclesPerDay: 4, maxAiCallsPerDay: 12, maxOpenActions: 3, ...(g.limits as Partial<Limits>) });

/* ------------------------------------------------------------------ */
/* Planning: which modules this cycle needs, and why                   */
/* ------------------------------------------------------------------ */

export interface PlannedStep {
  kind: TaskKind;
  title: string;
  modules: string[];
  reason: string;
  usesAi: boolean;
}

export interface CyclePlan {
  steps: PlannedStep[];
  /** Modules deliberately left out of this cycle, with the reason. */
  notUsed: { modules: string[]; reason: string }[];
  planner: 'rules';
}

/**
 * Deterministic relevance planning: each step is included only when the goal's channels and
 * settings make it relevant, and the plan records why. AI is used inside the steps (Idea Lab,
 * Growth Brain, creative strategist) to decide what to do; it never adds steps or permissions.
 */
export function planCycle(goal: GoalRow): CyclePlan {
  const kpi = goalKpi(goal);
  const ch = new Set(goal.channels);
  const steps: PlannedStep[] = [
    { kind: 'observe', title: 'Check data, connections and open work', modules: ['M01', 'M08', 'M19', 'M23'], reason: `Read the latest ${kpi.label} values, connections, evidence and this goal's open actions.`, usesAi: false },
    { kind: 'forecast', title: `Forecast ${kpi.label} without action`, modules: ['M08'], reason: 'The Growth Brain compares every proposal with a calibrated no-action forecast.', usesAi: false },
  ];
  if (ch.has('seo') || ch.has('app_store') || ch.has('organic_social')) {
    steps.push({ kind: 'research', title: 'Review market, competitor and search signals', modules: ['M04', 'M05', 'M18'], reason: `Channels ${[...ch].filter((c) => ['seo', 'app_store', 'organic_social'].includes(c)).join(', ')} depend on market and search signals.`, usesAi: false });
  }
  steps.push(
    { kind: 'ideas', title: 'Find evidence-backed ideas', modules: ['M06'], reason: `Testable hypotheses for ${kpi.label}, each citing evidence.`, usesAi: true },
    { kind: 'decide', title: 'Choose the next best action', modules: ['M07', 'M08', 'M10'], reason: 'Strategist and critic pick one action from the authorized channels, scored against the forecast.', usesAi: true },
  );
  if (ch.has('organic_social') || ch.has('email')) {
    steps.push({ kind: 'content', title: 'Draft content for the chosen idea', modules: ['M13', 'M03'], reason: 'Content channels are authorized; drafts may only use approved claims.', usesAi: true });
  }
  steps.push(
    { kind: 'submit', title: goal.autoSubmit ? 'Hand the action to the execution gateway' : 'Prepare the action for your review', modules: ['M23', 'M24'], reason: goal.autoSubmit ? 'Policy decides: pre-authorized actions run; everything else waits for approval.' : 'This goal is set to suggest only.', usesAi: false },
    { kind: 'track', title: 'Follow approval, execution and verification', modules: ['M23', 'M24'], reason: 'An action counts only once it is independently verified.', usesAi: false },
    { kind: 'measure', title: `Measure ${kpi.label}`, modules: ['M08'], reason: 'Compare results with the pre-goal baseline and the no-action forecast.', usesAi: false },
    { kind: 'learn', title: 'Learn and plan the next cycle', modules: ['M06', 'M10'], reason: 'Record what happened, refresh experiment analyses and decide when to replan.', usesAi: false },
  );
  const notUsed: CyclePlan['notUsed'] = [];
  if (!ch.has('paid_ads') || goal.adBudgetMicros === 0) notUsed.push({ modules: ['M09', 'M17'], reason: goal.adBudgetMicros === 0 ? 'The advertising budget is $0, so no paid media.' : 'Paid ads are not an authorized channel.' });
  if (!ch.has('email')) notUsed.push({ modules: ['M20'], reason: 'Email is not an authorized channel.' });
  if (!ch.has('offers')) notUsed.push({ modules: ['M12'], reason: 'Offers and pricing are not authorized.' });
  notUsed.push({ modules: ['M02', 'M11', 'M14', 'M15', 'M21', 'M22'], reason: 'Not needed for this goal: audiences, media rendering, personas, conversations and creators stay manual (Advanced).' });
  return { steps, notUsed, planner: 'rules' };
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/** System halt, a tenant kill switch, or an agent kill switch on the Autopilot stop everything. */
export async function haltReason(tx: Tx): Promise<string | null> {
  if (await isSystemHalted(tx)) return 'the system-wide emergency stop is engaged';
  const engaged = await tx.select().from(killSwitches).where(eq(killSwitches.engaged, true));
  const k = engaged.find((x) => x.scope === 'tenant' || (x.scope === 'agent' && (x.targetRef === null || x.targetRef === 'autopilot')));
  return k ? `an emergency stop (${k.scope}${k.targetRef ? `: ${k.targetRef}` : ''}) is engaged: ${k.reason}` : null;
}

async function aiCallsUsed(tx: Tx, goalId: string, now: Date): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`coalesce(sum(${goalTasks.aiCalls}), 0)::int` })
    .from(goalTasks)
    .where(and(eq(goalTasks.goalId, goalId), gte(goalTasks.startedAt, new Date(now.getTime() - 24 * HOUR))));
  return r?.n ?? 0;
}

/* ------------------------------------------------------------------ */
/* Cycles                                                              */
/* ------------------------------------------------------------------ */

async function startCycle(deps: CoreDeps, tenantId: string, goalId: string, now: Date): Promise<{ started: boolean; reason?: string; nextAt?: Date }> {
  return withTenant(deps.db, tctx(tenantId), async (tx) => {
    const [g] = await tx.select().from(growthGoals).where(eq(growthGoals.id, goalId)).for('update');
    if (!g || g.status !== 'active') return { started: false, reason: 'goal not active' };
    const [open] = await tx
      .select({ id: goalCycles.id })
      .from(goalCycles)
      .where(and(eq(goalCycles.goalId, goalId), eq(goalCycles.status, 'running')));
    if (open) return { started: false, reason: 'a cycle is already running' };
    const lim = limitsOf(g);
    const recent = await tx
      .select({ startedAt: goalCycles.startedAt })
      .from(goalCycles)
      .where(and(eq(goalCycles.goalId, goalId), gte(goalCycles.startedAt, new Date(now.getTime() - 24 * HOUR))))
      .orderBy(asc(goalCycles.startedAt));
    if (recent.length >= lim.maxCyclesPerDay) {
      const nextAt = new Date(recent[0]!.startedAt.getTime() + 24 * HOUR);
      await tx
        .update(growthGoals)
        .set({ nextRunAt: nextAt, statusReason: `daily cycle limit (${lim.maxCyclesPerDay}) reached; next cycle ${nextAt.toISOString()}` })
        .where(eq(growthGoals.id, goalId));
      return { started: false, reason: 'daily cycle limit', nextAt };
    }
    const [last] = await tx.select({ seq: goalCycles.seq }).from(goalCycles).where(eq(goalCycles.goalId, goalId)).orderBy(desc(goalCycles.seq)).limit(1);
    const plan = planCycle(g);
    const trigger = g.pendingTrigger ?? 'schedule';
    const [cycle] = await tx
      .insert(goalCycles)
      .values({ tenantId, goalId, seq: (last?.seq ?? 0) + 1, trigger, plan: plan as unknown as Record<string, unknown>, startedAt: now })
      .returning();
    await tx.insert(goalTasks).values(
      plan.steps.map((s, i) => ({
        tenantId,
        goalId,
        cycleId: cycle!.id,
        seq: i + 1,
        kind: s.kind,
        title: s.title,
        modules: s.modules,
        reason: s.reason,
        usesAi: s.usesAi,
        dedupKey: `${cycle!.id}:${s.kind}`,
      })),
    );
    await tx.update(growthGoals).set({ lastCycleAt: now, nextRunAt: null, pendingTrigger: null, statusReason: null, updatedAt: now }).where(eq(growthGoals.id, goalId));
    await record(tx, tenantId, AUTOPILOT, 'autopilot.cycle.started', { type: 'goal_cycle', id: cycle!.id }, { goalId, seq: cycle!.seq, trigger, steps: plan.steps.map((s) => s.kind) });
    return { started: true };
  });
}

async function finishCycle(tx: Tx, tenantId: string, cycle: CycleRow, goal: GoalRow, tasks: TaskRow[], now: Date) {
  const failed = tasks.filter((t) => t.status === 'failed');
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const status = failed.length ? 'failed' : blocked.length ? 'blocked' : 'completed';
  const learn = tasks.find((t) => t.kind === 'learn');
  const measure = tasks.find((t) => t.kind === 'measure');
  const lim = limitsOf(goal);
  const replanHours = (learn?.output.replanHours as number | null | undefined) ?? null;
  const hours = replanHours ?? lim.cadenceHours;
  const nextRunAt = new Date(now.getTime() + hours * HOUR);
  const summary = blocked.length || failed.length ? `Needs attention: ${[...failed, ...blocked].map((t) => `${t.title} — ${t.detail ?? t.status}`).join(' | ')}`.slice(0, 2000) : (learn?.detail ?? 'Cycle finished.');
  await tx
    .update(goalCycles)
    .set({ status, finishedAt: now, summary, outcome: { measurement: measure?.output ?? null, lessons: learn?.output.lessons ?? [], blocked: blocked.map((t) => ({ kind: t.kind, needs: t.needs, detail: t.detail })) } })
    .where(eq(goalCycles.id, cycle.id));
  const memory = (goal.memory ?? {}) as { triedIdeas?: Record<string, unknown>; lessons?: string[] };
  const decide = tasks.find((t) => t.kind === 'decide');
  const ideaId = decide?.output.ideaId as string | undefined;
  const tried = { ...(memory.triedIdeas ?? {}) };
  if (ideaId) tried[ideaId] = { cycle: cycle.seq, outcome: (learn?.output.actionStatus as string | null) ?? (decide?.output.abstained ? 'abstained' : decide?.output.actionType ? 'proposed' : 'no_action'), at: now.toISOString() };
  const lessons = [...((learn?.output.lessons as string[] | undefined) ?? []), ...(memory.lessons ?? [])].slice(0, 30);
  await tx
    .update(growthGoals)
    .set({
      nextRunAt,
      memory: { ...memory, triedIdeas: tried, lessons, lastMeasurement: measure?.output ?? (memory as { lastMeasurement?: unknown }).lastMeasurement ?? null, blockedOn: blocked.map((t) => t.needs).filter(Boolean) },
      updatedAt: now,
    })
    .where(eq(growthGoals.id, goal.id));
  await record(tx, tenantId, AUTOPILOT, 'autopilot.cycle.finished', { type: 'goal_cycle', id: cycle.id }, { goalId: goal.id, status, nextRunAt: nextRunAt.toISOString(), blocked: blocked.map((t) => t.kind) });
}

/** At the target date: one final measurement, then the goal is completed (no more cycles). */
async function completeGoal(deps: CoreDeps, tenantId: string, goalId: string, now: Date) {
  await withTenant(deps.db, tctx(tenantId), async (tx) => {
    const [g] = await tx.select().from(growthGoals).where(eq(growthGoals.id, goalId)).for('update');
    if (!g || g.status !== 'active') return;
    const m = await measureGoal(tx, g, now);
    await tx
      .update(growthGoals)
      .set({ status: 'completed', statusReason: 'target date reached', nextRunAt: null, memory: { ...(g.memory as Record<string, unknown>), finalMeasurement: m }, updatedAt: now })
      .where(eq(growthGoals.id, goalId));
    await record(tx, tenantId, AUTOPILOT, 'autopilot.goal.status_changed', { type: 'growth_goal', id: goalId }, { from: 'active', to: 'completed', reason: 'target date reached' });
  });
}

/* ------------------------------------------------------------------ */
/* Advancing a goal                                                     */
/* ------------------------------------------------------------------ */

export interface AdvanceResult {
  goalId: string;
  ran: { kind: string; status: string }[];
  idle: string | null;
  /** When there is more to do; the caller schedules the next advance then. */
  nextAt: Date | null;
}

type Claim = { kind: 'run'; task: TaskRow; cycle: CycleRow; goal: GoalRow; prior: TaskRow[] } | { kind: 'finish' } | { kind: 'idle'; reason: string; nextAt: Date | null };

async function claimNext(deps: CoreDeps, tenantId: string, goalId: string, now: Date): Promise<Claim | { kind: 'no_cycle'; goal: GoalRow }> {
  return withTenant(deps.db, tctx(tenantId), async (tx) => {
    const [goal] = await tx.select().from(growthGoals).where(eq(growthGoals.id, goalId));
    if (!goal) return { kind: 'idle', reason: 'goal not found', nextAt: null };
    const [cycle] = await tx
      .select()
      .from(goalCycles)
      .where(and(eq(goalCycles.goalId, goalId), eq(goalCycles.status, 'running')))
      .for('update');
    if (!cycle) return { kind: 'no_cycle', goal };
    const tasks = await tx.select().from(goalTasks).where(eq(goalTasks.cycleId, cycle.id)).orderBy(asc(goalTasks.seq));
    const running = tasks.find((t) => t.status === 'running');
    if (running) {
      if (running.leaseUntil && running.leaseUntil > now) return { kind: 'idle', reason: `step "${running.title}" is in progress`, nextAt: running.leaseUntil };
      // Crash recovery: the worker that held the lease is gone. Retry within the attempt budget.
      if (running.attempts >= running.maxAttempts) {
        await tx.update(goalTasks).set({ status: 'failed', detail: 'Interrupted too many times; giving up for this cycle.', leaseUntil: null, finishedAt: now, updatedAt: now }).where(eq(goalTasks.id, running.id));
        running.status = 'failed';
      } else {
        await tx.update(goalTasks).set({ status: 'pending', detail: 'Interrupted (worker restart); resuming.', leaseUntil: null, updatedAt: now }).where(eq(goalTasks.id, running.id));
        running.status = 'pending';
      }
    }
    const next = tasks.find((t) => !TERMINAL_TASK_STATUSES.includes(t.status as never));
    if (!next) return { kind: 'finish' };
    if (next.notBefore && next.notBefore > now) return { kind: 'idle', reason: next.status === 'waiting' ? `waiting: ${next.detail ?? next.title}` : `step "${next.title}" scheduled`, nextAt: next.notBefore };
    const [claimed] = await tx
      .update(goalTasks)
      .set({ status: 'running', attempts: next.attempts + 1, leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: next.startedAt ?? now, updatedAt: now })
      .where(and(eq(goalTasks.id, next.id), inArray(goalTasks.status, ['pending', 'waiting'])))
      .returning();
    if (!claimed) return { kind: 'idle', reason: 'step claimed elsewhere', nextAt: new Date(now.getTime() + MINUTE) };
    return { kind: 'run', task: claimed, cycle, goal, prior: tasks.filter((t) => t.seq < claimed.seq) };
  });
}

async function applyResult(deps: CoreDeps, tenantId: string, task: TaskRow, r: StepResult, now: Date): Promise<string> {
  return withTenant(deps.db, tctx(tenantId), async (tx) => {
    const refs = Object.fromEntries(Object.entries({ ...task.refs, ...(r.refs ?? {}) }).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const output = { ...task.output, ...(r.output ?? {}) };
    const aiCalls = task.aiCalls + (r.aiCalls ?? 0);
    const base = { refs, output, aiCalls, leaseUntil: null, updatedAt: now, detail: r.detail.slice(0, 4000) };
    let status: string;
    let set: Partial<TaskRow>;
    if (r.kind === 'waiting') {
      status = 'waiting';
      set = { ...base, status, notBefore: r.recheckAt, waitUntil: task.waitUntil ?? new Date(now.getTime() + r.maxWaitHours * HOUR), attempts: Math.max(0, task.attempts - 1) };
    } else if (r.kind === 'retry') {
      status = task.attempts >= task.maxAttempts ? 'failed' : 'pending';
      set = { ...base, status, lastError: r.error.slice(0, 2000), notBefore: new Date(now.getTime() + 2 ** task.attempts * MINUTE), ...(status === 'failed' ? { finishedAt: now, detail: `${r.detail} Gave up after ${task.attempts} attempts: ${r.error}`.slice(0, 4000) } : {}) };
    } else {
      status = r.kind;
      set = { ...base, status, needs: r.kind === 'blocked' ? r.needs : null, finishedAt: now, notBefore: null };
    }
    await tx
      .update(goalTasks)
      .set(set)
      .where(and(eq(goalTasks.id, task.id), eq(goalTasks.status, 'running')));
    // Space model calls: the next AI step of this cycle waits a little after one that called a model.
    if ((r.aiCalls ?? 0) > 0) {
      await tx
        .update(goalTasks)
        .set({ notBefore: new Date(now.getTime() + AI_STEP_GAP_MS) })
        .where(and(eq(goalTasks.cycleId, task.cycleId), eq(goalTasks.usesAi, true), eq(goalTasks.status, 'pending'), sql`${goalTasks.seq} > ${task.seq}`));
    }
    return status;
  });
}

/**
 * Advance one goal: start a cycle when due, then run its steps in order until one waits, the
 * step budget is used, or the cycle ends. Every step is checkpointed in `goal_tasks`, so a crash
 * at any point resumes from the last recorded state.
 */
export async function advanceGoal(deps: CoreDeps, tenantId: string, goalId: string, opts: { maxSteps?: number } = {}): Promise<AdvanceResult> {
  const res: AdvanceResult = { goalId, ran: [], idle: null, nextAt: null };
  if (!autopilotAvailable(deps.config)) return { ...res, idle: 'the Autopilot is switched off for the platform' };
  const gate = await withTenant(deps.db, tctx(tenantId), async (tx) => {
    const [s] = await tx.select({ on: tenantSettings.autopilotEnabled }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
    if (!s?.on) return 'the Autopilot is not enabled for this organization';
    const [g] = await tx.select({ status: growthGoals.status }).from(growthGoals).where(eq(growthGoals.id, goalId));
    if (!g) return 'goal not found';
    // A paused, cancelled or completed goal runs nothing, not even a step of an open cycle.
    if (g.status !== 'active') return `goal is ${g.status}`;
    const halt = await haltReason(tx);
    if (halt) {
      await tx
        .update(growthGoals)
        .set({ statusReason: `Stopped: ${halt}` })
        .where(and(eq(growthGoals.id, goalId), eq(growthGoals.status, 'active')));
      return `stopped: ${halt}`;
    }
    return null;
  });
  if (gate) return { ...res, idle: gate };

  const max = opts.maxSteps ?? STEPS_PER_ADVANCE;
  let steps = 0;
  for (let i = 0; i < max + 3; i++) {
    const now = deps.clock.now();
    // Yield after the step budget; the caller (or the next tick) continues right away.
    if (steps >= max) return { ...res, idle: 'step budget for this run used', nextAt: now };
    const claim = await claimNext(deps, tenantId, goalId, now);
    if (claim.kind === 'idle') return { ...res, idle: claim.reason, nextAt: claim.nextAt };
    if (claim.kind === 'no_cycle') {
      const g = claim.goal;
      if (g.status !== 'active') return { ...res, idle: `goal is ${g.status}` };
      if (now >= g.targetDate) {
        await completeGoal(deps, tenantId, goalId, now);
        return { ...res, idle: 'target date reached; goal completed' };
      }
      if (!g.nextRunAt || g.nextRunAt > now) return { ...res, idle: 'next cycle not due', nextAt: g.nextRunAt };
      const s = await startCycle(deps, tenantId, goalId, now);
      if (!s.started) return { ...res, idle: s.reason ?? 'not started', nextAt: s.nextAt ?? null };
      continue;
    }
    if (claim.kind === 'finish') {
      await withTenant(deps.db, tctx(tenantId), async (tx) => {
        const [cycle] = await tx
          .select()
          .from(goalCycles)
          .where(and(eq(goalCycles.goalId, goalId), eq(goalCycles.status, 'running')))
          .for('update');
        if (!cycle) return;
        const [goal] = await tx.select().from(growthGoals).where(eq(growthGoals.id, goalId));
        const tasks = await tx.select().from(goalTasks).where(eq(goalTasks.cycleId, cycle.id)).orderBy(asc(goalTasks.seq));
        await finishCycle(tx, tenantId, cycle, goal!, tasks, now);
      });
      res.ran.push({ kind: 'cycle', status: 'finished' });
      continue;
    }
    const result = await runStep(deps, tenantId, claim, now);
    const status = await applyResult(deps, tenantId, claim.task, result, deps.clock.now());
    res.ran.push({ kind: claim.task.kind, status });
    steps++;
  }
  return { ...res, nextAt: deps.clock.now() };
}

async function runStep(deps: CoreDeps, tenantId: string, claim: Extract<Claim, { kind: 'run' }>, now: Date): Promise<StepResult> {
  const { task, goal, cycle } = claim;
  const prior: StepContext['prior'] = {};
  for (const p of claim.prior) prior[p.kind as TaskKind] = p;
  const lim = limitsOf(goal);
  const used = await withTenant(deps.db, tctx(tenantId), (tx) => aiCallsUsed(tx, goal.id, now));
  const need = AI_CALLS[task.kind as TaskKind] ?? 0;
  if (need > 0) {
    if (!deps.models) return { kind: 'blocked', needs: 'model', detail: 'No approved AI model is available (an administrator approves models in Governance).' };
    if (used + need > lim.maxAiCallsPerDay) return { kind: 'skipped', detail: `Today's AI allowance for this goal is used (${used} of ${lim.maxAiCallsPerDay} model calls in 24 h); this continues in a later cycle.` };
  }
  const ctx: StepContext = { deps, tenantId, goal, cycle, task, prior, aiCallsLeft: lim.maxAiCallsPerDay - used, now };
  try {
    return await EXECUTORS[task.kind as TaskKind](ctx);
  } catch (err) {
    deps.logger.warn({ err, goalId: goal.id, step: task.kind }, 'autopilot step failed');
    return { kind: 'retry', detail: `${task.title} failed.`, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Scheduling (worker) and event-triggered replanning                   */
/* ------------------------------------------------------------------ */

export type Enqueue = (tenantId: string, goalId: string, runAt?: Date) => Promise<void>;

export function enqueueWith(deps: Pick<CoreDeps, 'jobs'>): Enqueue {
  return (tenantId, goalId, runAt) => deps.jobs.add('autopilot_advance', { tenantId, goalId }, { jobKey: `autopilot:${goalId}`, maxAttempts: 3, ...(runAt ? { runAt } : {}) });
}

/**
 * Minute tick: find goals with due work in tenants that enabled the Autopilot and queue one
 * advance job per goal (job keys de-duplicate). Runs without any browser session.
 */
export async function autopilotTick(deps: CoreDeps, enqueue: Enqueue = enqueueWith(deps)): Promise<{ queued: number }> {
  if (!autopilotAvailable(deps.config)) return { queued: 0 };
  const now = deps.clock.now();
  const tenants = await withSystem(deps.db, 'system:autopilot-scheduler', (tx) => tx.select({ id: tenantSettings.tenantId }).from(tenantSettings).where(eq(tenantSettings.autopilotEnabled, true)));
  let queued = 0;
  for (const t of tenants) {
    try {
      const due = await withTenant(deps.db, tctx(t.id), async (tx) => {
        const goals = await tx
          .select({ id: growthGoals.id })
          .from(growthGoals)
          .where(and(eq(growthGoals.status, 'active'), or(lte(growthGoals.nextRunAt, now), lte(growthGoals.targetDate, now))));
        const stepping = await tx
          .selectDistinct({ id: goalTasks.goalId })
          .from(goalTasks)
          .innerJoin(goalCycles, eq(goalCycles.id, goalTasks.cycleId))
          .innerJoin(growthGoals, eq(growthGoals.id, goalTasks.goalId))
          .where(and(eq(goalCycles.status, 'running'), eq(growthGoals.status, 'active'), or(and(inArray(goalTasks.status, ['pending', 'waiting']), or(sql`${goalTasks.notBefore} is null`, lte(goalTasks.notBefore, now))), and(eq(goalTasks.status, 'running'), lt(goalTasks.leaseUntil, now)))));
        return [...new Set([...goals, ...stepping].map((g) => g.id))];
      });
      for (const id of due) {
        await enqueue(t.id, id);
        queued++;
      }
    } catch (err) {
      deps.logger.error({ err, tenantId: t.id }, 'autopilot tick failed for tenant');
    }
  }
  return { queued };
}

/**
 * Bring a goal's next cycle forward because something meaningful changed (a verified or failed
 * action, new evidence it was blocked on, a market change). Debounced: never sooner than
 * MIN_CYCLE_GAP_MS after the previous cycle, never later than already planned.
 */
export async function nudgeGoal(tx: Tx, goalId: string, reason: string, now: Date): Promise<boolean> {
  const [g] = await tx.select().from(growthGoals).where(eq(growthGoals.id, goalId)).for('update');
  if (!g || g.status !== 'active') return false;
  const earliest = new Date(Math.max(now.getTime(), (g.lastCycleAt?.getTime() ?? 0) + MIN_CYCLE_GAP_MS));
  if (g.nextRunAt && g.nextRunAt <= earliest) return false;
  await tx
    .update(growthGoals)
    .set({ nextRunAt: earliest, pendingTrigger: reason.slice(0, 300) })
    .where(eq(growthGoals.id, goalId));
  return true;
}

registerEventHandlers((bus, deps) => {
  const enqueue = enqueueWith(deps);
  const soon = () => new Date(deps.clock.now().getTime() + 5_000);

  // An action created by a goal changed state: continue the waiting track step right away, and
  // replan sooner once it settles (verified results and failures both feed the next cycle).
  bus.on('action.request.transitioned', 'autopilot-action-follow', async (ev) => {
    const to = ev.payload.to as string;
    const goalIds = await withTenant(deps.db, tctx(ev.tenantId), async (tx) => {
      const rows = await tx
        .select({ goalId: growthDecisions.goalId })
        .from(growthDecisions)
        .where(and(eq(growthDecisions.actionId, ev.aggregateId), isNotNull(growthDecisions.goalId)));
      const ids = rows.map((r) => r.goalId!).filter(Boolean);
      if (['VERIFIED', 'FAILED', 'DENIED', 'REJECTED', 'ROLLED_BACK', 'ESCALATED'].includes(to)) for (const id of ids) await nudgeGoal(tx, id, `action ${to.toLowerCase()}`, deps.clock.now());
      return ids;
    });
    for (const id of goalIds) await enqueue(ev.tenantId, id, soon());
  });

  // Analytics results (forecasts, trends, experiment analyses) unblock waiting steps.
  for (const type of ['analytics.request.completed', 'analytics.request.failed'] as const) {
    bus.on(type, `autopilot-${type}`, async (ev) => {
      const goalIds = await withTenant(deps.db, tctx(ev.tenantId), async (tx) =>
        (
          await tx
            .selectDistinct({ goalId: goalTasks.goalId })
            .from(goalTasks)
            .where(and(eq(goalTasks.status, 'waiting'), sql`${goalTasks.refs}->>'analyticsRequestId' = ${ev.aggregateId}`))
        ).map((r) => r.goalId),
      );
      for (const id of goalIds) await enqueue(ev.tenantId, id, soon());
    });
  }

  // New inputs a blocked goal was waiting for, or a meaningful market change: replan sooner.
  const unblockers: { type: 'evidence.record.admitted' | 'knowledge.claim.approved' | 'connector.health.changed' | 'market.trend.detected' | 'competitor.observation.recorded'; needs: string[] | null }[] = [
    { type: 'evidence.record.admitted', needs: ['evidence', 'data'] },
    { type: 'knowledge.claim.approved', needs: ['claims'] },
    { type: 'connector.health.changed', needs: ['connection'] },
    { type: 'market.trend.detected', needs: null },
    { type: 'competitor.observation.recorded', needs: null },
  ];
  for (const u of unblockers) {
    bus.on(u.type, `autopilot-replan-${u.type}`, async (ev) => {
      if (ev.actor.id === 'autopilot') return; // the Autopilot's own writes never trigger it again
      const enabled = await withTenant(deps.db, tctx(ev.tenantId), async (tx) => {
        const [s] = await tx.select({ on: tenantSettings.autopilotEnabled }).from(tenantSettings).where(eq(tenantSettings.tenantId, ev.tenantId));
        if (!s?.on) return [] as string[];
        const goals = await tx.select().from(growthGoals).where(eq(growthGoals.status, 'active'));
        const out: string[] = [];
        for (const g of goals) {
          const blockedOn = ((g.memory as { blockedOn?: string[] }).blockedOn ?? []) as string[];
          if (u.needs && !u.needs.some((n) => blockedOn.includes(n))) continue;
          if (await nudgeGoal(tx, g.id, u.type.replaceAll('.', ' '), deps.clock.now())) out.push(g.id);
        }
        return out;
      });
      for (const id of enabled) await enqueue(ev.tenantId, id, soon());
    });
  }
});

export { TASK_KINDS };

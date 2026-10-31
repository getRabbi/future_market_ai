import { CHANNEL_CATEGORIES, GOAL_CHANNELS, type GoalChannel, type GoalInput, GoalInputSchema, type GoalKpi, GoalLimitsSchema, type RiskCategory } from '@futuregrow/contracts';
import { actionRequests, creativeBriefs, type DbOrTx, goalCycles, goalTasks, growthDecisions, growthGoals, growthIdeas, metricSeries, type Tx, tenantSettings } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { defaultTenantPolicy } from '@futuregrow/policies';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreConfig, type CoreDeps } from '../../deps.js';
import { audit, record, requireRole } from '../../util.js';
import { DOWNLOADS_SERIES_KEY } from '../m19-app-growth/index.js';

export type GoalRow = typeof growthGoals.$inferSelect;
export const GOAL_EDITORS = ['owner', 'admin', 'growth_operator'] as const;

/* ------------------------------------------------------------------ */
/* Rollout switch                                                      */
/* ------------------------------------------------------------------ */

/** Platform switch (FG_AUTOPILOT=off disables it everywhere); tenants still opt in one by one. */
export function autopilotAvailable(config: Pick<CoreConfig, 'autopilotAvailable'>): boolean {
  return config.autopilotAvailable !== false;
}

export async function autopilotEnabled(tx: DbOrTx, tenantId: string): Promise<boolean> {
  const [row] = await tx.select({ on: tenantSettings.autopilotEnabled }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  return row?.on === true;
}

export async function setAutopilotEnabled(tx: Tx, tenantId: string, actor: Actor, enabled: boolean): Promise<{ enabled: boolean }> {
  requireRole(actor, ['owner', 'admin'], 'turning the Autopilot on or off');
  await tx
    .insert(tenantSettings)
    .values({ tenantId, policy: defaultTenantPolicy() as unknown as Record<string, unknown>, autopilotEnabled: enabled, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { autopilotEnabled: enabled, updatedBy: actorRef(actor), updatedAt: new Date() } });
  await audit(tx, tenantId, actor, 'autopilot.settings.changed', { type: 'tenant', id: tenantId }, { enabled });
  return { enabled };
}

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

export function goalCategories(channels: readonly string[], adBudgetMicros: number): RiskCategory[] {
  const out = new Set<RiskCategory>();
  for (const c of channels) {
    if (c === 'paid_ads' && adBudgetMicros <= 0) continue;
    for (const cat of CHANNEL_CATEGORIES[c as GoalChannel] ?? []) out.add(cat);
  }
  return [...out];
}

export function goalKpi(g: Pick<GoalRow, 'kpi'>): GoalKpi {
  return g.kpi as unknown as GoalKpi;
}

export async function createGoal(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown): Promise<GoalRow> {
  requireRole(actor, GOAL_EDITORS, 'creating Autopilot goals');
  const g = GoalInputSchema.parse(raw);
  const now = deps.clock.now();
  const target = new Date(g.targetDate);
  if (target.getTime() < now.getTime() + 86_400_000) throw invalid('the target date must be at least one day ahead');
  if (target.getTime() > now.getTime() + 366 * 86_400_000) throw invalid('the target date must be within a year');
  if (g.channels.includes('paid_ads') && g.adBudget.amountMicros <= 0) throw invalid('paid ads need an advertising budget above zero; remove the channel for a $0 budget');
  const channels = [...new Set(g.channels)];
  const [row] = await tx
    .insert(growthGoals)
    .values({
      tenantId,
      title: g.title,
      statement: g.statement,
      kpi: g.kpi as unknown as Record<string, unknown>,
      market: g.market.toUpperCase(),
      startsAt: now,
      targetDate: target,
      channels,
      adBudgetMicros: g.adBudget.amountMicros,
      currency: g.adBudget.currency.toUpperCase(),
      autoSubmit: g.autoSubmit,
      limits: g.limits as unknown as Record<string, unknown>,
      siteUrl: g.siteUrl,
      status: 'active',
      nextRunAt: now,
      pendingTrigger: 'goal created',
      createdBy: actorRef(actor),
    })
    .returning();
  await record(tx, tenantId, actor, 'autopilot.goal.created', { type: 'growth_goal', id: row!.id }, { kpi: g.kpi.metricKey, channels, adBudgetMicros: g.adBudget.amountMicros, targetDate: g.targetDate });
  return row!;
}

export type GoalCommand = 'pause' | 'resume' | 'cancel' | 'run_now';

/** Pause, resume, cancel or bring the next cycle forward. Caps still apply to "run now". */
export async function commandGoal(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, goalId: string, command: GoalCommand): Promise<GoalRow> {
  requireRole(actor, GOAL_EDITORS, 'controlling Autopilot goals');
  const [g] = await tx.select().from(growthGoals).where(eq(growthGoals.id, goalId)).for('update');
  if (!g) throw notFound('goal');
  const now = deps.clock.now();
  const set: Partial<GoalRow> = { updatedBy: actorRef(actor), updatedAt: now };
  if (command === 'pause') {
    if (g.status !== 'active') throw conflict(`goal is ${g.status}`);
    Object.assign(set, { status: 'paused', statusReason: `paused by ${actorRef(actor)}` });
  } else if (command === 'resume') {
    if (g.status !== 'paused') throw conflict(`goal is ${g.status}`);
    Object.assign(set, { status: 'active', statusReason: null, nextRunAt: g.nextRunAt && g.nextRunAt > now ? g.nextRunAt : now, pendingTrigger: 'resumed' });
  } else if (command === 'cancel') {
    if (g.status === 'cancelled' || g.status === 'completed') throw conflict(`goal is ${g.status}`);
    Object.assign(set, { status: 'cancelled', statusReason: `cancelled by ${actorRef(actor)}`, nextRunAt: null });
    const open = await tx
      .update(goalCycles)
      .set({ status: 'cancelled', finishedAt: now, summary: 'Cancelled with the goal.' })
      .where(and(eq(goalCycles.goalId, goalId), eq(goalCycles.status, 'running')))
      .returning({ id: goalCycles.id });
    if (open.length) {
      await tx
        .update(goalTasks)
        .set({ status: 'cancelled', detail: 'Cancelled with the goal.', finishedAt: now, leaseUntil: null, updatedAt: now })
        .where(
          and(
            inArray(
              goalTasks.cycleId,
              open.map((c) => c.id),
            ),
            inArray(goalTasks.status, ['pending', 'running', 'waiting']),
          ),
        );
    }
  } else {
    if (g.status !== 'active') throw conflict(`goal is ${g.status}; resume it first`);
    Object.assign(set, { nextRunAt: now, pendingTrigger: `run now requested by ${actorRef(actor)}` });
  }
  const [u] = await tx.update(growthGoals).set(set).where(eq(growthGoals.id, goalId)).returning();
  await record(tx, tenantId, actor, 'autopilot.goal.status_changed', { type: 'growth_goal', id: goalId }, { command, from: g.status, to: u!.status });
  return u!;
}

export async function listGoals(tx: DbOrTx) {
  const goals = await tx.select().from(growthGoals).orderBy(desc(growthGoals.createdAt)).limit(100);
  if (!goals.length) return [];
  const cycles = await tx
    .select()
    .from(goalCycles)
    .where(
      inArray(
        goalCycles.goalId,
        goals.map((g) => g.id),
      ),
    )
    .orderBy(desc(goalCycles.seq))
    .limit(500);
  return goals.map((g) => ({ ...g, latestCycle: cycles.find((c) => c.goalId === g.id) ?? null, cycleCount: cycles.filter((c) => c.goalId === g.id).length }));
}

/** Actions the goal's decisions created, newest first. */
export async function goalActions(tx: DbOrTx, goalId: string) {
  return tx
    .select({
      id: actionRequests.id,
      actionType: actionRequests.actionType,
      status: actionRequests.status,
      statusReason: actionRequests.statusReason,
      actionHash: actionRequests.actionHash,
      risk: actionRequests.risk,
      decisionId: actionRequests.decisionId,
      createdAt: actionRequests.createdAt,
      updatedAt: actionRequests.updatedAt,
    })
    .from(actionRequests)
    .innerJoin(growthDecisions, eq(growthDecisions.id, actionRequests.decisionId))
    .where(eq(growthDecisions.goalId, goalId))
    .orderBy(desc(actionRequests.createdAt))
    .limit(200);
}

export async function goalDetail(tx: DbOrTx, goalId: string) {
  const [goal] = await tx.select().from(growthGoals).where(eq(growthGoals.id, goalId));
  if (!goal) throw notFound('goal');
  const cycles = await tx.select().from(goalCycles).where(eq(goalCycles.goalId, goalId)).orderBy(desc(goalCycles.seq)).limit(10);
  const tasks = cycles.length
    ? await tx
        .select()
        .from(goalTasks)
        .where(
          inArray(
            goalTasks.cycleId,
            cycles.map((c) => c.id),
          ),
        )
        .orderBy(goalTasks.seq)
    : [];
  const decisions = await tx
    .select({
      id: growthDecisions.id,
      status: growthDecisions.status,
      objective: growthDecisions.objective,
      ideaId: growthDecisions.ideaId,
      proposedAction: growthDecisions.proposedAction,
      policyResult: growthDecisions.policyResult,
      approvalRequirement: growthDecisions.approvalRequirement,
      utility: growthDecisions.utility,
      narrative: growthDecisions.narrative,
      actionId: growthDecisions.actionId,
      decidedBy: growthDecisions.decidedBy,
      createdAt: growthDecisions.createdAt,
    })
    .from(growthDecisions)
    .where(eq(growthDecisions.goalId, goalId))
    .orderBy(desc(growthDecisions.createdAt))
    .limit(50);
  const actions = await goalActions(tx, goalId);
  return { goal, cycles: cycles.map((c) => ({ ...c, tasks: tasks.filter((t) => t.cycleId === c.id) })), decisions, actions };
}

/** Recent steps across goals (the activity feed). Only persisted state, never simulated. */
export async function listActivity(tx: DbOrTx, opts: { goalId?: string; limit?: number } = {}) {
  return tx
    .select({ task: goalTasks, goalTitle: growthGoals.title })
    .from(goalTasks)
    .innerJoin(growthGoals, eq(growthGoals.id, goalTasks.goalId))
    .where(opts.goalId ? eq(goalTasks.goalId, opts.goalId) : undefined)
    .orderBy(desc(goalTasks.updatedAt))
    .limit(Math.min(opts.limit ?? 60, 300));
}

/** Everything the Autopilot is waiting on a person for. */
export async function inbox(tx: DbOrTx) {
  const approvals = await tx
    .select({ id: actionRequests.id, actionType: actionRequests.actionType, status: actionRequests.status, statusReason: actionRequests.statusReason, createdAt: actionRequests.createdAt, goalId: growthDecisions.goalId, goalTitle: growthGoals.title, decisionId: growthDecisions.id })
    .from(actionRequests)
    .innerJoin(growthDecisions, eq(growthDecisions.id, actionRequests.decisionId))
    .innerJoin(growthGoals, eq(growthGoals.id, growthDecisions.goalId))
    .where(eq(actionRequests.status, 'APPROVAL_REQUIRED'))
    .orderBy(desc(actionRequests.createdAt))
    .limit(100);
  const otherApprovals = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(actionRequests)
    .where(and(eq(actionRequests.status, 'APPROVAL_REQUIRED'), sql`not exists (select 1 from growth_decisions d where d.id = ${actionRequests.decisionId} and d.goal_id is not null)`));
  const decisions = await tx
    .select({ id: growthDecisions.id, objective: growthDecisions.objective, proposedAction: growthDecisions.proposedAction, narrative: growthDecisions.narrative, policyResult: growthDecisions.policyResult, createdAt: growthDecisions.createdAt, goalId: growthDecisions.goalId, goalTitle: growthGoals.title })
    .from(growthDecisions)
    .innerJoin(growthGoals, eq(growthGoals.id, growthDecisions.goalId))
    .where(and(eq(growthDecisions.status, 'PROPOSED'), isNotNull(growthDecisions.proposedAction)))
    .orderBy(desc(growthDecisions.createdAt))
    .limit(50);
  const drafts = await tx
    .select({ id: creativeBriefs.id, title: creativeBriefs.title, channel: creativeBriefs.channel, status: creativeBriefs.status, createdAt: creativeBriefs.createdAt, ideaId: creativeBriefs.ideaId })
    .from(creativeBriefs)
    .innerJoin(growthIdeas, eq(growthIdeas.id, creativeBriefs.ideaId))
    .where(and(eq(creativeBriefs.status, 'draft'), sql`exists (select 1 from goal_tasks t where t.kind = 'content' and t.refs->>'briefId' = ${creativeBriefs.id}::text)`))
    .orderBy(desc(creativeBriefs.createdAt))
    .limit(50);
  return { approvals, otherApprovals: otherApprovals[0]?.n ?? 0, decisions, drafts };
}

/* ------------------------------------------------------------------ */
/* Natural-language intake (deterministic; the owner reviews the draft) */
/* ------------------------------------------------------------------ */

const KPI_TEMPLATES: { re: RegExp; kpi: Omit<GoalKpi, 'target' | 'targetChangePct' | 'direction'>; channels: GoalChannel[] }[] = [
  { re: /\b(download|install)s?\b/i, kpi: { metricKey: DOWNLOADS_SERIES_KEY, label: 'App Store first-time downloads', unit: 'downloads' }, channels: ['app_store', 'organic_social', 'seo', 'experiments'] },
  { re: /\b(sign[\s-]?ups?|registrations?|trials?)\b/i, kpi: { metricKey: 'kpi.signups', label: 'Sign-ups', unit: 'count' }, channels: ['organic_social', 'seo', 'email', 'experiments'] },
  { re: /\b(revenue|sales|orders|purchases)\b/i, kpi: { metricKey: 'kpi.revenue', label: 'Revenue', unit: 'currency' }, channels: ['organic_social', 'email', 'experiments'] },
  { re: /\b(traffic|visits|visitors|sessions)\b/i, kpi: { metricKey: 'kpi.sessions', label: 'Website sessions', unit: 'sessions' }, channels: ['seo', 'organic_social', 'experiments'] },
];

const CHANNEL_WORDS: [RegExp, GoalChannel][] = [
  [/\b(social|facebook|instagram|tiktok|youtube|posts?)\b/i, 'organic_social'],
  [/\b(app store|aso|store listing|listing)\b/i, 'app_store'],
  [/\b(seo|search|google|organic search)\b/i, 'seo'],
  [/\b(email|newsletter|lifecycle)\b/i, 'email'],
  [/\b(experiments?|a\/b|tests?)\b/i, 'experiments'],
  [/\b(discounts?|offers?|pricing|promo)\b/i, 'offers'],
];

export interface GoalDraft {
  draft: GoalInput;
  understood: string[];
  assumptions: string[];
  /** Fields the owner should check before starting. */
  check: string[];
}

/**
 * Turn the owner's sentence into an editable goal draft. Deterministic on purpose: numbers,
 * dates and budgets are taken literally (a $0 budget never becomes paid ads), unknowns are
 * listed for the owner to confirm, and nothing starts until the owner saves the goal.
 */
export function interpretGoal(text: string, ctx: { now: Date; series: { key: string; name: string; unit: string }[]; market: string | null }): GoalDraft {
  const t = text.trim();
  const understood: string[] = [];
  const assumptions: string[] = [];
  const check: string[] = [];

  let days = 30;
  const dur = t.match(/(\d{1,3})\s*(day|week|month)s?/i);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2]!.toLowerCase();
    days = Math.max(2, Math.min(365, unit === 'day' ? n : unit === 'week' ? n * 7 : n * 30));
    understood.push(`Time frame: ${days} days`);
  } else if (/\bnext month\b/i.test(t)) {
    understood.push('Time frame: 30 days');
  } else {
    assumptions.push('No time frame given; assumed 30 days');
    check.push('targetDate');
  }

  let budgetMicros = 0;
  const zero = /(\$\s*0(?![\d.,])|\b(no|zero|without)\s+(paid\s+)?(ad|ads|advertising)\b|\bno\s+ad(vertising)?\s+budget\b|\borganic(ally)?\b)/i.test(t);
  const money = t.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/i);
  if (zero) understood.push('Advertising budget: $0 (no paid ads)');
  else if (money) {
    budgetMicros = Math.round(Number(money[1]!.replaceAll(',', '')) * (money[2] ? 1000 : 1) * 1_000_000);
    understood.push(`Advertising budget: $${(budgetMicros / 1_000_000).toLocaleString('en-US')}`);
  } else {
    assumptions.push('No budget given; assumed $0 (no paid ads) until you set one');
  }

  const tpl = KPI_TEMPLATES.find((k) => k.re.test(t));
  let kpi: GoalKpi;
  let channels: GoalChannel[];
  if (tpl) {
    const words = tpl.kpi.label.toLowerCase().split(/\s+/);
    const existing = ctx.series.find((s) => s.key === tpl.kpi.metricKey) ?? ctx.series.find((s) => words.some((w) => w.length > 3 && `${s.key} ${s.name}`.toLowerCase().includes(w.replace(/s$/, ''))));
    kpi = { ...tpl.kpi, metricKey: existing?.key ?? tpl.kpi.metricKey, label: existing?.name ?? tpl.kpi.label, unit: existing?.unit ?? tpl.kpi.unit, direction: 'increase', target: null, targetChangePct: null };
    channels = [...tpl.channels];
    understood.push(`Measure: ${kpi.label} (${kpi.metricKey})${existing ? ', using your existing data series' : ''}`);
    if (!existing) check.push('kpi');
  } else {
    const first = ctx.series[0];
    kpi = { metricKey: first?.key ?? 'kpi.signups', label: first?.name ?? 'Sign-ups', unit: first?.unit ?? 'count', direction: 'increase', target: null, targetChangePct: null };
    channels = ['organic_social', 'seo', 'experiments'];
    assumptions.push(`Could not tell which number to grow; picked ${kpi.label}`);
    check.push('kpi');
  }
  if (/\b(reduce|lower|decrease|cut)\b/i.test(t)) kpi.direction = 'decrease';
  const pct = t.match(/(\d{1,4}(?:\.\d+)?)\s*%/);
  if (pct) {
    kpi.targetChangePct = (kpi.direction === 'decrease' ? -1 : 1) * Number(pct[1]);
    understood.push(`Target: ${kpi.targetChangePct > 0 ? '+' : ''}${kpi.targetChangePct}% versus before the goal`);
  } else {
    const abs = t.match(/\b(?:to|reach|hit)\s+(\d[\d,]*)\b/i);
    if (abs) {
      kpi.target = Number(abs[1]!.replaceAll(',', ''));
      understood.push(`Target: ${kpi.target.toLocaleString('en-US')} ${kpi.unit}`);
    } else assumptions.push('No numeric target; progress is shown against the pre-goal baseline');
  }

  const named = CHANNEL_WORDS.filter(([re]) => re.test(t)).map(([, c]) => c);
  if (named.length) {
    channels = [...new Set(named)];
    understood.push(`Channels you named: ${channels.join(', ')}`);
  } else assumptions.push(`Channels chosen for this kind of goal: ${channels.join(', ')}`);
  if (budgetMicros > 0 && /\b(ads?|advertising|paid)\b/i.test(t) && !channels.includes('paid_ads')) channels.push('paid_ads');
  if (budgetMicros === 0) channels = channels.filter((c) => c !== 'paid_ads');
  if (!channels.length) channels = ['experiments'];

  const market = ctx.market ?? 'US';
  if (!ctx.market) {
    assumptions.push('No approved market in your policy; assumed US');
    check.push('market');
  }
  const verb = kpi.direction === 'decrease' ? 'Reduce' : 'Grow';
  const title = `${verb} ${kpi.label.toLowerCase()} in ${days} days`.slice(0, 200);
  const draft = GoalInputSchema.parse({
    title,
    statement: t.slice(0, 2000) || title,
    kpi,
    market,
    targetDate: new Date(ctx.now.getTime() + days * 86_400_000).toISOString(),
    channels: channels.filter((c) => (GOAL_CHANNELS as readonly string[]).includes(c)),
    adBudget: { amountMicros: budgetMicros, currency: 'USD' },
    autoSubmit: true,
    limits: GoalLimitsSchema.parse({}),
    siteUrl: t.match(/https:\/\/[^\s,;)]+/i)?.[0] ?? null,
  });
  return { draft, understood, assumptions, check };
}

export async function interpretForTenant(tx: DbOrTx, deps: CoreDeps, text: string, market: string | null): Promise<GoalDraft> {
  const series = await tx.select({ key: metricSeries.key, name: metricSeries.name, unit: metricSeries.unit }).from(metricSeries).where(eq(metricSeries.kind, 'kpi')).limit(200);
  return interpretGoal(text, { now: deps.clock.now(), series, market });
}

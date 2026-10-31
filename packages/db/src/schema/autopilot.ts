import { CYCLE_STATUSES, GOAL_CHANNELS, GOAL_STATUSES, TASK_KINDS, TASK_STATUSES } from '@futuregrow/contracts';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, json, micros, oneOf, pk, rawCheck, tenantId, textArray, ts, updatedAt } from './_common.js';

/* ------------------------------------------------------------------ */
/* Autopilot (M23 Agentic Orchestrator, D-033)                         */
/* ------------------------------------------------------------------ */

/** A business objective the worker pursues in cycles until its target date. */
export const growthGoals = pgTable(
  'growth_goals',
  {
    id: pk(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    statement: text('statement').notNull(),
    kpi: json<Record<string, unknown>>('kpi').notNull(),
    market: text('market').notNull(),
    startsAt: ts('starts_at').notNull().defaultNow(),
    targetDate: ts('target_date').notNull(),
    channels: textArray('channels').notNull(),
    adBudgetMicros: micros('ad_budget_micros').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    autoSubmit: boolean('auto_submit').notNull().default(true),
    limits: json<Record<string, unknown>>('limits').notNull(),
    siteUrl: text('site_url'),
    status: text('status').notNull().default('active'),
    statusReason: text('status_reason'),
    /** Learnings carried between cycles: tried ideas, latest measurement. */
    memory: json<Record<string, unknown>>('memory').notNull().default({}),
    nextRunAt: ts('next_run_at'),
    /** Why the next cycle was brought forward (event-triggered replanning). */
    pendingTrigger: text('pending_trigger'),
    lastCycleAt: ts('last_cycle_at'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    oneOf('growth_goals_status_chk', t.status, GOAL_STATUSES),
    rawCheck('growth_goals_channels_chk', sql`cardinality(${t.channels}) > 0 and ${t.channels} <@ array[${sql.raw(GOAL_CHANNELS.map((c) => `'${c}'`).join(', '))}]::text[]`),
    rawCheck('growth_goals_budget_chk', sql`${t.adBudgetMicros} >= 0`),
    index('growth_goals_due_idx').on(t.status, t.nextRunAt),
    index('growth_goals_tenant_idx').on(t.tenantId, t.createdAt),
  ],
);

/** One pass through the growth loop for a goal. At most one cycle per goal is running. */
export const goalCycles = pgTable(
  'goal_cycles',
  {
    id: pk(),
    tenantId: tenantId(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => growthGoals.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('running'),
    plan: json<Record<string, unknown>>('plan').notNull(),
    summary: text('summary'),
    outcome: json<Record<string, unknown>>('outcome').notNull().default({}),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [oneOf('goal_cycles_status_chk', t.status, CYCLE_STATUSES), uniqueIndex('goal_cycles_seq_uq').on(t.goalId, t.seq), uniqueIndex('goal_cycles_one_running_uq').on(t.goalId).where(sql`${t.status} = 'running'`), index('goal_cycles_goal_idx').on(t.tenantId, t.goalId, t.startedAt)],
);

/** A durable, checkpointed step of a cycle. The activity feed is read from these rows. */
export const goalTasks = pgTable(
  'goal_tasks',
  {
    id: pk(),
    tenantId: tenantId(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => growthGoals.id, { onDelete: 'cascade' }),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => goalCycles.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** Modules this step delegates to (e.g. ["M06"]). */
    modules: textArray('modules').notNull().default(sql`'{}'::text[]`),
    status: text('status').notNull().default('pending'),
    /** Why the planner included the step. */
    reason: text('reason').notNull(),
    /** Plain-language result, wait reason or blocker. */
    detail: text('detail'),
    needs: text('needs'),
    usesAi: boolean('uses_ai').notNull().default(false),
    aiCalls: integer('ai_calls').notNull().default(0),
    dedupKey: text('dedup_key').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    output: json<Record<string, unknown>>('output').notNull().default({}),
    refs: json<Record<string, string>>('refs').notNull().default({}),
    notBefore: ts('not_before'),
    /** Crash recovery: a running step whose lease expired is retried. */
    leaseUntil: ts('lease_until'),
    waitUntil: ts('wait_until'),
    lastError: text('last_error'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    oneOf('goal_tasks_status_chk', t.status, TASK_STATUSES),
    oneOf('goal_tasks_kind_chk', t.kind, TASK_KINDS),
    uniqueIndex('goal_tasks_dedup_uq').on(t.tenantId, t.dedupKey),
    index('goal_tasks_cycle_idx').on(t.cycleId, t.seq),
    index('goal_tasks_goal_idx').on(t.tenantId, t.goalId, t.updatedAt),
    index('goal_tasks_open_idx').on(t.status, t.notBefore),
  ],
);

import { z } from 'zod';
import type { RiskCategory } from './enums.js';

/**
 * Autopilot (M23 Agentic Orchestrator, D-033): persistent business goals that the worker pursues
 * in cycles of observe → research → ideas → decide → create → submit → track → measure → learn.
 * Every consequential write still goes through the M23 gateway and its policy.
 */
export const GOAL_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const CYCLE_STATUSES = ['running', 'completed', 'blocked', 'failed', 'cancelled'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const TASK_STATUSES = ['pending', 'running', 'waiting', 'completed', 'skipped', 'blocked', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'skipped', 'blocked', 'failed', 'cancelled'];

/** Step kinds, in the order a cycle runs them. Each delegates to existing modules. */
export const TASK_KINDS = ['observe', 'forecast', 'research', 'ideas', 'decide', 'content', 'submit', 'track', 'measure', 'learn'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** What a blocked step needs from a person. */
export const BLOCK_NEEDS = ['data', 'connection', 'evidence', 'claims', 'approval', 'configuration', 'model', 'budget'] as const;
export type BlockNeed = (typeof BLOCK_NEEDS)[number];

/** Channels a goal may use; each maps to the action categories the Autopilot may submit. */
export const GOAL_CHANNELS = ['organic_social', 'app_store', 'seo', 'email', 'experiments', 'paid_ads', 'offers'] as const;
export type GoalChannel = (typeof GOAL_CHANNELS)[number];

export const CHANNEL_CATEGORIES: Record<GoalChannel, readonly RiskCategory[]> = {
  organic_social: ['PUBLIC_PUBLISHING'],
  app_store: ['STORE_METADATA'],
  seo: [],
  email: ['MESSAGING'],
  experiments: ['EXPERIMENT'],
  paid_ads: ['SPEND'],
  offers: ['PRICING'],
};

export const GoalKpiSchema = z.object({
  /** Metric series key (M08), e.g. `app.downloads.first_time`. */
  metricKey: z
    .string()
    .min(2)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/),
  label: z.string().min(2).max(200),
  direction: z.enum(['increase', 'decrease']).default('increase'),
  unit: z.string().min(1).max(50).default('count'),
  /** Absolute target for the goal window, if the owner gave one. */
  target: z.number().finite().nullable().default(null),
  /** Relative target versus the pre-goal baseline, e.g. 20 for +20 %. */
  targetChangePct: z.number().min(-100).max(10_000).nullable().default(null),
});
export type GoalKpi = z.infer<typeof GoalKpiSchema>;

export const GoalLimitsSchema = z.object({
  /** Hours between planned cycles. */
  cadenceHours: z.number().int().min(1).max(168).default(24),
  maxCyclesPerDay: z.number().int().min(1).max(24).default(4),
  /** Model calls (all AI steps of all cycles) per rolling 24 h. */
  maxAiCallsPerDay: z.number().int().min(0).max(50).default(12),
  /** Actions this goal may have open (proposed, awaiting approval or executing) at once. */
  maxOpenActions: z.number().int().min(1).max(10).default(3),
});
export type GoalLimits = z.infer<typeof GoalLimitsSchema>;

export const GoalInputSchema = z.object({
  title: z.string().min(3).max(200),
  /** The owner's own words. */
  statement: z.string().min(3).max(2000),
  kpi: GoalKpiSchema,
  market: z.string().min(2).max(10),
  targetDate: z.string().datetime({ offset: true }),
  channels: z.array(z.enum(GOAL_CHANNELS)).min(1).max(GOAL_CHANNELS.length),
  adBudget: z.object({ amountMicros: z.number().int().nonnegative(), currency: z.string().length(3) }).default({ amountMicros: 0, currency: 'USD' }),
  /** false = "suggest only": decisions wait for a person instead of going to M23 automatically. */
  autoSubmit: z.boolean().default(true),
  limits: GoalLimitsSchema.default(GoalLimitsSchema.parse({})),
  siteUrl: z.string().url().startsWith('https://').nullable().default(null),
});
export type GoalInput = z.infer<typeof GoalInputSchema>;

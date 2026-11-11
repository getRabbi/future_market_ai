import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dbl, json, micros, oneOf, pk, rawCheck, tenantId, textArray, ts, updatedAt, uuidArray } from './_common.js';
import { brands } from './brands.js';

/* ------------------------------------------------------------------ */
/* Durable AI spend reservations (FG-P2-001 hardening, D-054)          */
/* ------------------------------------------------------------------ */

/**
 * One in-flight model attempt's upper-bound cost. The gateway's budget guard reserves under a
 * per-tenant transaction advisory lock, so api, worker and job processes share one view of what
 * is in flight. A row is deleted when the attempt finishes (its real cost is then in the cost
 * ledger); a row left behind by a crashed process stops counting at `expires_at`.
 */
export const aiSpendReservations = pgTable(
  'ai_spend_reservations',
  {
    id: pk(),
    tenantId: tenantId(),
    amountUsd: dbl('amount_usd').notNull(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    purpose: text('purpose').notNull(),
    /** host:pid of the reserving process (diagnostics only). */
    holder: text('holder').notNull(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('ai_spend_reservations_tenant_idx').on(t.tenantId, t.expiresAt), rawCheck('ai_spend_reservations_amount_chk', sql`${t.amountUsd} >= 0`)],
);

/* ------------------------------------------------------------------ */
/* Growth Warfare OS (F1–F6, D-054)                                    */
/* ------------------------------------------------------------------ */

export const GW_FEATURES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] as const;
export const GW_AGGRESSION = ['balanced', 'aggressive', 'maximum_authorized'] as const;
export const GW_SIGNAL_KINDS = ['high_intent_demand', 'unmet_need', 'switching_intent', 'emerging_problem', 'demand_shift', 'competitor_price_change', 'competitor_feature_change', 'competitor_packaging_change', 'competitor_positioning_change', 'competitor_availability_change', 'competitor_policy_change'] as const;
export const GW_SIGNAL_STATUSES = ['active', 'expired', 'rejected', 'dismissed'] as const;
export const GW_OPPORTUNITY_STATUSES = ['new', 'reviewing', 'accepted', 'dismissed', 'expired', 'converted'] as const;
export const GW_CAMPAIGN_KINDS = ['conquest', 'blitz', 'capture', 'rescue', 'referral', 'creator'] as const;
export const GW_CAMPAIGN_STATUSES = ['draft', 'ready_for_review', 'approved', 'in_flight', 'completed', 'cancelled', 'expired', 'blocked'] as const;
export const GW_CHANNELS = ['facebook', 'instagram', 'email', 'paid_ads', 'owned_site', 'referral', 'partner', 'community', 'creator'] as const;
export const GW_TASK_STATUSES = ['planned', 'blocked', 'ready', 'submitted', 'awaiting_approval', 'executed', 'verified', 'done_by_human', 'failed', 'skipped', 'cancelled'] as const;
export const GW_TOOL_TEMPLATES = ['courier_comparison', 'cod_reconciliation', 'seller_cost_calculator', 'vocabulary_assessment', 'practice_quiz', 'readiness_assessment'] as const;
export const GW_EXPERIMENT_AREAS = ['positioning', 'offer', 'landing_page', 'acquisition_tool', 'onboarding', 'referral', 'campaign_variant'] as const;
export const GW_PLAN_STATUSES = ['proposed', 'approved', 'rejected', 'running', 'completed', 'insufficient_data', 'cancelled'] as const;
export const GW_MEMORY_OUTCOMES = ['supported_winner', 'supported_loser', 'inconclusive', 'invalid', 'guardrail_breach', 'observational'] as const;

/** Tenant-wide switches, aggression level and global controls (optimistic concurrency on `version`). */
export const growthWarfareSettings = pgTable(
  'growth_warfare_settings',
  {
    tenantId: text('tenant_id').primaryKey(),
    /** { F1: false, …, F6: false }: every feature starts OFF. */
    features: json<Record<string, boolean>>('features').notNull(),
    aggression: text('aggression').notNull().default('balanced'),
    controls: json<Record<string, unknown>>('controls').notNull(),
    emergencyStop: boolean('emergency_stop').notNull().default(false),
    emergencyReason: text('emergency_reason'),
    lastScanAt: ts('last_scan_at'),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [oneOf('growth_warfare_settings_aggression_chk', t.aggression, GW_AGGRESSION)],
);

/** Per-brand growth profile: keywords, competitors, funnel, channels, budgets, feature overrides. */
export const growthBrandConfigs = pgTable(
  'growth_brand_configs',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    config: json<Record<string, unknown>>('config').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('growth_brand_configs_brand_uq').on(t.tenantId, t.brandId)],
);

/** A deduplicated, provenance-backed market signal for one brand (F1). */
export const growthSignals = pgTable(
  'growth_signals',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    dedupKey: text('dedup_key').notNull(),
    subject: text('subject').notNull(),
    /** Where it was read: table + row reference (provenance). */
    sourceTable: text('source_table').notNull(),
    sourceRef: text('source_ref').notNull(),
    evidenceIds: uuidArray('evidence_ids').notNull(),
    /** Source numbers exactly as stored (never estimated). */
    metrics: json<Record<string, unknown>>('metrics').notNull().default({}),
    confidence: dbl('confidence').notNull(),
    observedAt: ts('observed_at').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    status: text('status').notNull().default('active'),
    history: json<unknown[]>('history').notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('growth_signals_dedup_uq').on(t.tenantId, t.brandId, t.dedupKey),
    index('growth_signals_brand_idx').on(t.tenantId, t.brandId, t.status, t.lastSeenAt),
    oneOf('growth_signals_kind_chk', t.kind, GW_SIGNAL_KINDS),
    oneOf('growth_signals_status_chk', t.status, GW_SIGNAL_STATUSES),
    rawCheck('growth_signals_evidence_chk', sql`cardinality(${t.evidenceIds}) > 0`),
    rawCheck('growth_signals_confidence_chk', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

/** A scored, reviewable opportunity derived from exactly one signal (F1 review queue). */
export const growthOpportunities = pgTable(
  'growth_opportunities',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => growthSignals.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    nextAction: json<Record<string, unknown>>('next_action').notNull(),
    score: dbl('score').notNull(),
    scoreBreakdown: json<Record<string, unknown>>('score_breakdown').notNull(),
    urgency: text('urgency').notNull(),
    status: text('status').notNull().default('new'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    reviewNote: text('review_note'),
    campaignId: uuid('campaign_id'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('growth_opportunities_signal_uq').on(t.tenantId, t.signalId),
    index('growth_opportunities_queue_idx').on(t.tenantId, t.brandId, t.status, t.score),
    oneOf('growth_opportunities_status_chk', t.status, GW_OPPORTUNITY_STATUSES),
    oneOf('growth_opportunities_urgency_chk', t.urgency, ['low', 'medium', 'high']),
  ],
);

/** A prepared campaign package (F2 conquest, F3 blitz, F4 capture, F5 rescue/referral, creators). */
export const growthCampaigns = pgTable(
  'growth_campaigns',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => growthOpportunities.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    package: json<Record<string, unknown>>('package').notNull(),
    evidenceIds: uuidArray('evidence_ids').notNull().default(sql`'{}'::uuid[]`),
    claimIds: uuidArray('claim_ids').notNull().default(sql`'{}'::uuid[]`),
    approval: json<Record<string, unknown>>('approval').notNull(),
    goals: json<unknown[]>('goals').notNull().default([]),
    budgetMicros: micros('budget_micros').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    expiresAt: ts('expires_at'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One campaign of a kind per opportunity: re-running preparation never duplicates it.
    uniqueIndex('growth_campaigns_opportunity_uq').on(t.tenantId, t.opportunityId, t.kind).where(sql`${t.opportunityId} is not null`),
    index('growth_campaigns_brand_idx').on(t.tenantId, t.brandId, t.status, t.createdAt),
    oneOf('growth_campaigns_kind_chk', t.kind, GW_CAMPAIGN_KINDS),
    oneOf('growth_campaigns_status_chk', t.status, GW_CAMPAIGN_STATUSES),
    rawCheck('growth_campaigns_budget_chk', sql`${t.budgetMicros} >= 0`),
  ],
);

/** One channel's piece of a campaign (F3 distribution mesh); deduplicated by content per channel. */
export const growthChannelTasks = pgTable(
  'growth_channel_tasks',
  {
    id: pk(),
    tenantId: tenantId(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => growthCampaigns.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id').notNull(),
    channel: text('channel').notNull(),
    connectionId: uuid('connection_id'),
    status: text('status').notNull().default('planned'),
    content: json<Record<string, unknown>>('content').notNull(),
    contentHash: text('content_hash').notNull(),
    dedupKey: text('dedup_key').notNull(),
    rules: json<Record<string, unknown>>('rules').notNull().default({}),
    refs: json<Record<string, unknown>>('refs').notNull().default({}),
    outcome: json<Record<string, unknown>>('outcome').notNull().default({}),
    statusReason: text('status_reason'),
    submittedBy: text('submitted_by'),
    submittedAt: ts('submitted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('growth_channel_tasks_dedup_uq').on(t.tenantId, t.dedupKey),
    index('growth_channel_tasks_campaign_idx').on(t.tenantId, t.campaignId),
    index('growth_channel_tasks_channel_idx').on(t.tenantId, t.channel, t.submittedAt),
    oneOf('growth_channel_tasks_channel_chk', t.channel, GW_CHANNELS),
    oneOf('growth_channel_tasks_status_chk', t.status, GW_TASK_STATUSES),
  ],
);

/** A value-first acquisition utility (F4); public by `public_id` only after a person publishes it. */
export const acquisitionTools = pgTable(
  'acquisition_tools',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    template: text('template').notNull(),
    publicId: text('public_id').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    config: json<Record<string, unknown>>('config').notNull(),
    methodology: text('methodology').notNull(),
    cta: json<Record<string, unknown>>('cta').notNull(),
    consent: json<Record<string, unknown>>('consent').notNull(),
    experimentId: uuid('experiment_id'),
    dataUpdatedAt: ts('data_updated_at'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    publishedBy: text('published_by'),
    publishedAt: ts('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('acquisition_tools_public_uq').on(t.publicId),
    index('acquisition_tools_brand_idx').on(t.tenantId, t.brandId, t.status),
    oneOf('acquisition_tools_template_chk', t.template, GW_TOOL_TEMPLATES),
    oneOf('acquisition_tools_status_chk', t.status, ['draft', 'published', 'retired']),
    rawCheck('acquisition_tools_public_chk', sql`${t.publicId} ~ '^[a-z0-9]{12,40}$'`),
  ],
);

/** One audited observation of an AI/search answer for a tracked question (F4 visibility). */
export const searchVisibilityObservations = pgTable(
  'search_visibility_observations',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    engine: text('engine').notNull(),
    query: text('query').notNull(),
    observedAt: ts('observed_at').notNull(),
    brandMentioned: boolean('brand_mentioned').notNull(),
    brandCited: boolean('brand_cited').notNull().default(false),
    competitorsMentioned: textArray('competitors_mentioned').notNull().default(sql`'{}'::text[]`),
    citedSources: textArray('cited_sources').notNull().default(sql`'{}'::text[]`),
    recommendedProducts: textArray('recommended_products').notNull().default(sql`'{}'::text[]`),
    method: text('method').notNull(),
    provider: text('provider'),
    evidenceId: uuid('evidence_id').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('search_visibility_obs_uq').on(t.tenantId, t.brandId, t.engine, t.query, t.observedAt), index('search_visibility_brand_idx').on(t.tenantId, t.brandId, t.observedAt), oneOf('search_visibility_method_chk', t.method, ['manual_import', 'provider_api'])],
);

/** A Darwin experiment proposal (F6); becomes an M10 experiment only after approval. */
export const growthExperimentPlans = pgTable(
  'growth_experiment_plans',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => growthCampaigns.id, { onDelete: 'set null' }),
    feature: text('feature').notNull(),
    area: text('area').notNull(),
    dedupKey: text('dedup_key').notNull(),
    hypothesis: text('hypothesis').notNull(),
    control: json<Record<string, unknown>>('control').notNull(),
    variant: json<Record<string, unknown>>('variant').notNull(),
    primaryKpi: json<Record<string, unknown>>('primary_kpi').notNull(),
    guardrails: json<unknown[]>('guardrails').notNull(),
    eligibility: json<Record<string, unknown>>('eligibility').notNull(),
    assignment: json<Record<string, unknown>>('assignment').notNull(),
    sufficiency: json<Record<string, unknown>>('sufficiency').notNull(),
    stopConditions: json<unknown[]>('stop_conditions').notNull(),
    measurementPlan: json<Record<string, unknown>>('measurement_plan').notNull(),
    status: text('status').notNull().default('proposed'),
    experimentId: uuid('experiment_id'),
    priorMemoryIds: uuidArray('prior_memory_ids').notNull().default(sql`'{}'::uuid[]`),
    approvedBy: text('approved_by'),
    approvedAt: ts('approved_at'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('growth_experiment_plans_dedup_uq').on(t.tenantId, t.dedupKey),
    uniqueIndex('growth_experiment_plans_experiment_uq').on(t.tenantId, t.experimentId).where(sql`${t.experimentId} is not null`),
    index('growth_experiment_plans_brand_idx').on(t.tenantId, t.brandId, t.status),
    oneOf('growth_experiment_plans_feature_chk', t.feature, GW_FEATURES),
    oneOf('growth_experiment_plans_area_chk', t.area, GW_EXPERIMENT_AREAS),
    oneOf('growth_experiment_plans_status_chk', t.status, GW_PLAN_STATUSES),
  ],
);

/** Validated (or explicitly unvalidated) learning the Growth Brain may read back (F6 memory). */
export const growthStrategyMemory = pgTable(
  'growth_strategy_memory',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id'),
    experimentId: uuid('experiment_id'),
    /** experiment_results row the finding was read from (evidence version). */
    resultId: uuid('result_id'),
    tactic: text('tactic').notNull(),
    area: text('area').notNull(),
    channel: text('channel'),
    hypothesis: text('hypothesis').notNull(),
    outcome: text('outcome').notNull(),
    inferenceKind: text('inference_kind').notNull(),
    effect: json<Record<string, unknown>>('effect').notNull(),
    confidence: dbl('confidence'),
    confounders: textArray('confounders').notNull().default(sql`'{}'::text[]`),
    context: json<Record<string, unknown>>('context').notNull().default({}),
    evidenceIds: uuidArray('evidence_ids').notNull().default(sql`'{}'::uuid[]`),
    summary: text('summary').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('growth_strategy_memory_result_uq').on(t.tenantId, t.resultId).where(sql`${t.resultId} is not null`),
    index('growth_strategy_memory_brand_idx').on(t.tenantId, t.brandId, t.createdAt),
    oneOf('growth_strategy_memory_outcome_chk', t.outcome, GW_MEMORY_OUTCOMES),
    oneOf('growth_strategy_memory_inference_chk', t.inferenceKind, ['randomized_test', 'observational']),
    // AC: attribution is never recorded as a randomized (causal) win or loss.
    rawCheck('growth_strategy_memory_causal_chk', sql`${t.inferenceKind} = 'randomized_test' or ${t.outcome} in ('observational', 'inconclusive', 'invalid')`),
  ],
);

/** Durable state of scheduled/background growth operations: leases, idempotency, retries. */
export const growthOperations = pgTable(
  'growth_operations',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id'),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('running'),
    leaseUntil: ts('lease_until'),
    attempts: integer('attempts').notNull().default(1),
    input: json<Record<string, unknown>>('input').notNull().default({}),
    result: json<Record<string, unknown>>('result').notNull().default({}),
    error: text('error'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('growth_operations_idem_uq').on(t.tenantId, t.idempotencyKey), index('growth_operations_kind_idx').on(t.tenantId, t.kind, t.startedAt), oneOf('growth_operations_status_chk', t.status, ['running', 'completed', 'failed', 'skipped'])],
);

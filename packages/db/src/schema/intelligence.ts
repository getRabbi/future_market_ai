import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ANALYTICS_KINDS } from '@futuregrow/contracts';
import { createdAt, dbl, json, oneOf, pk, rawCheck, tenantId, textArray, ts, updatedAt, uuidArray } from './_common.js';

/* ------------------------------------------------------------------ */
/* Time series shared by M04/M08/M09                                  */
/* ------------------------------------------------------------------ */

export const metricSeries = pgTable('metric_series', {
  id: pk(),
  tenantId: tenantId(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
  granularity: text('granularity').notNull(),
  kind: text('kind').notNull(),
  channel: text('channel'),
  geography: text('geography'),
  sourceEvidenceId: uuid('source_evidence_id').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('metric_series_key_uq').on(t.tenantId, t.key),
  oneOf('metric_series_granularity_chk', t.granularity, ['hour', 'day', 'week', 'month']),
  oneOf('metric_series_kind_chk', t.kind, ['kpi', 'spend', 'exposure', 'signal', 'control']),
]);

export const metricPoints = pgTable('metric_points', {
  tenantId: tenantId(),
  seriesId: uuid('series_id').notNull().references(() => metricSeries.id, { onDelete: 'cascade' }),
  ts: ts('ts').notNull(),
  value: dbl('value').notNull(),
  evidenceId: uuid('evidence_id'),
  ingestedAt: ts('ingested_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.seriesId, t.ts] })]);

/* ------------------------------------------------------------------ */
/* Analytics job queue (D-016)                                        */
/* ------------------------------------------------------------------ */

export const analyticsRequests = pgTable('analytics_requests', {
  id: pk(),
  tenantId: tenantId(),
  kind: text('kind').notNull(),
  params: json<Record<string, unknown>>('params').notNull(),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').notNull().default(100),
  requestedBy: text('requested_by').notNull(),
  requestedAt: ts('requested_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  attempts: integer('attempts').notNull().default(0),
  lockedBy: text('locked_by'),
  error: text('error'),
  resultRef: uuid('result_ref'),
  resultSummary: json<Record<string, unknown> | null>('result_summary'),
}, (t) => [
  index('analytics_requests_queue_idx').on(t.status, t.priority, t.requestedAt),
  oneOf('analytics_requests_kind_chk', t.kind, ANALYTICS_KINDS),
  oneOf('analytics_requests_status_chk', t.status, ['queued', 'running', 'completed', 'failed']),
]);

/* ------------------------------------------------------------------ */
/* M04 Market & Trend Intelligence                                    */
/* ------------------------------------------------------------------ */

export const trends = pgTable('trends', {
  id: pk(),
  tenantId: tenantId(),
  requestId: uuid('request_id'),
  seriesId: uuid('series_id').references(() => metricSeries.id),
  topic: text('topic').notNull(),
  geography: text('geography'),
  windowStart: ts('window_start').notNull(),
  windowEnd: ts('window_end').notNull(),
  baseline: json<Record<string, unknown>>('baseline').notNull(),
  direction: text('direction').notNull(),
  senSlope: dbl('sen_slope'),
  mannKendallZ: dbl('mann_kendall_z'),
  mannKendallP: dbl('mann_kendall_p'),
  velocity: dbl('velocity'),
  changePoints: json<unknown[]>('change_points').notNull(),
  confidence: dbl('confidence').notNull(),
  freshnessStatus: text('freshness_status').notNull(),
  evidenceIds: uuidArray('evidence_ids').notNull(),
  inferenceKind: text('inference_kind').notNull().default('correlation'),
  createdAt: createdAt(),
}, (t) => [
  index('trends_tenant_idx').on(t.tenantId, t.createdAt),
  oneOf('trends_direction_chk', t.direction, ['rising', 'falling', 'flat', 'shift_up', 'shift_down']),
  // AC: a trend never equals predicted business impact
  oneOf('trends_inference_chk', t.inferenceKind, ['correlation']),
]);

export const topicClusters = pgTable('topic_clusters', {
  id: pk(),
  tenantId: tenantId(),
  requestId: uuid('request_id'),
  label: text('label').notNull(),
  terms: textArray('terms').notNull(),
  size: integer('size').notNull(),
  sampleRefs: json<unknown[]>('sample_refs').notNull(),
  corpus: text('corpus').notNull(),
  windowStart: ts('window_start'),
  windowEnd: ts('window_end'),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ */
/* M05 Competitor War Room                                            */
/* ------------------------------------------------------------------ */

export const competitors = pgTable('competitors', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  domains: textArray('domains').notNull(),
  notes: text('notes'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('competitors_name_uq').on(t.tenantId, t.name)]);

/** Lawful-source allowlist. Only `approved` sources may be fetched (D-019). */
export const competitorSources = pgTable('competitor_sources', {
  id: pk(),
  tenantId: tenantId(),
  competitorId: uuid('competitor_id').notNull().references(() => competitors.id),
  url: text('url').notNull(),
  kind: text('kind').notNull(),
  lawfulBasisNote: text('lawful_basis_note').notNull(),
  status: text('status').notNull().default('pending'),
  approvedBy: text('approved_by'),
  approvedAt: ts('approved_at'),
  crawlIntervalHours: integer('crawl_interval_hours').notNull().default(24),
  lastFetchedAt: ts('last_fetched_at'),
  lastRobotsAllowed: boolean('last_robots_allowed'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('competitor_sources_url_uq').on(t.tenantId, t.url),
  oneOf('competitor_sources_kind_chk', t.kind, ['pricing', 'features', 'changelog', 'docs', 'app_listing', 'ad_library', 'press', 'other']),
  oneOf('competitor_sources_status_chk', t.status, ['pending', 'approved', 'revoked']),
  rawCheck('competitor_sources_approval_chk', sql`${t.status} <> 'approved' or ${t.approvedBy} is not null`),
]);

export const competitorSnapshots = pgTable('competitor_snapshots', {
  id: pk(),
  tenantId: tenantId(),
  sourceId: uuid('source_id').notNull().references(() => competitorSources.id),
  fetchedAt: ts('fetched_at').notNull(),
  httpStatus: integer('http_status').notNull(),
  contentSha256: text('content_sha256').notNull(),
  objectKey: text('object_key').notNull(),
  textExcerpt: text('text_excerpt').notNull(),
  extracted: json<Record<string, unknown>>('extracted').notNull().default({}),
  evidenceId: uuid('evidence_id').notNull(),
  diffFromPrevious: json<Record<string, unknown> | null>('diff_from_previous'),
  createdAt: createdAt(),
}, (t) => [index('competitor_snapshots_source_idx').on(t.sourceId, t.fetchedAt)]);

export const competitorObservations = pgTable('competitor_observations', {
  id: pk(),
  tenantId: tenantId(),
  competitorId: uuid('competitor_id').notNull().references(() => competitors.id),
  kind: text('kind').notNull(),
  summary: text('summary').notNull(),
  details: json<Record<string, unknown>>('details').notNull().default({}),
  /** 'P' = observed directly in a primary snapshot; 'I' = inference, never a measured fact. */
  evidenceFlag: text('evidence_flag').notNull(),
  evidenceIds: uuidArray('evidence_ids').notNull(),
  confidence: dbl('confidence').notNull(),
  observedAt: ts('observed_at').notNull(),
  createdAt: createdAt(),
}, (t) => [
  oneOf('competitor_observations_kind_chk', t.kind, ['price_change', 'feature_added', 'feature_removed', 'positioning', 'release', 'creative', 'content_change', 'gap']),
  oneOf('competitor_observations_flag_chk', t.evidenceFlag, ['P', 'I']),
  rawCheck('competitor_observations_evidence_chk', sql`cardinality(${t.evidenceIds}) > 0`),
]);

/** REA jobs require an authorization record; execution blocked until a sandbox exists (B-012). */
export const reaJobs = pgTable('rea_jobs', {
  id: pk(),
  tenantId: tenantId(),
  targetDescription: text('target_description').notNull(),
  artifactRef: text('artifact_ref').notNull(),
  authorization: json<Record<string, unknown>>('authorization').notNull(),
  legalApproved: boolean('legal_approved').notNull(),
  status: text('status').notNull(),
  statusReason: text('status_reason'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  oneOf('rea_jobs_status_chk', t.status, ['registered', 'blocked_no_sandbox', 'rejected']),
  rawCheck('rea_jobs_legal_chk', sql`${t.legalApproved} = true`),
]);

/* ------------------------------------------------------------------ */
/* M06 Idea Lab                                                       */
/* ------------------------------------------------------------------ */

export const growthIdeas = pgTable('growth_ideas', {
  id: pk(),
  tenantId: tenantId(),
  title: text('title').notNull(),
  hypothesis: text('hypothesis').notNull(),
  mechanism: text('mechanism').notNull(),
  audience: text('audience').notNull(),
  targetMetric: text('target_metric').notNull(),
  evidenceIds: uuidArray('evidence_ids').notNull(),
  impactModel: json<Record<string, unknown>>('impact_model').notNull(),
  costModel: json<Record<string, unknown>>('cost_model').notNull(),
  riskModel: json<Record<string, unknown>>('risk_model').notNull(),
  successPrior: json<Record<string, unknown>>('success_prior').notNull(),
  valueSummary: json<Record<string, unknown>>('value_summary').notNull(),
  evidenceStrength: dbl('evidence_strength').notNull(),
  testDesign: json<Record<string, unknown>>('test_design').notNull(),
  killCriteria: json<unknown[]>('kill_criteria').notNull(),
  noveltyScore: dbl('novelty_score').notNull(),
  duplicateOfId: uuid('duplicate_of_id'),
  screening: json<Record<string, unknown>>('screening').notNull(),
  route: text('route').notNull(),
  status: text('status').notNull().default('candidate'),
  source: text('source').notNull(),
  agentRunId: uuid('agent_run_id'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('growth_ideas_tenant_idx').on(t.tenantId, t.status, t.createdAt),
  oneOf('growth_ideas_status_chk', t.status, ['candidate', 'rejected', 'queued_for_test', 'testing', 'validated', 'invalidated', 'duplicate']),
  oneOf('growth_ideas_route_chk', t.route, ['discovery_test', 'full_test', 'reject']),
  oneOf('growth_ideas_source_chk', t.source, ['agent', 'human']),
  rawCheck('growth_ideas_evidence_chk', sql`cardinality(${t.evidenceIds}) > 0`),
]);

/* ------------------------------------------------------------------ */
/* M07 Growth Brain                                                   */
/* ------------------------------------------------------------------ */

export const agentRuns = pgTable('agent_runs', {
  id: pk(),
  tenantId: tenantId(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('running'),
  stages: json<unknown[]>('stages').notNull().default([]),
  input: json<Record<string, unknown>>('input').notNull().default({}),
  output: json<Record<string, unknown> | null>('output'),
  abstainReason: text('abstain_reason'),
  error: text('error'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  triggeredBy: text('triggered_by').notNull(),
}, (t) => [
  oneOf('agent_runs_status_chk', t.status, ['running', 'completed', 'abstained', 'failed']),
  index('agent_runs_tenant_idx').on(t.tenantId, t.startedAt),
]);

export const growthDecisions = pgTable('growth_decisions', {
  id: pk(),
  tenantId: tenantId(),
  objective: text('objective').notNull(),
  market: text('market').notNull(),
  horizon: json<Record<string, unknown>>('horizon').notNull(),
  proposedAction: json<Record<string, unknown> | null>('proposed_action'),
  evidenceIds: uuidArray('evidence_ids').notNull(),
  predictedOutcomes: json<Record<string, unknown>>('predicted_outcomes').notNull(),
  estimatedIncrementalEffect: json<Record<string, unknown>>('estimated_incremental_effect').notNull(),
  expectedCost: json<Record<string, unknown>>('expected_cost').notNull(),
  downsideRisk: json<Record<string, unknown>>('downside_risk').notNull(),
  assumptions: json<string[]>('assumptions').notNull(),
  counterfactualBaseline: json<Record<string, unknown> | null>('counterfactual_baseline'),
  policyResult: json<Record<string, unknown>>('policy_result').notNull(),
  approvalRequirement: json<Record<string, unknown>>('approval_requirement').notNull(),
  modelVersions: json<Record<string, string>>('model_versions').notNull(),
  utility: json<Record<string, unknown>>('utility').notNull(),
  narrative: text('narrative'),
  status: text('status').notNull().default('PROPOSED'),
  ideaId: uuid('idea_id'),
  agentRunId: uuid('agent_run_id'),
  actionId: uuid('action_id'),
  decidedBy: text('decided_by'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, (t) => [
  index('growth_decisions_tenant_idx').on(t.tenantId, t.status, t.createdAt),
  oneOf('growth_decisions_status_chk', t.status, ['PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED']),
  rawCheck('growth_decisions_evidence_chk', sql`cardinality(${t.evidenceIds}) > 0`),
]);

/* ------------------------------------------------------------------ */
/* M08 Forecasting                                                    */
/* ------------------------------------------------------------------ */

export const forecastRuns = pgTable('forecast_runs', {
  id: pk(),
  tenantId: tenantId(),
  requestId: uuid('request_id').notNull(),
  seriesId: uuid('series_id').notNull().references(() => metricSeries.id),
  horizon: integer('horizon').notNull(),
  status: text('status').notNull(),
  championModel: text('champion_model').notNull(),
  baselineModel: text('baseline_model').notNull(),
  candidates: json<unknown[]>('candidates').notNull(),
  gate: json<Record<string, unknown>>('gate').notNull(),
  selectionReason: text('selection_reason').notNull(),
  calibration: json<Record<string, unknown>>('calibration').notNull(),
  drift: json<Record<string, unknown>>('drift').notNull(),
  datasetSha256: text('dataset_sha256').notNull(),
  config: json<Record<string, unknown>>('config').notNull(),
  seed: integer('seed').notNull(),
  codeVersion: text('code_version').notNull(),
  createdAt: createdAt(),
}, (t) => [
  oneOf('forecast_runs_status_chk', t.status, ['champion_selected', 'fallback_baseline', 'abstained']),
  index('forecast_runs_series_idx').on(t.tenantId, t.seriesId, t.createdAt),
]);

export const forecastPoints = pgTable('forecast_points', {
  tenantId: tenantId(),
  runId: uuid('run_id').notNull().references(() => forecastRuns.id, { onDelete: 'cascade' }),
  ts: ts('ts').notNull(),
  mean: dbl('mean').notNull(),
  q025: dbl('q025').notNull(),
  q10: dbl('q10').notNull(),
  q50: dbl('q50').notNull(),
  q90: dbl('q90').notNull(),
  q975: dbl('q975').notNull(),
}, (t) => [primaryKey({ columns: [t.runId, t.ts] })]);

/* ------------------------------------------------------------------ */
/* M09 Causal Measurement & MMM                                       */
/* ------------------------------------------------------------------ */

export const mmmRuns = pgTable('mmm_runs', {
  id: pk(),
  tenantId: tenantId(),
  requestId: uuid('request_id').notNull(),
  kpiSeriesId: uuid('kpi_series_id').notNull(),
  channelSeriesIds: uuidArray('channel_series_ids').notNull(),
  controlSeriesIds: uuidArray('control_series_ids').notNull(),
  priors: json<Record<string, unknown>>('priors').notNull(),
  diagnostics: json<Record<string, unknown>>('diagnostics').notNull(),
  converged: boolean('converged').notNull(),
  causalLanguageAllowed: boolean('causal_language_allowed').notNull(),
  posteriorSummary: json<Record<string, unknown>>('posterior_summary').notNull(),
  responseCurves: json<Record<string, unknown>>('response_curves').notNull(),
  budgetScenarios: json<Record<string, unknown>>('budget_scenarios').notNull(),
  assumptions: json<string[]>('assumptions').notNull(),
  datasetSha256: text('dataset_sha256').notNull(),
  seed: integer('seed').notNull(),
  codeVersion: text('code_version').notNull(),
  createdAt: createdAt(),
}, (t) => [rawCheck('mmm_causal_requires_convergence_chk', sql`not ${t.causalLanguageAllowed} or ${t.converged}`)]);

/* ------------------------------------------------------------------ */
/* M10 Experimentation & Bandits                                      */
/* ------------------------------------------------------------------ */

export const experiments = pgTable('experiments', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  hypothesis: text('hypothesis').notNull(),
  ideaId: uuid('idea_id'),
  design: text('design').notNull(),
  unit: text('unit').notNull(),
  targetMetric: text('target_metric').notNull(),
  metricType: text('metric_type').notNull(),
  guardrails: json<unknown[]>('guardrails').notNull().default([]),
  eligibility: json<Record<string, unknown>>('eligibility').notNull().default({}),
  riskTier: text('risk_tier').notNull(),
  status: text('status').notNull().default('draft'),
  assignmentSalt: text('assignment_salt').notNull(),
  plannedSamplePerVariant: integer('planned_sample_per_variant'),
  holdoutFraction: dbl('holdout_fraction').notNull().default(0),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  oneOf('experiments_design_chk', t.design, ['ab_fixed', 'bandit_thompson']),
  oneOf('experiments_unit_chk', t.unit, ['profile', 'anonymous_id', 'session', 'geo']),
  oneOf('experiments_metric_type_chk', t.metricType, ['binary', 'continuous']),
  oneOf('experiments_risk_chk', t.riskTier, ['low', 'medium', 'high']),
  oneOf('experiments_status_chk', t.status, ['draft', 'approved', 'running', 'stopped', 'completed']),
]);

export const experimentVariants = pgTable('experiment_variants', {
  id: pk(),
  tenantId: tenantId(),
  experimentId: uuid('experiment_id').notNull().references(() => experiments.id),
  key: text('key').notNull(),
  description: text('description').notNull(),
  config: json<Record<string, unknown>>('config').notNull().default({}),
  isControl: boolean('is_control').notNull().default(false),
  weight: dbl('weight').notNull().default(1),
}, (t) => [uniqueIndex('experiment_variants_key_uq').on(t.experimentId, t.key)]);

export const experimentAssignments = pgTable('experiment_assignments', {
  id: pk(),
  tenantId: tenantId(),
  experimentId: uuid('experiment_id').notNull().references(() => experiments.id),
  variantId: uuid('variant_id').notNull().references(() => experimentVariants.id),
  unitId: text('unit_id').notNull(),
  assignedAt: ts('assigned_at').notNull().defaultNow(),
  allocationSnapshot: json<Record<string, unknown>>('allocation_snapshot').notNull(),
}, (t) => [uniqueIndex('experiment_assignments_unit_uq').on(t.experimentId, t.unitId)]);

export const experimentExposures = pgTable('experiment_exposures', {
  id: pk(),
  tenantId: tenantId(),
  experimentId: uuid('experiment_id').notNull().references(() => experiments.id),
  variantId: uuid('variant_id').notNull().references(() => experimentVariants.id),
  unitId: text('unit_id').notNull(),
  exposedAt: ts('exposed_at').notNull().defaultNow(),
}, (t) => [index('experiment_exposures_unit_idx').on(t.experimentId, t.unitId, t.exposedAt)]);

export const experimentOutcomes = pgTable('experiment_outcomes', {
  id: pk(),
  tenantId: tenantId(),
  experimentId: uuid('experiment_id').notNull().references(() => experiments.id),
  variantId: uuid('variant_id').notNull().references(() => experimentVariants.id),
  unitId: text('unit_id').notNull(),
  metric: text('metric').notNull(),
  value: dbl('value').notNull(),
  observedAt: ts('observed_at').notNull(),
}, (t) => [index('experiment_outcomes_exp_idx').on(t.experimentId, t.metric)]);

export const experimentResults = pgTable('experiment_results', {
  id: pk(),
  tenantId: tenantId(),
  experimentId: uuid('experiment_id').notNull().references(() => experiments.id),
  requestId: uuid('request_id'),
  perVariant: json<unknown[]>('per_variant').notNull(),
  probBest: json<Record<string, number>>('prob_best').notNull(),
  expectedLoss: json<Record<string, number>>('expected_loss').notNull(),
  srm: json<Record<string, unknown>>('srm').notNull(),
  guardrails: json<unknown[]>('guardrails').notNull(),
  frequentist: json<Record<string, unknown> | null>('frequentist'),
  recommendation: text('recommendation').notNull(),
  recommendationReason: text('recommendation_reason').notNull(),
  inferenceKind: text('inference_kind').notNull().default('randomized_test'),
  computedAt: ts('computed_at').notNull().defaultNow(),
}, (t) => [
  oneOf('experiment_results_rec_chk', t.recommendation, ['continue', 'ship_candidate', 'stop_rollback', 'invalid_srm', 'inconclusive', 'guardrail_breach']),
]);

export const banditStates = pgTable('bandit_states', {
  experimentId: uuid('experiment_id').primaryKey().references(() => experiments.id),
  tenantId: tenantId(),
  posteriors: json<Record<string, unknown>>('posteriors').notNull(),
  allocation: json<Record<string, number>>('allocation').notNull(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/* M11 Audience & Propensity                                          */
/* ------------------------------------------------------------------ */

export const segments = pgTable('segments', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  description: text('description'),
  definition: json<Record<string, unknown>>('definition').notNull(),
  definitionSha256: text('definition_sha256').notNull(),
  purpose: text('purpose').notNull(),
  usesSensitiveAttributes: boolean('uses_sensitive_attributes').notNull(),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('segments_name_version_uq').on(t.tenantId, t.name, t.version),
  oneOf('segments_status_chk', t.status, ['active', 'archived', 'blocked']),
]);

export const segmentSnapshots = pgTable('segment_snapshots', {
  id: pk(),
  tenantId: tenantId(),
  segmentId: uuid('segment_id').notNull().references(() => segments.id),
  definitionSha256: text('definition_sha256').notNull(),
  size: integer('size').notNull(),
  excludedBySuppression: integer('excluded_by_suppression').notNull(),
  excludedByConsent: integer('excluded_by_consent').notNull(),
  computedAt: ts('computed_at').notNull().defaultNow(),
});

export const segmentMembers = pgTable('segment_members', {
  tenantId: tenantId(),
  snapshotId: uuid('snapshot_id').notNull().references(() => segmentSnapshots.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
}, (t) => [primaryKey({ columns: [t.snapshotId, t.profileId] })]);

export const propensityModels = pgTable('propensity_models', {
  id: pk(),
  tenantId: tenantId(),
  requestId: uuid('request_id').notNull(),
  target: text('target').notNull(),
  features: textArray('features').notNull(),
  coefficients: json<Record<string, number>>('coefficients').notNull(),
  standardization: json<Record<string, unknown>>('standardization').notNull(),
  metrics: json<Record<string, unknown>>('metrics').notNull(),
  featurePolicy: json<Record<string, unknown>>('feature_policy').notNull(),
  status: text('status').notNull().default('candidate'),
  datasetSha256: text('dataset_sha256').notNull(),
  codeVersion: text('code_version').notNull(),
  trainedAt: ts('trained_at').notNull().defaultNow(),
}, (t) => [oneOf('propensity_models_status_chk', t.status, ['candidate', 'champion', 'retired', 'rejected'])]);

export const propensityScores = pgTable('propensity_scores', {
  tenantId: tenantId(),
  modelId: uuid('model_id').notNull().references(() => propensityModels.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  score: dbl('score').notNull(),
  intervalLow: dbl('interval_low').notNull(),
  intervalHigh: dbl('interval_high').notNull(),
  reasonCodes: json<unknown[]>('reason_codes').notNull(),
  scoredAt: ts('scored_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.modelId, t.profileId] })]);

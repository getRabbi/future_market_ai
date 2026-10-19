import { z } from 'zod';
import {
  ACTION_STATES,
  ARTIFACT_TYPES,
  CAPABILITY_FALLBACKS,
  DATA_PURPOSES,
  ESTIMATE_METHODS,
  EVIDENCE_KINDS,
  FRESHNESS_STATUSES,
  KILL_SWITCH_SCOPES,
  PII_CLASSES,
  POLICY_OUTCOMES,
  PROOF_VERDICTS,
  PROVIDERS,
  RISK_CATEGORIES,
  SOURCE_TYPES,
  TENANT_ROLES,
  TRI_STATE,
  VERIFICATION_METHODS,
} from './enums.js';

const isoDate = z.string().datetime({ offset: true });
const confidence = z.number().min(0).max(1);

/* ------------------------------------------------------------------ */
/* M01 evidence record (product plan "Minimum evidence object")         */
/* ------------------------------------------------------------------ */

export const EvidenceInputSchema = z.object({
  sourceId: z.string().uuid().nullable().default(null),
  sourceType: z.enum(SOURCE_TYPES),
  sourceOwner: z.string().min(1),
  sourceUriOrObjectId: z.string().min(1),
  retrievedAt: isoDate,
  observedAt: isoDate.nullable().default(null),
  geography: z.string().min(2).nullable().default(null),
  lawfulBasisOrConsentId: z.string().min(1).nullable().default(null),
  platformTermsVersion: z.string().min(1).nullable().default(null),
  licenseOrUsageRights: z.string().min(1).nullable(),
  schemaVersion: z.string().min(1),
  lineageParentIds: z.array(z.string().uuid()).default([]),
  piiClassification: z.enum(PII_CLASSES).nullable(),
  confidence: confidence.nullable(),
  permittedUses: z.array(z.enum(DATA_PURPOSES)).default([]),
  prohibitedUses: z.array(z.enum(DATA_PURPOSES)).default([]),
  kind: z.enum(EVIDENCE_KINDS),
  summary: z.string().max(4000).nullable().default(null),
  content: z.unknown().optional(),
  contentObjectKey: z.string().nullable().default(null),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  /** Whether the source is an external platform (then platformTermsVersion is required). */
  externalPlatform: z.boolean().default(false),
  /** Hours after observedAt/retrievedAt after which the evidence is stale. Null = unknown. */
  freshnessSlaHours: z.number().positive().nullable().default(null),
  expiresAt: isoDate.nullable().default(null),
});
export type EvidenceInput = z.input<typeof EvidenceInputSchema>;
export type EvidenceInputParsed = z.output<typeof EvidenceInputSchema>;

export const EvidenceRecordSchema = EvidenceInputSchema.extend({
  evidenceId: z.string().uuid(),
  tenantId: z.string().min(1),
  status: z.enum(['admitted', 'quarantined', 'rejected', 'expired']),
  quarantineReasons: z.array(z.string()),
  freshnessStatus: z.enum(FRESHNESS_STATUSES),
  createdAt: isoDate,
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/* ------------------------------------------------------------------ */
/* Probabilistic outputs                                              */
/* ------------------------------------------------------------------ */

export const IntervalSchema = z.object({
  level: z.number().gt(0).lt(1),
  low: z.number(),
  high: z.number(),
});

export const DistributionSchema = z.discriminatedUnion('family', [
  z.object({ family: z.literal('normal'), mean: z.number(), sd: z.number().nonnegative() }),
  z.object({ family: z.literal('lognormal'), mu: z.number(), sigma: z.number().nonnegative() }),
  z.object({ family: z.literal('beta'), alpha: z.number().positive(), beta: z.number().positive() }),
  z.object({
    family: z.literal('empirical'),
    quantiles: z.array(z.object({ q: z.number().min(0).max(1), value: z.number() })).min(3),
    sampleSize: z.number().int().positive(),
  }),
]);
export type Distribution = z.infer<typeof DistributionSchema>;

/* ------------------------------------------------------------------ */
/* M07 growth decision                                                */
/* ------------------------------------------------------------------ */

export const ProposedActionSchema = z.object({
  actionType: z.string().min(1),
  connectionId: z.string().uuid().nullable(),
  target: z.record(z.string(), z.unknown()),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().min(1).max(4000),
});

export const GrowthDecisionSchema = z.object({
  decisionId: z.string().uuid(),
  objective: z.string().min(1),
  tenantId: z.string().min(1),
  market: z.string().min(1),
  horizon: z.object({ value: z.number().int().positive(), unit: z.enum(['day', 'week', 'month']) }),
  proposedAction: ProposedActionSchema.nullable(),
  evidenceIds: z.array(z.string().uuid()).min(1),
  predictedOutcomes: z.object({
    metric: z.string().min(1),
    distribution: DistributionSchema,
    pointSummary: z.number().nullable(),
    interval: IntervalSchema,
    calibrationReference: z.string().min(1),
  }),
  estimatedIncrementalEffect: z
    .object({
      value: z.number().nullable(),
      method: z.enum(ESTIMATE_METHODS),
      uncertainty: IntervalSchema.nullable(),
      sourceRef: z.string().nullable(),
    })
    .refine((v) => v.value === null || v.uncertainty !== null, {
      message: 'uncertainty is required when an incremental effect value is present',
    })
    .refine((v) => v.value === null || v.method !== 'unknown', {
      message: 'an incremental effect value requires an identified method',
    }),
  expectedCost: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3), basis: z.string() }),
  downsideRisk: z.object({ description: z.string().min(1), p10Outcome: z.number().nullable(), riskScore: z.number().min(0).max(1) }),
  assumptions: z.array(z.string().min(1)).min(1),
  counterfactualBaseline: z.object({ description: z.string(), value: z.number().nullable() }).nullable(),
  policyResult: z.object({ outcome: z.enum(POLICY_OUTCOMES), reasons: z.array(z.string()), policyVersion: z.string() }),
  approvalRequirement: z.object({ required: z.boolean(), roles: z.array(z.enum(TENANT_ROLES)) }),
  modelVersions: z.record(z.string(), z.string()),
  utility: z.object({
    status: z.enum(['SCORED', 'UNSCORED_LAMBDAS_UNCONFIGURED', 'UNSCORED_INSUFFICIENT_EVIDENCE']),
    value: z.number().nullable(),
    components: z.record(z.string(), z.number()).nullable(),
  }),
  status: z.literal('PROPOSED'),
});
export type GrowthDecision = z.infer<typeof GrowthDecisionSchema>;

/* ------------------------------------------------------------------ */
/* M23 action request + policy decision                               */
/* ------------------------------------------------------------------ */

export const ActionRiskSchema = z.object({
  spendDeltaMicros: z.number().int().default(0),
  currency: z.string().length(3).nullable().default(null),
  audienceSize: z.number().int().nonnegative().nullable().default(null),
  geographies: z.array(z.string().min(2)).default([]),
  usesSensitiveAttributes: z.boolean().default(false),
  involvesChildren: z.boolean().default(false),
  syntheticPersonaId: z.string().uuid().nullable().default(null),
  materialConnection: z.boolean().default(false),
  regulatedClaim: z.boolean().default(false),
});
export type ActionRisk = z.infer<typeof ActionRiskSchema>;

export const ActionRequestInputSchema = z.object({
  actionType: z.string().min(1),
  connectionId: z.string().uuid().nullable(),
  target: z.record(z.string(), z.unknown()).default({}),
  params: z.record(z.string(), z.unknown()),
  decisionId: z.string().uuid().nullable().default(null),
  evidenceIds: z.array(z.string().uuid()).default([]),
  risk: ActionRiskSchema.default({
    spendDeltaMicros: 0,
    currency: null,
    audienceSize: null,
    geographies: [],
    usesSensitiveAttributes: false,
    involvesChildren: false,
    syntheticPersonaId: null,
    materialConnection: false,
    regulatedClaim: false,
  }),
  idempotencyKey: z.string().min(8).max(200),
  expiresAt: isoDate.nullable().default(null),
});
export type ActionRequestInput = z.input<typeof ActionRequestInputSchema>;

export const ProposerSchema = z.object({
  type: z.enum(['user', 'agent', 'system']),
  id: z.string().min(1),
  modelId: z.string().nullable().default(null),
  promptVersion: z.string().nullable().default(null),
});
export type Proposer = z.infer<typeof ProposerSchema>;

export const ApprovalGroupSchema = z.object({
  /** Group name, e.g. `operational`, `finance`, `legal`, `privacy`. Every group needs one approval. */
  name: z.string().min(1),
  anyOfRoles: z.array(z.enum(TENANT_ROLES)).min(1),
});
export type ApprovalGroup = z.infer<typeof ApprovalGroupSchema>;

export const PolicyDecisionSchema = z.object({
  outcome: z.enum(POLICY_OUTCOMES),
  reasons: z.array(
    z.object({ code: z.string(), message: z.string(), rule: z.string(), effect: z.enum(POLICY_OUTCOMES) }),
  ),
  approvalGroups: z.array(ApprovalGroupSchema),
  requiresDistinctApprover: z.boolean(),
  policyVersion: z.string(),
  evaluatedAt: isoDate,
  constraints: z.record(z.string(), z.unknown()),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const ActionRequestSchema = ActionRequestInputSchema.extend({
  actionId: z.string().uuid(),
  tenantId: z.string().min(1),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposedBy: ProposerSchema,
  status: z.enum(ACTION_STATES),
  policyDecision: PolicyDecisionSchema.nullable(),
  createdAt: isoDate,
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

/* ------------------------------------------------------------------ */
/* M24 execution proof                                                */
/* ------------------------------------------------------------------ */

export const ExecutionReceiptSchema = z.object({
  providerRequestId: z.string().nullable(),
  providerObjectId: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  observedAt: isoDate,
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

export const ExecutionProofSchema = z.object({
  verdict: z.enum(PROOF_VERDICTS),
  method: z.enum(VERIFICATION_METHODS),
  expected: z.record(z.string(), z.unknown()),
  observed: z.record(z.string(), z.unknown()).nullable(),
  diff: z.array(z.object({ path: z.string(), expected: z.unknown(), observed: z.unknown() })),
  checkedAt: isoDate,
  notes: z.string().nullable().default(null),
});
export type ExecutionProof = z.infer<typeof ExecutionProofSchema>;

/* ------------------------------------------------------------------ */
/* Platform capability registry (product plan)                        */
/* ------------------------------------------------------------------ */

export const PlatformCapabilitySchema = z.object({
  platform: z.enum(PROVIDERS),
  apiVersion: z.string().min(1),
  capability: z.string().min(1),
  supported: z.boolean(),
  requiredScopes: z.array(z.string()),
  requiredAccountType: z.string().nullable(),
  appReviewRequired: z.enum(['true', 'false', 'unspecified']),
  rateLimitPolicy: z.object({
    kind: z.enum(['token_bucket', 'fixed_window', 'provider_dynamic']),
    capacity: z.number().positive().nullable(),
    refillPerSecond: z.number().positive().nullable(),
    notes: z.string().nullable(),
  }),
  quota: z.record(z.string(), z.unknown()),
  regionalRestrictions: z.array(z.string()),
  termsCheckedAt: isoDate,
  termsVersion: z.string().nullable(),
  connectorVersion: z.string().min(1),
  fallback: z.enum(CAPABILITY_FALLBACKS),
  sourceUrl: z.string().url().nullable(),
  notes: z.string().nullable(),
});
export type PlatformCapability = z.infer<typeof PlatformCapabilitySchema>;

/* ------------------------------------------------------------------ */
/* Model / asset licence gate (product plan)                          */
/* ------------------------------------------------------------------ */

export const ModelArtifactSchema = z.object({
  exactName: z.string().min(1),
  versionOrCommit: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactType: z.enum(ARTIFACT_TYPES),
  copyrightOwner: z.string().nullable(),
  licenseIdOrCustomTerms: z.string().min(1),
  commercialUse: z.enum(TRI_STATE),
  redistribution: z.enum(TRI_STATE),
  derivativeUse: z.enum(TRI_STATE),
  attributionRequired: z.enum(['true', 'false', 'unknown']),
  geographicOrUseRestrictions: z.array(z.string()),
  sourceDataRightsStatus: z.enum(['known', 'unknown']),
  approvedForProduction: z.boolean().default(false),
  approvedBy: z.string().nullable().default(null),
  approvedAt: isoDate.nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
});
export type ModelArtifact = z.infer<typeof ModelArtifactSchema>;

/* ------------------------------------------------------------------ */
/* Event envelope                                                     */
/* ------------------------------------------------------------------ */

export const EventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+){1,4}$/),
  eventVersion: z.number().int().positive(),
  tenantId: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  occurredAt: isoDate,
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  actor: z.object({ type: z.enum(['user', 'agent', 'system', 'connector']), id: z.string() }),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/* ------------------------------------------------------------------ */
/* Tenant policy ([U] thresholds are tenant-configured, never invented) */
/* ------------------------------------------------------------------ */

export const AutonomyLevelSchema = z.enum(['deny', 'approval_required', 'pre_authorized_within_limits']);

export const CategoryPolicySchema = z.object({
  autonomy: AutonomyLevelSchema,
  approverRoles: z.array(z.enum(TENANT_ROLES)).min(1),
  requiresDistinctApprover: z.boolean().default(true),
  /** Per-action absolute spend delta ceiling for pre-authorised execution, micros. */
  maxSpendDeltaMicrosPerAction: z.number().int().nonnegative().nullable().default(null),
  /** Rolling 24h pre-authorised spend increase ceiling, micros. */
  maxSpendDeltaMicrosPerDay: z.number().int().nonnegative().nullable().default(null),
  maxAudienceSize: z.number().int().positive().nullable().default(null),
});
export type CategoryPolicy = z.infer<typeof CategoryPolicySchema>;

export const TenantPolicySchema = z.object({
  version: z.number().int().positive(),
  configured: z.boolean(),
  categories: z.partialRecord(z.enum(RISK_CATEGORIES), CategoryPolicySchema).default({}),
  lambdas: z
    .object({ risk: z.number().nonnegative(), cost: z.number().nonnegative(), uncertainty: z.number().nonnegative() })
    .nullable()
    .default(null),
  currency: z.string().length(3).nullable().default(null),
  approvalTtlHours: z.number().positive().max(720).nullable().default(null),
  messaging: z
    .object({
      maxCommercialMessagesPerProfilePerWeek: z.number().int().positive(),
      quietHours: z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23), timezone: z.string() }),
    })
    .nullable()
    .default(null),
  forecastGates: z
    .object({
      maxMaseRatioToBaseline: z.number().positive(),
      intervalCoverageTolerance: z.number().positive().max(0.5),
      minBacktestFolds: z.number().int().min(2),
    })
    .nullable()
    .default(null),
  mmmGates: z.object({ maxRhat: z.number().gt(1), minEss: z.number().positive() }).nullable().default(null),
  approvedJurisdictions: z.array(z.string().min(2)).default([]),
  evidenceMaxAgeHours: z.number().positive().nullable().default(null),
});
export type TenantPolicy = z.infer<typeof TenantPolicySchema>;

export const KillSwitchInputSchema = z.object({
  scope: z.enum(KILL_SWITCH_SCOPES),
  targetRef: z.string().nullable(),
  reason: z.string().min(3).max(2000),
});

export const RiskCategorySchema = z.enum(RISK_CATEGORIES);

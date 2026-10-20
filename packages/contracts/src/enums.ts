/**
 * Shared enumerations. Kept as `as const` tuples so the same values feed Zod schemas,
 * Drizzle pgEnums and the database transition trigger.
 */

export const SOURCE_TYPES = ['primary', 'research', 'secondary', 'internal'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Evidence flags from the product plan ([P], [R], [D], [I], [U], [BLOCK]). */
export const EVIDENCE_FLAGS = ['P', 'R', 'D', 'I', 'U', 'BLOCK'] as const;
export type EvidenceFlag = (typeof EVIDENCE_FLAGS)[number];

export const PII_CLASSES = ['none', 'pseudonymous', 'personal', 'sensitive', 'children'] as const;
export type PiiClass = (typeof PII_CLASSES)[number];

export const FRESHNESS_STATUSES = ['current', 'stale', 'unknown'] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

export const EVIDENCE_STATUSES = ['admitted', 'quarantined', 'rejected', 'expired'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_KINDS = ['metric', 'document', 'observation', 'api_response', 'snapshot', 'contract', 'license', 'consent', 'experiment_result', 'model_output'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Purposes for which evidence/personal data may be used (purpose limitation). */
export const DATA_PURPOSES = ['analytics', 'forecasting', 'causal_measurement', 'experimentation', 'personalization', 'targeting', 'creative_generation', 'publishing', 'messaging', 'competitive_analysis', 'support', 'autonomous_execution'] as const;
export type DataPurpose = (typeof DATA_PURPOSES)[number];

/**
 * Execution state machine (product plan, D-011). There is deliberately no SUCCESS state.
 */
export const ACTION_STATES = ['PROPOSED', 'EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVAL_REQUIRED', 'APPROVED', 'PREFLIGHT_VERIFIED', 'EXECUTING', 'EXECUTED_UNVERIFIED', 'VERIFIED', 'FAILED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK', 'ESCALATED', 'DENIED', 'REJECTED', 'CANCELLED'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  PROPOSED: ['EVIDENCE_READY', 'DENIED', 'CANCELLED'],
  EVIDENCE_READY: ['POLICY_CHECKED', 'DENIED', 'CANCELLED'],
  POLICY_CHECKED: ['APPROVAL_REQUIRED', 'APPROVED', 'DENIED', 'CANCELLED'],
  APPROVAL_REQUIRED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PREFLIGHT_VERIFIED', 'FAILED', 'CANCELLED'],
  PREFLIGHT_VERIFIED: ['EXECUTING', 'FAILED', 'CANCELLED'],
  EXECUTING: ['EXECUTED_UNVERIFIED', 'FAILED', 'ESCALATED'],
  EXECUTED_UNVERIFIED: ['VERIFIED', 'ROLLBACK_REQUIRED', 'ESCALATED', 'FAILED'],
  VERIFIED: [],
  FAILED: [],
  ROLLBACK_REQUIRED: ['ROLLED_BACK', 'ESCALATED'],
  ROLLED_BACK: [],
  ESCALATED: ['ROLLED_BACK', 'VERIFIED', 'FAILED'],
  DENIED: [],
  REJECTED: [],
  CANCELLED: [],
};

export const TERMINAL_ACTION_STATES: readonly ActionState[] = ACTION_STATES.filter((s) => ACTION_TRANSITIONS[s].length === 0);

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export const POLICY_OUTCOMES = ['DENY', 'REQUIRE_APPROVAL', 'PRE_AUTHORIZED'] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

export const PROOF_VERDICTS = ['VERIFIED', 'MISMATCH', 'PENDING', 'UNVERIFIABLE'] as const;
export type ProofVerdict = (typeof PROOF_VERDICTS)[number];

export const VERIFICATION_METHODS = ['read_after_write', 'status_poll', 'webhook', 'reconciliation', 'database_readback'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const KILL_SWITCH_SCOPES = ['system', 'tenant', 'connector', 'object', 'model', 'agent'] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export const PROVIDERS = ['internal', 'meta', 'google_ads', 'tiktok', 'youtube', 'shopify', 'app_store_connect', 'google_play', 'resend', 'posthog', 'chatwoot', 'search_console'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const CAPABILITY_FALLBACKS = ['queue_for_human', 'disable', 'read_only'] as const;
export type CapabilityFallback = (typeof CAPABILITY_FALLBACKS)[number];

export const TRI_STATE = ['allowed', 'restricted', 'unknown'] as const;
export type TriState = (typeof TRI_STATE)[number];

export const ARTIFACT_TYPES = ['code', 'weights', 'lora', 'embedding', 'voice', 'dataset', 'plugin', 'stock_media', 'music', 'font', 'likeness'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const RISK_CATEGORIES = ['SPEND', 'PRICING', 'PUBLIC_PUBLISHING', 'MESSAGING', 'TARGETING', 'DATA_EXPORT', 'SYNTHETIC_PERSONA', 'EXPERIMENT', 'STORE_METADATA', 'PAYOUT', 'INTERNAL'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** Organization roles (Better Auth member.role may hold several, comma separated). */
export const TENANT_ROLES = ['owner', 'admin', 'growth_operator', 'approver', 'finance_approver', 'legal_approver', 'privacy_officer', 'analyst', 'viewer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const CONSENT_STATUSES = ['granted', 'denied', 'withdrawn'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const LAWFUL_BASES = ['consent', 'contract', 'legitimate_interest', 'legal_obligation', 'vital_interest', 'public_task'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

export const CONSENT_PURPOSES = ['marketing_email', 'marketing_sms', 'marketing_push', 'analytics', 'personalization', 'ads_customer_match', 'sale_or_share', 'profiling'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const MESSAGE_CHANNELS = ['email', 'sms', 'push', 'whatsapp'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const SUPPRESSION_CHANNELS = ['email', 'sms', 'push', 'whatsapp', 'ads', 'all'] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];

export const ANALYTICS_KINDS = ['forecast', 'mmm', 'experiment_analysis', 'trend_detection', 'topic_clustering', 'propensity_training', 'anomaly_scan', 'backup_verification'] as const;
export type AnalyticsKind = (typeof ANALYTICS_KINDS)[number];

export const ESTIMATE_METHODS = ['experiment', 'mmm', 'causal_model', 'unknown'] as const;
export type EstimateMethod = (typeof ESTIMATE_METHODS)[number];

/**
 * Typed result kinds (product plan "causality boundary"): these must never be conflated.
 */
export const INFERENCE_KINDS = ['attribution', 'correlation', 'forecast', 'causal_effect', 'mmm_estimate', 'randomized_test'] as const;
export type InferenceKind = (typeof INFERENCE_KINDS)[number];

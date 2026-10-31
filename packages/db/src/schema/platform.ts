import { ACTION_STATES, CAPABILITY_FALLBACKS, KILL_SWITCH_SCOPES, PROOF_VERDICTS, PROVIDERS, TRI_STATE, VERIFICATION_METHODS } from '@futuregrow/contracts';
import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dbl, json, micros, oneOf, pk, rawCheck, tenantId, textArray, ts, updatedAt, uuidArray } from './_common.js';

/* ------------------------------------------------------------------ */
/* Tenant configuration                                               */
/* ------------------------------------------------------------------ */

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: text('tenant_id').primaryKey(),
  policy: json<Record<string, unknown>>('policy').notNull(),
  policyVersion: integer('policy_version').notNull().default(1),
  senderIdentity: json<Record<string, unknown> | null>('sender_identity'),
  remotionLicense: json<Record<string, unknown> | null>('remotion_license'),
  /** Per-tenant rollout switch for the Autopilot (D-033); off until an owner or admin enables it. */
  autopilotEnabled: boolean('autopilot_enabled').notNull().default(false),
  updatedBy: text('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Global operator-level controls (system kill switch). Not tenant scoped; tenants may read. */
export const systemControls = pgTable('system_controls', {
  key: text('key').primaryKey(),
  engaged: boolean('engaged').notNull().default(false),
  reason: text('reason'),
  changedBy: text('changed_by'),
  changedAt: ts('changed_at').notNull().defaultNow(),
});

export const killSwitches = pgTable(
  'kill_switches',
  {
    id: pk(),
    tenantId: tenantId(),
    scope: text('scope').notNull(),
    targetRef: text('target_ref'),
    engaged: boolean('engaged').notNull().default(true),
    reason: text('reason').notNull(),
    engagedBy: text('engaged_by').notNull(),
    engagedAt: ts('engaged_at').notNull().defaultNow(),
    releasedBy: text('released_by'),
    releasedAt: ts('released_at'),
  },
  (t) => [
    oneOf(
      'kill_switches_scope_chk',
      t.scope,
      KILL_SWITCH_SCOPES.filter((s) => s !== 'system'),
    ),
    index('kill_switches_active_idx').on(t.tenantId, t.engaged, t.scope),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: tenantId(),
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(),
    responseStatus: integer('response_status'),
    responseBody: json<unknown>('response_body'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scope, t.key] }), oneOf('idempotency_status_chk', t.status, ['in_progress', 'completed'])],
);

/* ------------------------------------------------------------------ */
/* Events: transactional outbox + webhook inbox (D-009)               */
/* ------------------------------------------------------------------ */

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    dispatchedAt: ts('dispatched_at'),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [index('outbox_undispatched_idx').on(t.occurredAt).where(sql`${t.dispatchedAt} is null`), index('outbox_tenant_type_idx').on(t.tenantId, t.eventType, t.occurredAt)],
);

/** System table: tenant is resolved after signature verification, hence `resolved_tenant_id`. */
export const webhookInbox = pgTable(
  'webhook_inbox',
  {
    id: pk(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    resolvedTenantId: text('resolved_tenant_id'),
    connectionId: uuid('connection_id'),
    topic: text('topic'),
    signatureValid: boolean('signature_valid').notNull(),
    headers: json<Record<string, string>>('headers').notNull(),
    payload: json<unknown>('payload').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    status: text('status').notNull().default('received'),
    processedAt: ts('processed_at'),
    error: text('error'),
  },
  (t) => [uniqueIndex('webhook_inbox_dedup_uq').on(t.provider, t.providerEventId), oneOf('webhook_inbox_status_chk', t.status, ['received', 'processed', 'failed', 'ignored', 'rejected_signature']), oneOf('webhook_inbox_provider_chk', t.provider, PROVIDERS)],
);

/* ------------------------------------------------------------------ */
/* Immutable, hash-chained audit trail (M24)                           */
/* ------------------------------------------------------------------ */

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    prevHash: text('prev_hash').notNull(),
    recordHash: text('record_hash').notNull(),
    occurredAt: text('occurred_at').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    correlationId: text('correlation_id'),
  },
  (t) => [uniqueIndex('audit_log_tenant_seq_uq').on(t.tenantId, t.seq), index('audit_log_subject_idx').on(t.tenantId, t.subjectType, t.subjectId), oneOf('audit_actor_type_chk', t.actorType, ['user', 'agent', 'system', 'connector'])],
);

export const auditChainHeads = pgTable('audit_chain_heads', {
  tenantId: text('tenant_id').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
  lastHash: text('last_hash').notNull(),
});

/* ------------------------------------------------------------------ */
/* Governance registries                                              */
/* ------------------------------------------------------------------ */

/** Global platform capability registry (product plan `platform_capability`). */
export const platformCapabilities = pgTable(
  'platform_capabilities',
  {
    id: pk(),
    platform: text('platform').notNull(),
    apiVersion: text('api_version').notNull(),
    capability: text('capability').notNull(),
    supported: boolean('supported').notNull(),
    requiredScopes: textArray('required_scopes').notNull().default(sql`'{}'::text[]`),
    requiredAccountType: text('required_account_type'),
    appReviewRequired: text('app_review_required').notNull(),
    rateLimitPolicy: json<Record<string, unknown>>('rate_limit_policy').notNull(),
    quota: json<Record<string, unknown>>('quota').notNull(),
    regionalRestrictions: textArray('regional_restrictions').notNull().default(sql`'{}'::text[]`),
    termsCheckedAt: ts('terms_checked_at').notNull(),
    termsVersion: text('terms_version'),
    connectorVersion: text('connector_version').notNull(),
    fallback: text('fallback').notNull(),
    sourceUrl: text('source_url'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('platform_capabilities_uq').on(t.platform, t.capability, t.apiVersion), oneOf('platform_capabilities_fallback_chk', t.fallback, CAPABILITY_FALLBACKS), oneOf('platform_capabilities_review_chk', t.appReviewRequired, ['true', 'false', 'unspecified'])],
);

/** Global LLM/model registry (operator approves vendor terms, D-002). */
export const modelRegistry = pgTable(
  'model_registry',
  {
    id: pk(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    purposes: textArray('purposes').notNull(),
    licenseOrTerms: text('license_or_terms').notNull(),
    commercialUse: text('commercial_use').notNull(),
    trainingOnCustomerData: text('training_on_customer_data').notNull(),
    dataRetentionTerms: text('data_retention_terms'),
    approvedForProduction: boolean('approved_for_production').notNull().default(false),
    approvedBy: text('approved_by'),
    approvedAt: ts('approved_at'),
    inputUsdPerMtok: dbl('input_usd_per_mtok'),
    outputUsdPerMtok: dbl('output_usd_per_mtok'),
    status: text('status').notNull().default('active'),
    eolAt: ts('eol_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('model_registry_uq').on(t.provider, t.modelId),
    oneOf('model_registry_commercial_chk', t.commercialUse, TRI_STATE),
    oneOf('model_registry_training_chk', t.trainingOnCustomerData, ['no', 'yes', 'unknown']),
    oneOf('model_registry_status_chk', t.status, ['active', 'deprecated', 'eol']),
    rawCheck('model_registry_approval_chk', sql`not ${t.approvedForProduction} or (${t.commercialUse} = 'allowed' and ${t.approvedBy} is not null)`),
  ],
);

/** Tenant-scoped model/media artifact licence registry (product plan `model_artifact`). */
export const artifactLicenses = pgTable(
  'artifact_licenses',
  {
    id: pk(),
    tenantId: tenantId(),
    exactName: text('exact_name').notNull(),
    versionOrCommit: text('version_or_commit').notNull(),
    sha256: text('sha256').notNull(),
    artifactType: text('artifact_type').notNull(),
    copyrightOwner: text('copyright_owner'),
    licenseIdOrCustomTerms: text('license_id_or_custom_terms').notNull(),
    commercialUse: text('commercial_use').notNull(),
    redistribution: text('redistribution').notNull(),
    derivativeUse: text('derivative_use').notNull(),
    attributionRequired: text('attribution_required').notNull(),
    geographicOrUseRestrictions: textArray('geographic_or_use_restrictions').notNull().default(sql`'{}'::text[]`),
    sourceDataRightsStatus: text('source_data_rights_status').notNull(),
    approvedForProduction: boolean('approved_for_production').notNull().default(false),
    approvedBy: text('approved_by'),
    approvedAt: ts('approved_at'),
    sourceUrl: text('source_url'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('artifact_licenses_uq').on(t.tenantId, t.sha256),
    oneOf('artifact_licenses_commercial_chk', t.commercialUse, TRI_STATE),
    // product plan: nothing moves to production while commercial_use=unknown
    rawCheck('artifact_licenses_approval_chk', sql`not ${t.approvedForProduction} or (${t.commercialUse} = 'allowed' and ${t.sourceDataRightsStatus} = 'known' and ${t.approvedBy} is not null)`),
  ],
);

/** Global, versioned jurisdiction rule packs (legal must approve; D-012/B-013). */
export const jurisdictionRules = pgTable(
  'jurisdiction_rules',
  {
    id: pk(),
    jurisdiction: text('jurisdiction').notNull(),
    domain: text('domain').notNull(),
    version: integer('version').notNull(),
    rules: json<Record<string, unknown>>('rules').notNull(),
    approvedByLegal: boolean('approved_by_legal').notNull().default(false),
    approvedBy: text('approved_by'),
    approvedAt: ts('approved_at'),
    effectiveFrom: ts('effective_from'),
    sourceRefs: textArray('source_refs').notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('jurisdiction_rules_uq').on(t.jurisdiction, t.domain, t.version)],
);

/** Connected external accounts. Secrets live in connection_secrets (encrypted). */
export const connections = pgTable(
  'connections',
  {
    id: pk(),
    tenantId: tenantId(),
    provider: text('provider').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('active'),
    grantedScopes: textArray('granted_scopes').notNull().default(sql`'{}'::text[]`),
    accessLevel: text('access_level'),
    appAudited: boolean('app_audited'),
    apiVersion: text('api_version'),
    metadata: json<Record<string, unknown>>('metadata').notNull().default({}),
    healthStatus: text('health_status').notNull().default('unknown'),
    lastHealthCheckAt: ts('last_health_check_at'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connections_tenant_provider_account_uq').on(t.tenantId, t.provider, t.externalAccountId),
    index('connections_provider_account_idx').on(t.provider, t.externalAccountId),
    oneOf('connections_provider_chk', t.provider, PROVIDERS),
    oneOf('connections_status_chk', t.status, ['active', 'reauth_required', 'revoked', 'disabled', 'read_only']),
    oneOf('connections_health_chk', t.healthStatus, ['unknown', 'healthy', 'degraded', 'failing']),
  ],
);

export const connectionSecrets = pgTable('connection_secrets', {
  connectionId: uuid('connection_id')
    .primaryKey()
    .references(() => connections.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  keyVersion: integer('key_version').notNull(),
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
  rotatedAt: ts('rotated_at'),
});

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    tenantId: tenantId(),
    bucketKey: text('bucket_key').notNull(),
    tokens: dbl('tokens').notNull(),
    capacity: dbl('capacity').notNull(),
    refillPerSecond: dbl('refill_per_second').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.bucketKey] })],
);

/* ------------------------------------------------------------------ */
/* M23 execution gateway / M24 verification                           */
/* ------------------------------------------------------------------ */

export const actionRequests = pgTable(
  'action_requests',
  {
    id: pk(),
    tenantId: tenantId(),
    actionType: text('action_type').notNull(),
    provider: text('provider').notNull(),
    connectionId: uuid('connection_id').references(() => connections.id),
    target: json<Record<string, unknown>>('target').notNull(),
    params: json<Record<string, unknown>>('params').notNull(),
    actionHash: text('action_hash').notNull(),
    proposedByType: text('proposed_by_type').notNull(),
    proposedById: text('proposed_by_id').notNull(),
    proposerModelId: text('proposer_model_id'),
    proposerPromptVersion: text('proposer_prompt_version'),
    decisionId: uuid('decision_id'),
    evidenceIds: uuidArray('evidence_ids').notNull().default(sql`'{}'::uuid[]`),
    risk: json<Record<string, unknown>>('risk').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('PROPOSED'),
    statusReason: text('status_reason'),
    policyDecision: json<Record<string, unknown> | null>('policy_decision'),
    policyVersion: text('policy_version'),
    attempts: integer('attempts').notNull().default(0),
    correlationId: text('correlation_id'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('action_requests_idem_uq').on(t.tenantId, t.idempotencyKey), index('action_requests_status_idx').on(t.tenantId, t.status, t.createdAt), oneOf('action_requests_status_chk', t.status, ACTION_STATES), oneOf('action_requests_proposer_chk', t.proposedByType, ['user', 'agent', 'system'])],
);

export const actionTransitions = pgTable(
  'action_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenantId(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actionRequests.id),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    actor: text('actor').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('action_transitions_action_idx').on(t.actionId, t.at)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: pk(),
    tenantId: tenantId(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actionRequests.id),
    actionHash: text('action_hash').notNull(),
    decision: text('decision').notNull(),
    approverUserId: text('approver_user_id').notNull(),
    approverRoles: textArray('approver_roles').notNull(),
    mfaVerified: boolean('mfa_verified').notNull(),
    comment: text('comment'),
    decidedAt: ts('decided_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('approvals_action_idx').on(t.actionId), oneOf('approvals_decision_chk', t.decision, ['approved', 'rejected'])],
);

export const executions = pgTable(
  'executions',
  {
    id: pk(),
    tenantId: tenantId(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actionRequests.id),
    attempt: integer('attempt').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    outcome: text('outcome').notNull().default('in_flight'),
    providerRequestId: text('provider_request_id'),
    providerObjectId: text('provider_object_id'),
    receipt: json<Record<string, unknown> | null>('receipt'),
    receiptSha256: text('receipt_sha256'),
    responseArchiveKey: text('response_archive_key'),
    beforeState: json<Record<string, unknown> | null>('before_state'),
    error: json<Record<string, unknown> | null>('error'),
  },
  (t) => [uniqueIndex('executions_action_attempt_uq').on(t.actionId, t.attempt), oneOf('executions_outcome_chk', t.outcome, ['in_flight', 'executed', 'failed', 'ambiguous'])],
);

export const executionProofs = pgTable(
  'execution_proofs',
  {
    id: pk(),
    tenantId: tenantId(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actionRequests.id),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => executions.id),
    verdict: text('verdict').notNull(),
    method: text('method').notNull(),
    /** 'postcondition' proves the intended change; 'rollback' proves its compensation. */
    purpose: text('purpose').notNull().default('postcondition'),
    expected: json<Record<string, unknown>>('expected').notNull(),
    observed: json<Record<string, unknown> | null>('observed'),
    diff: json<unknown[]>('diff').notNull(),
    evidenceSha256: text('evidence_sha256').notNull(),
    evidenceId: uuid('evidence_id'),
    attempt: integer('attempt').notNull(),
    notes: text('notes'),
    checkedAt: ts('checked_at').notNull().defaultNow(),
  },
  (t) => [index('execution_proofs_action_idx').on(t.actionId, t.checkedAt), oneOf('execution_proofs_verdict_chk', t.verdict, PROOF_VERDICTS), oneOf('execution_proofs_method_chk', t.method, VERIFICATION_METHODS), oneOf('execution_proofs_purpose_chk', t.purpose, ['postcondition', 'rollback'])],
);

export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: pk(),
    tenantId: tenantId(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actionRequests.id),
    connectionId: uuid('connection_id'),
    currency: text('currency').notNull(),
    amountMicros: micros('amount_micros').notNull(),
    status: text('status').notNull().default('held'),
    createdAt: createdAt(),
    settledAt: ts('settled_at'),
  },
  (t) => [uniqueIndex('budget_reservations_action_uq').on(t.actionId), oneOf('budget_reservations_status_chk', t.status, ['held', 'committed', 'released']), rawCheck('budget_reservations_amount_chk', sql`${t.amountMicros} >= 0`)],
);

export const spendLedger = pgTable(
  'spend_ledger',
  {
    id: pk(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    campaignRef: text('campaign_ref').notNull(),
    spendDate: text('spend_date').notNull(),
    currency: text('currency').notNull(),
    amountMicros: micros('amount_micros').notNull(),
    source: text('source').notNull(),
    reportRef: text('report_ref'),
    evidenceId: uuid('evidence_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('spend_ledger_report_uq').on(t.tenantId, t.connectionId, t.campaignRef, t.spendDate, t.source), oneOf('spend_ledger_source_chk', t.source, ['provider_report', 'adjustment'])],
);

export const spendReconciliations = pgTable(
  'spend_reconciliations',
  {
    id: pk(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    currency: text('currency').notNull(),
    authorizedMicros: micros('authorized_micros').notNull(),
    reportedMicros: micros('reported_micros').notNull(),
    deltaMicros: micros('delta_micros').notNull(),
    status: text('status').notNull(),
    details: json<Record<string, unknown>>('details').notNull(),
    createdAt: createdAt(),
  },
  (t) => [oneOf('spend_reconciliations_status_chk', t.status, ['ok', 'discrepancy', 'insufficient_data'])],
);

export const incidents = pgTable(
  'incidents',
  {
    id: pk(),
    tenantId: tenantId(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull().default('open'),
    refs: json<Record<string, unknown>>('refs').notNull().default({}),
    openedBy: text('opened_by').notNull(),
    openedAt: ts('opened_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    resolution: text('resolution'),
  },
  (t) => [oneOf('incidents_severity_chk', t.severity, ['sev1', 'sev2', 'sev3', 'sev4']), oneOf('incidents_status_chk', t.status, ['open', 'mitigated', 'resolved'])],
);

export const alerts = pgTable(
  'alerts',
  {
    id: pk(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    refs: json<Record<string, unknown>>('refs').notNull().default({}),
    dedupKey: text('dedup_key'),
    createdAt: createdAt(),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: ts('acknowledged_at'),
  },
  (t) => [oneOf('alerts_severity_chk', t.severity, ['info', 'warning', 'critical']), uniqueIndex('alerts_dedup_uq').on(t.tenantId, t.dedupKey).where(sql`${t.acknowledgedAt} is null`)],
);

export const costLedger = pgTable(
  'cost_ledger',
  {
    id: pk(),
    tenantId: tenantId(),
    category: text('category').notNull(),
    provider: text('provider').notNull(),
    unit: text('unit').notNull(),
    quantity: dbl('quantity').notNull(),
    unitCostUsd: dbl('unit_cost_usd'),
    amountUsd: dbl('amount_usd'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    metadata: json<Record<string, unknown>>('metadata').notNull().default({}),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [oneOf('cost_ledger_category_chk', t.category, ['llm', 'embedding', 'media_render', 'api', 'analytics', 'storage']), index('cost_ledger_tenant_time_idx').on(t.tenantId, t.occurredAt)],
);

/**
 * Platform backups and their verification (M24 backup/restore). Not tenant-scoped: only the
 * owner (system) role reads or writes it; the analytics job records every run.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: pk(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    objectKey: text('object_key'),
    archiveSha256: text('archive_sha256'),
    bytes: bigint('bytes', { mode: 'number' }),
    tableCounts: json<Record<string, number>>('table_counts').notNull().default({}),
    details: json<Record<string, unknown>>('details').notNull().default({}),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
  },
  (t) => [index('backup_runs_kind_time_idx').on(t.kind, t.finishedAt), oneOf('backup_runs_kind_chk', t.kind, ['backup', 'verification', 'restore_drill']), oneOf('backup_runs_status_chk', t.status, ['succeeded', 'failed'])],
);

/**
 * Operator notifications (alert webhook) with durable de-duplication: one row per dedup key, so
 * an alert, incident, failed job or component problem is announced once (re-announced only after
 * `renotify` intervals) and its recovery once. Not tenant-scoped; written by the system role.
 */
export const opsNotifications = pgTable(
  'ops_notifications',
  {
    dedupKey: text('dedup_key').primaryKey(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull().default({}),
    firstSentAt: ts('first_sent_at').notNull().defaultNow(),
    lastSentAt: ts('last_sent_at').notNull().defaultNow(),
    delivered: boolean('delivered').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [index('ops_notifications_open_idx').on(t.kind, t.resolvedAt), oneOf('ops_notifications_severity_chk', t.severity, ['info', 'warning', 'critical'])],
);

/**
 * Provider API deprecation evidence (FG-P2-001): HTTP Deprecation/Sunset headers (RFC 9745 /
 * RFC 8594), provider-specific warnings, version auto-upgrades and registry end-of-life dates.
 */
export const apiDeprecationSignals = pgTable(
  'api_deprecation_signals',
  {
    id: pk(),
    provider: text('provider').notNull(),
    apiVersion: text('api_version').notNull(),
    signal: text('signal').notNull(),
    endpoint: text('endpoint').notNull(),
    sunsetAt: ts('sunset_at'),
    detail: text('detail'),
    occurrences: integer('occurrences').notNull().default(1),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_deprecation_signals_uq').on(t.provider, t.apiVersion, t.signal, t.endpoint), oneOf('api_deprecation_signals_signal_chk', t.signal, ['deprecation_header', 'sunset_header', 'provider_warning', 'version_upgraded', 'registry_eol'])],
);

import { CONSENT_PURPOSES, CONSENT_STATUSES, EVIDENCE_KINDS, EVIDENCE_STATUSES, FRESHNESS_STATUSES, LAWFUL_BASES, PII_CLASSES, SOURCE_TYPES, SUPPRESSION_CHANNELS } from '@futuregrow/contracts';
import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, pgTable, primaryKey, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dbl, json, oneOf, pk, rawCheck, tenantId, textArray, ts, updatedAt, uuidArray } from './_common.js';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/* ------------------------------------------------------------------ */
/* M01 Evidence & Source Registry                                     */
/* ------------------------------------------------------------------ */

export const sources = pgTable(
  'sources',
  {
    id: pk(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    sourceType: text('source_type').notNull(),
    owner: text('owner').notNull(),
    uri: text('uri').notNull(),
    licenseOrUsageRights: text('license_or_usage_rights'),
    termsVersion: text('terms_version'),
    permittedUses: textArray('permitted_uses').notNull().default(sql`'{}'::text[]`),
    prohibitedUses: textArray('prohibited_uses').notNull().default(sql`'{}'::text[]`),
    defaultPiiClass: text('default_pii_class'),
    freshnessSlaHours: dbl('freshness_sla_hours'),
    status: text('status').notNull().default('pending_review'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sources_tenant_uri_uq').on(t.tenantId, t.uri), oneOf('sources_type_chk', t.sourceType, SOURCE_TYPES), oneOf('sources_status_chk', t.status, ['approved', 'pending_review', 'blocked'])],
);

export const evidenceRecords = pgTable(
  'evidence_records',
  {
    id: pk(),
    tenantId: tenantId(),
    sourceId: uuid('source_id').references(() => sources.id),
    sourceType: text('source_type').notNull(),
    sourceOwner: text('source_owner').notNull(),
    sourceUriOrObjectId: text('source_uri_or_object_id').notNull(),
    retrievedAt: ts('retrieved_at').notNull(),
    observedAt: ts('observed_at'),
    geography: text('geography'),
    lawfulBasisOrConsentId: text('lawful_basis_or_consent_id'),
    platformTermsVersion: text('platform_terms_version'),
    licenseOrUsageRights: text('license_or_usage_rights'),
    schemaVersion: text('schema_version').notNull(),
    lineageParentIds: uuidArray('lineage_parent_ids').notNull().default(sql`'{}'::uuid[]`),
    piiClassification: text('pii_classification'),
    freshnessStatus: text('freshness_status').notNull(),
    freshnessSlaHours: dbl('freshness_sla_hours'),
    confidence: dbl('confidence'),
    permittedUses: textArray('permitted_uses').notNull().default(sql`'{}'::text[]`),
    prohibitedUses: textArray('prohibited_uses').notNull().default(sql`'{}'::text[]`),
    kind: text('kind').notNull(),
    summary: text('summary'),
    content: json<unknown>('content'),
    contentObjectKey: text('content_object_key'),
    contentSha256: text('content_sha256').notNull(),
    status: text('status').notNull(),
    quarantineReasons: textArray('quarantine_reasons').notNull().default(sql`'{}'::text[]`),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('evidence_tenant_status_idx').on(t.tenantId, t.status, t.createdAt),
    index('evidence_lineage_gin').using('gin', t.lineageParentIds),
    index('evidence_hash_idx').on(t.tenantId, t.contentSha256),
    oneOf('evidence_source_type_chk', t.sourceType, SOURCE_TYPES),
    oneOf('evidence_status_chk', t.status, EVIDENCE_STATUSES),
    oneOf('evidence_freshness_chk', t.freshnessStatus, FRESHNESS_STATUSES),
    oneOf('evidence_kind_chk', t.kind, EVIDENCE_KINDS),
    rawCheck('evidence_pii_chk', sql`${t.piiClassification} is null or ${t.piiClassification} in (${sql.raw(PII_CLASSES.map((p) => `'${p}'`).join(','))})`),
    rawCheck('evidence_confidence_chk', sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`),
    // AC: unresolved fields cannot silently become trusted.
    rawCheck('evidence_admitted_complete_chk', sql`${t.status} <> 'admitted' or (${t.licenseOrUsageRights} is not null and ${t.piiClassification} is not null and ${t.confidence} is not null)`),
  ],
);

/* ------------------------------------------------------------------ */
/* M02 Data Fabric & Customer 360                                     */
/* ------------------------------------------------------------------ */

export const customerProfiles = pgTable(
  'customer_profiles',
  {
    id: pk(),
    tenantId: tenantId(),
    email: text('email'),
    phone: text('phone'),
    displayName: text('display_name'),
    locale: text('locale'),
    country: text('country'),
    region: text('region'),
    timezone: text('timezone'),
    /** null = unknown. Children's data is routed to a separate policy path (COPPA). */
    isChild: boolean('is_child'),
    traits: json<Record<string, unknown>>('traits').notNull().default({}),
    mergedIntoId: uuid('merged_into_id'),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('customer_profiles_tenant_idx').on(t.tenantId, t.createdAt)],
);

export const identityIdentifiers = pgTable(
  'identity_identifiers',
  {
    id: pk(),
    tenantId: tenantId(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => customerProfiles.id),
    kind: text('kind').notNull(),
    valueHash: text('value_hash').notNull(),
    verified: boolean('verified').notNull().default(false),
    evidenceId: uuid('evidence_id'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('identity_identifiers_uq').on(t.tenantId, t.kind, t.valueHash), index('identity_identifiers_profile_idx').on(t.profileId), oneOf('identity_kind_chk', t.kind, ['email', 'phone', 'user_id', 'device_id', 'anonymous_id', 'shopify_customer_id', 'app_install_id'])],
);

/** Explainable identity merges: every merge records the rule that justified it. */
export const identityMerges = pgTable('identity_merges', {
  id: pk(),
  tenantId: tenantId(),
  survivorProfileId: uuid('survivor_profile_id').notNull(),
  mergedProfileId: uuid('merged_profile_id').notNull(),
  matchRule: text('match_rule').notNull(),
  matchPolicyVersion: text('match_policy_version').notNull(),
  matchedIdentifierKind: text('matched_identifier_kind').notNull(),
  confidence: dbl('confidence').notNull(),
  evidenceId: uuid('evidence_id'),
  createdAt: createdAt(),
});

export const customerEvents = pgTable(
  'customer_events',
  {
    id: pk(),
    tenantId: tenantId(),
    messageId: text('message_id').notNull(),
    profileId: uuid('profile_id'),
    anonymousId: text('anonymous_id'),
    eventName: text('event_name').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    properties: json<Record<string, unknown>>('properties').notNull().default({}),
    context: json<Record<string, unknown>>('context').notNull().default({}),
    source: text('source').notNull(),
    revenueMicros: dbl('revenue_micros'),
    currency: text('currency'),
  },
  (t) => [uniqueIndex('customer_events_message_uq').on(t.tenantId, t.messageId), index('customer_events_profile_idx').on(t.tenantId, t.profileId, t.occurredAt), index('customer_events_name_idx').on(t.tenantId, t.eventName, t.occurredAt)],
);

/** Append-only consent history. */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: pk(),
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    purpose: text('purpose').notNull(),
    status: text('status').notNull(),
    lawfulBasis: text('lawful_basis').notNull(),
    jurisdiction: text('jurisdiction'),
    source: text('source').notNull(),
    evidenceId: uuid('evidence_id'),
    capturedAt: ts('captured_at').notNull(),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [index('consent_events_profile_idx').on(t.tenantId, t.profileId, t.purpose, t.capturedAt), oneOf('consent_events_purpose_chk', t.purpose, CONSENT_PURPOSES), oneOf('consent_events_status_chk', t.status, CONSENT_STATUSES), oneOf('consent_events_basis_chk', t.lawfulBasis, LAWFUL_BASES)],
);

/** Current consent per (profile, purpose), maintained transactionally with consent_events. */
export const consentState = pgTable(
  'consent_state',
  {
    tenantId: tenantId(),
    profileId: uuid('profile_id').notNull(),
    purpose: text('purpose').notNull(),
    status: text('status').notNull(),
    lawfulBasis: text('lawful_basis').notNull(),
    consentEventId: uuid('consent_event_id').notNull(),
    capturedAt: ts('captured_at').notNull(),
    expiresAt: ts('expires_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.profileId, t.purpose] })],
);

/** Suppressions are keyed by identifier hash so opt-outs survive profile deletion. */
export const suppressions = pgTable(
  'suppressions',
  {
    id: pk(),
    tenantId: tenantId(),
    channel: text('channel').notNull(),
    identifierHash: text('identifier_hash').notNull(),
    reason: text('reason').notNull(),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suppressions_uq').on(t.tenantId, t.channel, t.identifierHash), oneOf('suppressions_channel_chk', t.channel, SUPPRESSION_CHANNELS), oneOf('suppressions_reason_chk', t.reason, ['unsubscribe', 'bounce', 'complaint', 'dsar_delete', 'dsar_opt_out', 'manual', 'legal'])],
);

export const dsarRequests = pgTable(
  'dsar_requests',
  {
    id: pk(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    subjectIdentifierHash: text('subject_identifier_hash').notNull(),
    profileIds: uuidArray('profile_ids').notNull().default(sql`'{}'::uuid[]`),
    status: text('status').notNull().default('received'),
    jurisdiction: text('jurisdiction'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    dueAt: ts('due_at'),
    verifiedAt: ts('verified_at'),
    verificationMethod: text('verification_method'),
    completedAt: ts('completed_at'),
    propagation: json<Record<string, unknown>>('propagation').notNull().default({}),
    resultObjectKey: text('result_object_key'),
    handledBy: text('handled_by'),
  },
  (t) => [oneOf('dsar_kind_chk', t.kind, ['access', 'delete', 'correct', 'opt_out_sale_share']), oneOf('dsar_status_chk', t.status, ['received', 'verified', 'processing', 'completed', 'rejected'])],
);

export const retentionPolicies = pgTable(
  'retention_policies',
  {
    tenantId: tenantId(),
    dataClass: text('data_class').notNull(),
    retainDays: integer('retain_days'),
    legalHold: boolean('legal_hold').notNull().default(false),
    updatedBy: text('updated_by').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.dataClass] }), oneOf('retention_class_chk', t.dataClass, ['customer_events', 'conversations', 'evidence_snapshots', 'webhook_payloads', 'messages', 'referral_clicks'])],
);

/* ------------------------------------------------------------------ */
/* M03 Brand & Product Knowledge Graph                                */
/* ------------------------------------------------------------------ */

export const kgEntities = pgTable(
  'kg_entities',
  {
    id: pk(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    attributes: json<Record<string, unknown>>('attributes').notNull().default({}),
    version: integer('version').notNull().default(1),
    status: text('status').notNull().default('active'),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
    evidenceId: uuid('evidence_id').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('kg_entities_key_version_uq').on(t.tenantId, t.kind, t.key, t.version),
    oneOf('kg_entities_kind_chk', t.kind, ['product', 'feature', 'plan', 'price', 'policy', 'faq', 'brand_guide', 'release', 'integration', 'audience']),
    oneOf('kg_entities_status_chk', t.status, ['active', 'expired', 'superseded', 'conflict']),
  ],
);

export const kgRelations = pgTable(
  'kg_relations',
  {
    id: pk(),
    tenantId: tenantId(),
    fromEntityId: uuid('from_entity_id')
      .notNull()
      .references(() => kgEntities.id),
    relation: text('relation').notNull(),
    toEntityId: uuid('to_entity_id')
      .notNull()
      .references(() => kgEntities.id),
    evidenceId: uuid('evidence_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('kg_relations_uq').on(t.tenantId, t.fromEntityId, t.relation, t.toEntityId)],
);

export const claims = pgTable(
  'claims',
  {
    id: pk(),
    tenantId: tenantId(),
    text: text('text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    claimType: text('claim_type').notNull(),
    regulated: boolean('regulated').notNull().default(false),
    status: text('status').notNull().default('pending_review'),
    evidenceIds: uuidArray('evidence_ids').notNull(),
    entityIds: uuidArray('entity_ids').notNull().default(sql`'{}'::uuid[]`),
    jurisdictions: textArray('jurisdictions').notNull().default(sql`'{}'::text[]`),
    approvedBy: text('approved_by'),
    approvedAt: ts('approved_at'),
    expiresAt: ts('expires_at'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('claims_normalized_uq').on(t.tenantId, t.normalizedText),
    oneOf('claims_type_chk', t.claimType, ['product_capability', 'price', 'comparative', 'statistic', 'testimonial', 'health', 'financial', 'environmental', 'availability', 'other']),
    oneOf('claims_status_chk', t.status, ['approved', 'pending_review', 'rejected', 'expired']),
    rawCheck('claims_evidence_chk', sql`cardinality(${t.evidenceIds}) > 0`),
    rawCheck('claims_approved_chk', sql`${t.status} <> 'approved' or ${t.approvedBy} is not null`),
  ],
);

export const brandRules = pgTable(
  'brand_rules',
  {
    id: pk(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    pattern: text('pattern').notNull(),
    severity: text('severity').notNull(),
    description: text('description').notNull(),
    channels: textArray('channels').notNull().default(sql`'{}'::text[]`),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [oneOf('brand_rules_kind_chk', t.kind, ['banned_phrase', 'banned_regex', 'required_phrase', 'max_exclamations', 'tone_note']), oneOf('brand_rules_severity_chk', t.severity, ['block', 'warn'])],
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: pk(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    visibility: text('visibility').notNull(),
    allowedRoles: textArray('allowed_roles').notNull().default(sql`'{}'::text[]`),
    contentSha256: text('content_sha256').notNull(),
    objectKey: text('object_key'),
    chunkCount: integer('chunk_count').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('knowledge_documents_hash_uq').on(t.tenantId, t.contentSha256), oneOf('knowledge_documents_visibility_chk', t.visibility, ['public', 'internal', 'restricted'])],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: pk(),
    tenantId: tenantId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', "text")`),
    embedding: real('embedding').array(),
    embeddingModel: text('embedding_model'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('knowledge_chunks_ord_uq').on(t.documentId, t.ordinal), index('knowledge_chunks_tsv_gin').using('gin', t.tsv)],
);

/** Event-ingestion credentials for M02 (server keys and origin-bound browser keys). */
export const ingestionKeys = pgTable(
  'ingestion_keys',
  {
    id: pk(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    allowedOrigins: textArray('allowed_origins').notNull().default(sql`'{}'::text[]`),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('ingestion_keys_hash_uq').on(t.keyHash), oneOf('ingestion_keys_kind_chk', t.kind, ['server', 'browser']), oneOf('ingestion_keys_status_chk', t.status, ['active', 'revoked']), rawCheck('ingestion_keys_browser_origin_chk', sql`${t.kind} <> 'browser' or cardinality(${t.allowedOrigins}) > 0`)],
);

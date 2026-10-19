import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dbl, json, micros, oneOf, pk, rawCheck, tenantId, textArray, ts, updatedAt, uuidArray } from './_common.js';

/* ------------------------------------------------------------------ */
/* M12 Offer, Pricing & Conversion                                    */
/* ------------------------------------------------------------------ */

export const priceGuardrails = pgTable('price_guardrails', {
  id: pk(),
  tenantId: tenantId(),
  productRef: text('product_ref').notNull(),
  currency: text('currency').notNull(),
  listPriceMicros: micros('list_price_micros').notNull(),
  unitCostMicros: micros('unit_cost_micros').notNull(),
  minPriceMicros: micros('min_price_micros').notNull(),
  maxDiscountFraction: dbl('max_discount_fraction').notNull(),
  minMarginFraction: dbl('min_margin_fraction').notNull(),
  inventoryAvailable: integer('inventory_available'),
  approvedBy: text('approved_by').notNull(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('price_guardrails_product_uq').on(t.tenantId, t.productRef),
  rawCheck('price_guardrails_fraction_chk', sql`${t.maxDiscountFraction} >= 0 and ${t.maxDiscountFraction} < 1 and ${t.minMarginFraction} > -1 and ${t.minMarginFraction} < 1`),
]);

export const offers = pgTable('offers', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  productRefs: textArray('product_refs').notNull(),
  params: json<Record<string, unknown>>('params').notNull(),
  economics: json<Record<string, unknown>>('economics').notNull(),
  guardrailCheck: json<Record<string, unknown>>('guardrail_check').notNull(),
  claimIds: uuidArray('claim_ids').notNull().default(sql`'{}'::uuid[]`),
  scarcityClaim: text('scarcity_claim'),
  scarcityEvidenceId: uuid('scarcity_evidence_id'),
  status: text('status').notNull().default('draft'),
  experimentId: uuid('experiment_id'),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  oneOf('offers_kind_chk', t.kind, ['percent_discount', 'fixed_discount', 'bundle', 'trial_extension', 'free_shipping']),
  oneOf('offers_status_chk', t.status, ['draft', 'guardrail_failed', 'approved', 'testing', 'live', 'retired']),
  // truthful scarcity: a scarcity claim must be backed by evidence
  rawCheck('offers_scarcity_chk', sql`${t.scarcityClaim} is null or ${t.scarcityEvidenceId} is not null`),
]);

export const croHypotheses = pgTable('cro_hypotheses', {
  id: pk(),
  tenantId: tenantId(),
  pageUrl: text('page_url').notNull(),
  hypothesis: text('hypothesis').notNull(),
  changes: json<unknown[]>('changes').notNull(),
  darkPatternCheck: json<Record<string, unknown>>('dark_pattern_check').notNull(),
  evidenceIds: uuidArray('evidence_ids').notNull(),
  experimentId: uuid('experiment_id'),
  status: text('status').notNull().default('draft'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [oneOf('cro_status_chk', t.status, ['draft', 'blocked_dark_pattern', 'queued_for_test', 'testing', 'shipped', 'rejected'])]);

/* ------------------------------------------------------------------ */
/* M13 Creative Intelligence                                          */
/* ------------------------------------------------------------------ */

export const creativeBriefs = pgTable('creative_briefs', {
  id: pk(),
  tenantId: tenantId(),
  title: text('title').notNull(),
  objective: text('objective').notNull(),
  channel: text('channel').notNull(),
  audience: text('audience').notNull(),
  angle: text('angle').notNull(),
  hooks: json<string[]>('hooks').notNull(),
  proofPoints: json<unknown[]>('proof_points').notNull(),
  cta: text('cta').notNull(),
  formatPlan: json<Record<string, unknown>>('format_plan').notNull(),
  prohibitedClaims: textArray('prohibited_claims').notNull().default(sql`'{}'::text[]`),
  experimentMatrix: json<unknown[]>('experiment_matrix').notNull(),
  lint: json<Record<string, unknown>>('lint').notNull(),
  evidenceIds: uuidArray('evidence_ids').notNull(),
  ideaId: uuid('idea_id'),
  agentRunId: uuid('agent_run_id'),
  status: text('status').notNull().default('draft'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [oneOf('creative_briefs_status_chk', t.status, ['draft', 'lint_failed', 'approved', 'archived'])]);

/* ------------------------------------------------------------------ */
/* M14 Asset Studio / M15 Synthetic personas                          */
/* ------------------------------------------------------------------ */

export const assets = pgTable('assets', {
  id: pk(),
  tenantId: tenantId(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  objectKey: text('object_key').notNull(),
  sha256: text('sha256').notNull(),
  mime: text('mime').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  origin: text('origin').notNull(),
  briefId: uuid('brief_id'),
  renderJobId: uuid('render_job_id'),
  personaId: uuid('persona_id'),
  manifest: json<Record<string, unknown>>('manifest').notNull(),
  qa: json<Record<string, unknown>>('qa').notNull().default({}),
  publishEligible: boolean('publish_eligible').notNull().default(false),
  eligibilityReasons: textArray('eligibility_reasons').notNull().default(sql`'{}'::text[]`),
  disclosure: json<Record<string, unknown>>('disclosure').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('assets_sha_uq').on(t.tenantId, t.sha256),
  oneOf('assets_kind_chk', t.kind, ['image', 'video', 'audio', 'font', 'caption']),
  oneOf('assets_origin_chk', t.origin, ['upload', 'render', 'generated']),
]);

/** Rights of each component that went into an asset (source media, music, voice, likeness...). */
export const assetRights = pgTable('asset_rights', {
  id: pk(),
  tenantId: tenantId(),
  assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  component: text('component').notNull(),
  rightsHolder: text('rights_holder').notNull(),
  licenseRef: text('license_ref').notNull(),
  artifactLicenseId: uuid('artifact_license_id'),
  commercialUse: text('commercial_use').notNull(),
  evidenceId: uuid('evidence_id').notNull(),
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
}, (t) => [
  oneOf('asset_rights_component_chk', t.component, ['source_media', 'music', 'voice', 'likeness', 'font', 'model', 'plugin', 'template']),
  oneOf('asset_rights_commercial_chk', t.commercialUse, ['allowed', 'restricted', 'unknown']),
]);

export const renderJobs = pgTable('render_jobs', {
  id: pk(),
  tenantId: tenantId(),
  composition: text('composition').notNull(),
  inputProps: json<Record<string, unknown>>('input_props').notNull(),
  inputAssetIds: uuidArray('input_asset_ids').notNull(),
  briefId: uuid('brief_id'),
  personaId: uuid('persona_id'),
  status: text('status').notNull().default('queued'),
  statusReason: text('status_reason'),
  outputAssetId: uuid('output_asset_id'),
  workflowConfig: json<Record<string, unknown>>('workflow_config').notNull(),
  configSha256: text('config_sha256').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lockedBy: text('locked_by'),
  requestedBy: text('requested_by').notNull(),
  requestedAt: ts('requested_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
}, (t) => [
  index('render_jobs_queue_idx').on(t.status, t.requestedAt),
  oneOf('render_jobs_composition_chk', t.composition, ['product_showcase', 'ugc_captioned', 'persona_story']),
  oneOf('render_jobs_status_chk', t.status, ['queued', 'rendering', 'completed', 'failed', 'blocked_license']),
]);

export const syntheticPersonas = pgTable('synthetic_personas', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  personaBible: json<Record<string, unknown>>('persona_bible').notNull(),
  visualIdentity: json<Record<string, unknown>>('visual_identity').notNull(),
  voiceIdentity: json<Record<string, unknown>>('voice_identity').notNull(),
  disclosureCopy: text('disclosure_copy').notNull(),
  platformDisclosures: json<Record<string, unknown>>('platform_disclosures').notNull(),
  contentRules: json<Record<string, unknown>>('content_rules').notNull(),
  likenessAttestation: json<Record<string, unknown>>('likeness_attestation').notNull(),
  impersonationCheck: json<Record<string, unknown>>('impersonation_check').notNull(),
  childPersona: boolean('child_persona').notNull().default(false),
  status: text('status').notNull().default('draft'),
  approvedBy: text('approved_by'),
  approvedAt: ts('approved_at'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('synthetic_personas_name_uq').on(t.tenantId, t.name),
  oneOf('synthetic_personas_status_chk', t.status, ['draft', 'approved', 'suspended', 'blocked']),
  rawCheck('synthetic_personas_disclosure_chk', sql`length(trim(${t.disclosureCopy})) >= 10`),
  rawCheck('synthetic_personas_approval_chk', sql`${t.status} <> 'approved' or ${t.approvedBy} is not null`),
]);

/** Registry of protected real people (celebrities, executives, staff) for impersonation detection. */
export const protectedIdentities = pgTable('protected_identities', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('protected_identities_uq').on(t.tenantId, t.normalizedName)]);

/* ------------------------------------------------------------------ */
/* M16 Organic Social                                                 */
/* ------------------------------------------------------------------ */

export const socialPosts = pgTable('social_posts', {
  id: pk(),
  tenantId: tenantId(),
  connectionId: uuid('connection_id').notNull(),
  platform: text('platform').notNull(),
  personaId: uuid('persona_id'),
  assetIds: uuidArray('asset_ids').notNull().default(sql`'{}'::uuid[]`),
  caption: text('caption').notNull(),
  link: text('link'),
  claimIds: uuidArray('claim_ids').notNull().default(sql`'{}'::uuid[]`),
  disclosure: json<Record<string, unknown>>('disclosure').notNull(),
  scheduledAt: ts('scheduled_at').notNull(),
  status: text('status').notNull().default('draft'),
  statusReason: text('status_reason'),
  actionId: uuid('action_id'),
  externalPostId: text('external_post_id'),
  externalUrl: text('external_url'),
  verifiedAt: ts('verified_at'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('social_posts_schedule_idx').on(t.tenantId, t.status, t.scheduledAt),
  oneOf('social_posts_platform_chk', t.platform, ['facebook', 'instagram', 'tiktok', 'youtube']),
  oneOf('social_posts_status_chk', t.status, ['draft', 'scheduled', 'submitted', 'published_verified', 'failed', 'cancelled', 'blocked']),
]);

export const socialInteractions = pgTable('social_interactions', {
  id: pk(),
  tenantId: tenantId(),
  connectionId: uuid('connection_id').notNull(),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  parentExternalId: text('parent_external_id'),
  kind: text('kind').notNull(),
  authorHash: text('author_hash').notNull(),
  text: text('text').notNull(),
  receivedAt: ts('received_at').notNull(),
  moderation: json<Record<string, unknown>>('moderation').notNull().default({}),
  replyDraft: text('reply_draft'),
  replyStatus: text('reply_status').notNull().default('none'),
  replyActionId: uuid('reply_action_id'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('social_interactions_ext_uq').on(t.connectionId, t.externalId),
  oneOf('social_interactions_kind_chk', t.kind, ['comment', 'mention', 'message']),
  oneOf('social_interactions_reply_chk', t.replyStatus, ['none', 'drafted', 'submitted', 'sent_verified', 'skipped']),
]);

/* ------------------------------------------------------------------ */
/* M17 Paid media                                                     */
/* ------------------------------------------------------------------ */

export const adCampaigns = pgTable('ad_campaigns', {
  id: pk(),
  tenantId: tenantId(),
  connectionId: uuid('connection_id').notNull(),
  platform: text('platform').notNull(),
  externalCampaignId: text('external_campaign_id').notNull(),
  externalBudgetId: text('external_budget_id'),
  name: text('name').notNull(),
  status: text('status').notNull(),
  dailyBudgetMicros: micros('daily_budget_micros'),
  currency: text('currency'),
  objective: text('objective'),
  raw: json<Record<string, unknown>>('raw').notNull().default({}),
  lastSyncedAt: ts('last_synced_at').notNull(),
}, (t) => [
  uniqueIndex('ad_campaigns_ext_uq').on(t.tenantId, t.connectionId, t.externalCampaignId),
  oneOf('ad_campaigns_platform_chk', t.platform, ['google_ads', 'meta']),
]);

export const adDailyMetrics = pgTable('ad_daily_metrics', {
  tenantId: tenantId(),
  campaignId: uuid('campaign_id').notNull().references(() => adCampaigns.id),
  date: text('date').notNull(),
  impressions: bigint('impressions', { mode: 'number' }).notNull(),
  clicks: bigint('clicks', { mode: 'number' }).notNull(),
  costMicros: micros('cost_micros').notNull(),
  conversions: dbl('conversions').notNull(),
  conversionValueMicros: micros('conversion_value_micros').notNull(),
  evidenceId: uuid('evidence_id'),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.campaignId, t.date] })]);

/* ------------------------------------------------------------------ */
/* M18 SEO / ASO                                                      */
/* ------------------------------------------------------------------ */

export const seoAudits = pgTable('seo_audits', {
  id: pk(),
  tenantId: tenantId(),
  siteUrl: text('site_url').notNull(),
  status: text('status').notNull().default('queued'),
  maxPages: integer('max_pages').notNull(),
  summary: json<Record<string, unknown>>('summary').notNull().default({}),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  requestedBy: text('requested_by').notNull(),
  createdAt: createdAt(),
}, (t) => [oneOf('seo_audits_status_chk', t.status, ['queued', 'running', 'completed', 'failed'])]);

export const seoPages = pgTable('seo_pages', {
  id: pk(),
  tenantId: tenantId(),
  auditId: uuid('audit_id').notNull().references(() => seoAudits.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  statusCode: integer('status_code').notNull(),
  title: text('title'),
  metaDescription: text('meta_description'),
  canonical: text('canonical'),
  robotsMeta: text('robots_meta'),
  h1: textArray('h1').notNull().default(sql`'{}'::text[]`),
  wordCount: integer('word_count').notNull(),
  bytes: integer('bytes').notNull(),
  structuredData: json<unknown[]>('structured_data').notNull(),
  links: json<Record<string, unknown>>('links').notNull(),
  issues: json<unknown[]>('issues').notNull(),
  contentSha256: text('content_sha256').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
}, (t) => [uniqueIndex('seo_pages_audit_url_uq').on(t.auditId, t.url)]);

export const keywordMetrics = pgTable('keyword_metrics', {
  id: pk(),
  tenantId: tenantId(),
  query: text('query').notNull(),
  pageUrl: text('page_url'),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  impressions: integer('impressions').notNull(),
  clicks: integer('clicks').notNull(),
  position: dbl('position'),
  source: text('source').notNull(),
  evidenceId: uuid('evidence_id').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('keyword_metrics_uq').on(t.tenantId, t.query, t.pageUrl, t.periodStart, t.periodEnd, t.source),
  oneOf('keyword_metrics_source_chk', t.source, ['search_console', 'upload']),
]);

export const storeListings = pgTable('store_listings', {
  id: pk(),
  tenantId: tenantId(),
  store: text('store').notNull(),
  appRef: text('app_ref').notNull(),
  locale: text('locale').notNull(),
  fields: json<Record<string, string>>('fields').notNull(),
  validation: json<Record<string, unknown>>('validation').notNull(),
  claimIds: uuidArray('claim_ids').notNull().default(sql`'{}'::uuid[]`),
  status: text('status').notNull().default('draft'),
  experimentId: uuid('experiment_id'),
  actionId: uuid('action_id'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  oneOf('store_listings_store_chk', t.store, ['app_store', 'google_play']),
  oneOf('store_listings_status_chk', t.status, ['draft', 'invalid', 'approved', 'submitted', 'live_verified']),
]);

/* ------------------------------------------------------------------ */
/* M19 App Growth & Attribution                                       */
/* ------------------------------------------------------------------ */

export const appInstalls = pgTable('app_installs', {
  id: pk(),
  tenantId: tenantId(),
  platform: text('platform').notNull(),
  installId: text('install_id').notNull(),
  profileId: uuid('profile_id'),
  installedAt: ts('installed_at').notNull(),
  referrerClickAt: ts('referrer_click_at'),
  referrer: json<Record<string, string>>('referrer').notNull().default({}),
  attributionMethod: text('attribution_method').notNull(),
  campaignRef: text('campaign_ref'),
  sourceRef: text('source_ref'),
  consentAnalytics: boolean('consent_analytics').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('app_installs_uq').on(t.tenantId, t.platform, t.installId),
  oneOf('app_installs_platform_chk', t.platform, ['ios', 'android']),
  oneOf('app_installs_method_chk', t.attributionMethod, ['play_install_referrer', 'app_store_campaign_link', 'self_reported', 'unattributed']),
]);

export const appStoreReports = pgTable('app_store_reports', {
  id: pk(),
  tenantId: tenantId(),
  connectionId: uuid('connection_id').notNull(),
  reportType: text('report_type').notNull(),
  period: text('period').notNull(),
  objectKey: text('object_key').notNull(),
  sha256: text('sha256').notNull(),
  rowCount: integer('row_count').notNull(),
  evidenceId: uuid('evidence_id').notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('app_store_reports_uq').on(t.tenantId, t.connectionId, t.reportType, t.period)]);

/* ------------------------------------------------------------------ */
/* M20 Lifecycle CRM & Messaging                                      */
/* ------------------------------------------------------------------ */

export const messageTemplates = pgTable('message_templates', {
  id: pk(),
  tenantId: tenantId(),
  channel: text('channel').notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  subject: text('subject').notNull(),
  bodyText: text('body_text').notNull(),
  bodyHtml: text('body_html'),
  claimIds: uuidArray('claim_ids').notNull().default(sql`'{}'::uuid[]`),
  lint: json<Record<string, unknown>>('lint').notNull().default({}),
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  approvedBy: text('approved_by'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('message_templates_name_uq').on(t.tenantId, t.name, t.version),
  oneOf('message_templates_channel_chk', t.channel, ['email']),
  oneOf('message_templates_category_chk', t.category, ['transactional', 'commercial']),
  oneOf('message_templates_status_chk', t.status, ['draft', 'approved', 'archived']),
]);

export const journeys = pgTable('journeys', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  triggerEvent: text('trigger_event').notNull(),
  steps: json<unknown[]>('steps').notNull(),
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  approvedBy: text('approved_by'),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [oneOf('journeys_status_chk', t.status, ['draft', 'active', 'paused', 'archived'])]);

export const journeyEnrollments = pgTable('journey_enrollments', {
  id: pk(),
  tenantId: tenantId(),
  journeyId: uuid('journey_id').notNull().references(() => journeys.id),
  profileId: uuid('profile_id').notNull(),
  stepIndex: integer('step_index').notNull().default(0),
  state: text('state').notNull().default('active'),
  nextRunAt: ts('next_run_at').notNull(),
  triggerEventId: uuid('trigger_event_id'),
  exitReason: text('exit_reason'),
  enrolledAt: ts('enrolled_at').notNull().defaultNow(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('journey_enrollments_active_uq').on(t.journeyId, t.profileId).where(sql`${t.state} = 'active'`),
  index('journey_enrollments_due_idx').on(t.state, t.nextRunAt),
  oneOf('journey_enrollments_state_chk', t.state, ['active', 'completed', 'exited']),
]);

export const messages = pgTable('messages', {
  id: pk(),
  tenantId: tenantId(),
  profileId: uuid('profile_id').notNull(),
  channel: text('channel').notNull(),
  templateId: uuid('template_id').notNull(),
  journeyId: uuid('journey_id'),
  enrollmentId: uuid('enrollment_id'),
  category: text('category').notNull(),
  status: text('status').notNull().default('queued'),
  statusReason: text('status_reason'),
  providerMessageId: text('provider_message_id'),
  actionId: uuid('action_id'),
  unsubscribeTokenHash: text('unsubscribe_token_hash'),
  sentAt: ts('sent_at'),
  lastEventAt: ts('last_event_at'),
  createdAt: createdAt(),
}, (t) => [
  index('messages_profile_idx').on(t.tenantId, t.profileId, t.createdAt),
  uniqueIndex('messages_provider_uq').on(t.providerMessageId),
  oneOf('messages_status_chk', t.status, ['queued', 'blocked', 'suppressed', 'submitted', 'sent_unverified', 'delivered', 'bounced', 'complained', 'failed']),
]);

/* ------------------------------------------------------------------ */
/* M21 Conversational Sales & Support                                 */
/* ------------------------------------------------------------------ */

export const chatWidgets = pgTable('chat_widgets', {
  id: pk(),
  tenantId: tenantId(),
  publicKey: text('public_key').notNull(),
  allowedOrigins: textArray('allowed_origins').notNull(),
  disclosureText: text('disclosure_text').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('chat_widgets_key_uq').on(t.publicKey),
  rawCheck('chat_widgets_disclosure_chk', sql`length(trim(${t.disclosureText})) >= 10`),
]);

export const conversations = pgTable('conversations', {
  id: pk(),
  tenantId: tenantId(),
  widgetId: uuid('widget_id'),
  profileId: uuid('profile_id'),
  channel: text('channel').notNull(),
  visitorTokenHash: text('visitor_token_hash'),
  authenticated: boolean('authenticated').notNull().default(false),
  status: text('status').notNull().default('open'),
  assignedUserId: text('assigned_user_id'),
  startedAt: ts('started_at').notNull().defaultNow(),
  lastMessageAt: ts('last_message_at').notNull().defaultNow(),
}, (t) => [
  oneOf('conversations_channel_chk', t.channel, ['web_chat', 'email', 'chatwoot']),
  oneOf('conversations_status_chk', t.status, ['open', 'handoff', 'closed']),
]);

export const conversationMessages = pgTable('conversation_messages', {
  id: pk(),
  tenantId: tenantId(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  role: text('role').notNull(),
  text: text('text').notNull(),
  redactedText: text('redacted_text').notNull(),
  citations: json<unknown[]>('citations').notNull().default([]),
  confidence: dbl('confidence'),
  handoffReason: text('handoff_reason'),
  modelInfo: json<Record<string, unknown> | null>('model_info'),
  createdAt: createdAt(),
}, (t) => [
  index('conversation_messages_conv_idx').on(t.conversationId, t.createdAt),
  oneOf('conversation_messages_role_chk', t.role, ['customer', 'assistant', 'human_agent', 'system']),
]);

export const supportTickets = pgTable('support_tickets', {
  id: pk(),
  tenantId: tenantId(),
  conversationId: uuid('conversation_id'),
  subject: text('subject').notNull(),
  status: text('status').notNull().default('open'),
  priority: text('priority').notNull().default('normal'),
  createdAt: createdAt(),
}, (t) => [oneOf('support_tickets_status_chk', t.status, ['open', 'pending', 'solved'])]);

export const leads = pgTable('leads', {
  id: pk(),
  tenantId: tenantId(),
  conversationId: uuid('conversation_id'),
  profileId: uuid('profile_id'),
  qualification: json<Record<string, unknown>>('qualification').notNull(),
  score: dbl('score'),
  status: text('status').notNull().default('new'),
  createdAt: createdAt(),
}, (t) => [oneOf('leads_status_chk', t.status, ['new', 'qualified', 'disqualified', 'handed_off'])]);

/* ------------------------------------------------------------------ */
/* M22 Creator, Affiliate & Referral                                  */
/* ------------------------------------------------------------------ */

export const creators = pgTable('creators', {
  id: pk(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  handles: json<Record<string, string>>('handles').notNull(),
  contactEmail: text('contact_email'),
  contactConsentEvidenceId: uuid('contact_consent_evidence_id'),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [oneOf('creators_status_chk', t.status, ['active', 'paused', 'terminated'])]);

export const creatorContracts = pgTable('creator_contracts', {
  id: pk(),
  tenantId: tenantId(),
  creatorId: uuid('creator_id').notNull().references(() => creators.id),
  materialRelationship: text('material_relationship').notNull(),
  commissionFraction: dbl('commission_fraction').notNull().default(0),
  flatFeeMicros: micros('flat_fee_micros').notNull().default(0),
  currency: text('currency').notNull(),
  requiredDisclosures: textArray('required_disclosures').notNull(),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at'),
  signedEvidenceId: uuid('signed_evidence_id').notNull(),
  createdAt: createdAt(),
}, (t) => [
  oneOf('creator_contracts_rel_chk', t.materialRelationship, ['paid', 'free_product', 'affiliate_commission', 'employee', 'family_or_friend', 'other']),
  // FTC: material relationship → disclosure required; never empty
  rawCheck('creator_contracts_disclosure_chk', sql`cardinality(${t.requiredDisclosures}) > 0`),
  rawCheck('creator_contracts_commission_chk', sql`${t.commissionFraction} >= 0 and ${t.commissionFraction} <= 1`),
]);

export const referralLinks = pgTable('referral_links', {
  id: pk(),
  tenantId: tenantId(),
  creatorId: uuid('creator_id').notNull().references(() => creators.id),
  contractId: uuid('contract_id').notNull().references(() => creatorContracts.id),
  code: text('code').notNull(),
  destinationUrl: text('destination_url').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('referral_links_code_uq').on(t.code),
  oneOf('referral_links_status_chk', t.status, ['active', 'disabled']),
]);

export const referralClicks = pgTable('referral_clicks', {
  id: pk(),
  tenantId: tenantId(),
  linkId: uuid('link_id').notNull().references(() => referralLinks.id),
  clickedAt: ts('clicked_at').notNull().defaultNow(),
  ipHash: text('ip_hash').notNull(),
  userAgentHash: text('user_agent_hash').notNull(),
}, (t) => [index('referral_clicks_link_idx').on(t.linkId, t.clickedAt)]);

export const referralConversions = pgTable('referral_conversions', {
  id: pk(),
  tenantId: tenantId(),
  linkId: uuid('link_id').notNull().references(() => referralLinks.id),
  orderRef: text('order_ref').notNull(),
  amountMicros: micros('amount_micros').notNull(),
  refundedMicros: micros('refunded_micros').notNull().default(0),
  currency: text('currency').notNull(),
  status: text('status').notNull().default('confirmed'),
  customerHash: text('customer_hash'),
  evidenceId: uuid('evidence_id').notNull(),
  occurredAt: ts('occurred_at').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('referral_conversions_order_uq').on(t.tenantId, t.orderRef),
  oneOf('referral_conversions_status_chk', t.status, ['confirmed', 'partially_refunded', 'refunded']),
]);

export const commissionLedger = pgTable('commission_ledger', {
  id: pk(),
  tenantId: tenantId(),
  creatorId: uuid('creator_id').notNull().references(() => creators.id),
  conversionId: uuid('conversion_id'),
  kind: text('kind').notNull(),
  amountMicros: micros('amount_micros').notNull(),
  currency: text('currency').notNull(),
  ref: text('ref').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('commission_ledger_ref_uq').on(t.tenantId, t.ref),
  oneOf('commission_ledger_kind_chk', t.kind, ['accrual', 'clawback', 'payout', 'adjustment']),
]);

export const creatorSubmissions = pgTable('creator_submissions', {
  id: pk(),
  tenantId: tenantId(),
  creatorId: uuid('creator_id').notNull().references(() => creators.id),
  contractId: uuid('contract_id').notNull().references(() => creatorContracts.id),
  contentUrl: text('content_url'),
  contentText: text('content_text').notNull(),
  disclosureCheck: json<Record<string, unknown>>('disclosure_check').notNull(),
  status: text('status').notNull(),
  reviewedBy: text('reviewed_by'),
  createdAt: createdAt(),
}, (t) => [oneOf('creator_submissions_status_chk', t.status, ['pending_review', 'approved', 'rejected_missing_disclosure', 'rejected'])]);

export const fraudFlags = pgTable('fraud_flags', {
  id: pk(),
  tenantId: tenantId(),
  creatorId: uuid('creator_id'),
  linkId: uuid('link_id'),
  kind: text('kind').notNull(),
  details: json<Record<string, unknown>>('details').notNull(),
  status: text('status').notNull().default('open'),
  createdAt: createdAt(),
}, (t) => [
  oneOf('fraud_flags_kind_chk', t.kind, ['click_velocity', 'self_referral', 'refund_rate', 'duplicate_customer', 'incentivized_review']),
  oneOf('fraud_flags_status_chk', t.status, ['open', 'dismissed', 'confirmed']),
]);

CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "action_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"action_type" text NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"target" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"proposer_model_id" text,
	"proposer_prompt_version" text,
	"decision_id" uuid,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"risk" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"status_reason" text,
	"policy_decision" jsonb,
	"policy_version" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"correlation_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_requests_status_chk" CHECK ("action_requests"."status" in ('PROPOSED', 'EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVAL_REQUIRED', 'APPROVED', 'PREFLIGHT_VERIFIED', 'EXECUTING', 'EXECUTED_UNVERIFIED', 'VERIFIED', 'FAILED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK', 'ESCALATED', 'DENIED', 'REJECTED', 'CANCELLED')),
	CONSTRAINT "action_requests_proposer_chk" CHECK ("action_requests"."proposed_by_type" in ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "action_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"action_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text,
	"actor" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedup_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "alerts_severity_chk" CHECK ("alerts"."severity" in ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"action_id" uuid NOT NULL,
	"action_hash" text NOT NULL,
	"decision" text NOT NULL,
	"approver_user_id" text NOT NULL,
	"approver_roles" text[] NOT NULL,
	"mfa_verified" boolean NOT NULL,
	"comment" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "approvals_decision_chk" CHECK ("approvals"."decision" in ('approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "artifact_licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"exact_name" text NOT NULL,
	"version_or_commit" text NOT NULL,
	"sha256" text NOT NULL,
	"artifact_type" text NOT NULL,
	"copyright_owner" text,
	"license_id_or_custom_terms" text NOT NULL,
	"commercial_use" text NOT NULL,
	"redistribution" text NOT NULL,
	"derivative_use" text NOT NULL,
	"attribution_required" text NOT NULL,
	"geographic_or_use_restrictions" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_data_rights_status" text NOT NULL,
	"approved_for_production" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_licenses_commercial_chk" CHECK ("artifact_licenses"."commercial_use" in ('allowed', 'restricted', 'unknown')),
	CONSTRAINT "artifact_licenses_approval_chk" CHECK (not "artifact_licenses"."approved_for_production" or ("artifact_licenses"."commercial_use" = 'allowed' and "artifact_licenses"."source_data_rights_status" = 'known' and "artifact_licenses"."approved_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "audit_chain_heads" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" text NOT NULL,
	"record_hash" text NOT NULL,
	"occurred_at" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" text,
	CONSTRAINT "audit_actor_type_chk" CHECK ("audit_log"."actor_type" in ('user', 'agent', 'system', 'connector'))
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"action_id" uuid NOT NULL,
	"connection_id" uuid,
	"currency" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "budget_reservations_status_chk" CHECK ("budget_reservations"."status" in ('held', 'committed', 'released')),
	CONSTRAINT "budget_reservations_amount_chk" CHECK ("budget_reservations"."amount_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "connection_secrets" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"access_level" text,
	"app_audited" boolean,
	"api_version" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_provider_chk" CHECK ("connections"."provider" in ('internal', 'meta', 'google_ads', 'tiktok', 'youtube', 'shopify', 'app_store_connect', 'google_play', 'resend', 'posthog', 'chatwoot', 'search_console')),
	CONSTRAINT "connections_status_chk" CHECK ("connections"."status" in ('active', 'reauth_required', 'revoked', 'disabled', 'read_only')),
	CONSTRAINT "connections_health_chk" CHECK ("connections"."health_status" in ('unknown', 'healthy', 'degraded', 'failing'))
);
--> statement-breakpoint
CREATE TABLE "cost_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" double precision NOT NULL,
	"unit_cost_usd" double precision,
	"amount_usd" double precision,
	"ref_type" text,
	"ref_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_ledger_category_chk" CHECK ("cost_ledger"."category" in ('llm', 'embedding', 'media_render', 'api', 'analytics', 'storage'))
);
--> statement-breakpoint
CREATE TABLE "execution_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"action_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"method" text NOT NULL,
	"expected" jsonb NOT NULL,
	"observed" jsonb,
	"diff" jsonb NOT NULL,
	"evidence_sha256" text NOT NULL,
	"evidence_id" uuid,
	"attempt" integer NOT NULL,
	"notes" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_proofs_verdict_chk" CHECK ("execution_proofs"."verdict" in ('VERIFIED', 'MISMATCH', 'PENDING', 'UNVERIFIABLE')),
	CONSTRAINT "execution_proofs_method_chk" CHECK ("execution_proofs"."method" in ('read_after_write', 'status_poll', 'webhook', 'reconciliation', 'database_readback'))
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"action_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text DEFAULT 'in_flight' NOT NULL,
	"provider_request_id" text,
	"provider_object_id" text,
	"receipt" jsonb,
	"receipt_sha256" text,
	"response_archive_key" text,
	"before_state" jsonb,
	"error" jsonb,
	CONSTRAINT "executions_outcome_chk" CHECK ("executions"."outcome" in ('in_flight', 'executed', 'failed', 'ambiguous'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_tenant_id_scope_key_pk" PRIMARY KEY("tenant_id","scope","key"),
	CONSTRAINT "idempotency_status_chk" CHECK ("idempotency_keys"."status" in ('in_progress', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "incidents_severity_chk" CHECK ("incidents"."severity" in ('sev1', 'sev2', 'sev3', 'sev4')),
	CONSTRAINT "incidents_status_chk" CHECK ("incidents"."status" in ('open', 'mitigated', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "jurisdiction_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction" text NOT NULL,
	"domain" text NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"approved_by_legal" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"effective_from" timestamp with time zone,
	"source_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"scope" text NOT NULL,
	"target_ref" text,
	"engaged" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"engaged_by" text NOT NULL,
	"engaged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" text,
	"released_at" timestamp with time zone,
	CONSTRAINT "kill_switches_scope_chk" CHECK ("kill_switches"."scope" in ('tenant', 'connector', 'object', 'model', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"purposes" text[] NOT NULL,
	"license_or_terms" text NOT NULL,
	"commercial_use" text NOT NULL,
	"training_on_customer_data" text NOT NULL,
	"data_retention_terms" text,
	"approved_for_production" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"input_usd_per_mtok" double precision,
	"output_usd_per_mtok" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"eol_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_registry_commercial_chk" CHECK ("model_registry"."commercial_use" in ('allowed', 'restricted', 'unknown')),
	CONSTRAINT "model_registry_training_chk" CHECK ("model_registry"."training_on_customer_data" in ('no', 'yes', 'unknown')),
	CONSTRAINT "model_registry_status_chk" CHECK ("model_registry"."status" in ('active', 'deprecated', 'eol')),
	CONSTRAINT "model_registry_approval_chk" CHECK (not "model_registry"."approved_for_production" or ("model_registry"."commercial_use" = 'allowed' and "model_registry"."approved_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dispatched_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "platform_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"api_version" text NOT NULL,
	"capability" text NOT NULL,
	"supported" boolean NOT NULL,
	"required_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"required_account_type" text,
	"app_review_required" text NOT NULL,
	"rate_limit_policy" jsonb NOT NULL,
	"quota" jsonb NOT NULL,
	"regional_restrictions" text[] DEFAULT '{}'::text[] NOT NULL,
	"terms_checked_at" timestamp with time zone NOT NULL,
	"terms_version" text,
	"connector_version" text NOT NULL,
	"fallback" text NOT NULL,
	"source_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_capabilities_fallback_chk" CHECK ("platform_capabilities"."fallback" in ('queue_for_human', 'disable', 'read_only')),
	CONSTRAINT "platform_capabilities_review_chk" CHECK ("platform_capabilities"."app_review_required" in ('true', 'false', 'unspecified'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"tenant_id" text NOT NULL,
	"bucket_key" text NOT NULL,
	"tokens" double precision NOT NULL,
	"capacity" double precision NOT NULL,
	"refill_per_second" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_tenant_id_bucket_key_pk" PRIMARY KEY("tenant_id","bucket_key")
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"campaign_ref" text NOT NULL,
	"spend_date" text NOT NULL,
	"currency" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"source" text NOT NULL,
	"report_ref" text,
	"evidence_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_ledger_source_chk" CHECK ("spend_ledger"."source" in ('provider_report', 'adjustment'))
);
--> statement-breakpoint
CREATE TABLE "spend_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"currency" text NOT NULL,
	"authorized_micros" bigint NOT NULL,
	"reported_micros" bigint NOT NULL,
	"delta_micros" bigint NOT NULL,
	"status" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_reconciliations_status_chk" CHECK ("spend_reconciliations"."status" in ('ok', 'discrepancy', 'insufficient_data'))
);
--> statement-breakpoint
CREATE TABLE "system_controls" (
	"key" text PRIMARY KEY NOT NULL,
	"engaged" boolean DEFAULT false NOT NULL,
	"reason" text,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"sender_identity" jsonb,
	"remotion_license" jsonb,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"resolved_tenant_id" text,
	"connection_id" uuid,
	"topic" text,
	"signature_valid" boolean NOT NULL,
	"headers" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "webhook_inbox_status_chk" CHECK ("webhook_inbox"."status" in ('received', 'processed', 'failed', 'ignored', 'rejected_signature')),
	CONSTRAINT "webhook_inbox_provider_chk" CHECK ("webhook_inbox"."provider" in ('internal', 'meta', 'google_ads', 'tiktok', 'youtube', 'shopify', 'app_store_connect', 'google_play', 'resend', 'posthog', 'chatwoot', 'search_console'))
);
--> statement-breakpoint
CREATE TABLE "brand_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"pattern" text NOT NULL,
	"severity" text NOT NULL,
	"description" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_rules_kind_chk" CHECK ("brand_rules"."kind" in ('banned_phrase', 'banned_regex', 'required_phrase', 'max_exclamations', 'tone_note')),
	CONSTRAINT "brand_rules_severity_chk" CHECK ("brand_rules"."severity" in ('block', 'warn'))
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"claim_type" text NOT NULL,
	"regulated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"entity_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"jurisdictions" text[] DEFAULT '{}'::text[] NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_type_chk" CHECK ("claims"."claim_type" in ('product_capability', 'price', 'comparative', 'statistic', 'testimonial', 'health', 'financial', 'environmental', 'availability', 'other')),
	CONSTRAINT "claims_status_chk" CHECK ("claims"."status" in ('approved', 'pending_review', 'rejected', 'expired')),
	CONSTRAINT "claims_evidence_chk" CHECK (cardinality("claims"."evidence_ids") > 0),
	CONSTRAINT "claims_approved_chk" CHECK ("claims"."status" <> 'approved' or "claims"."approved_by" is not null)
);
--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"lawful_basis" text NOT NULL,
	"jurisdiction" text,
	"source" text NOT NULL,
	"evidence_id" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_events_purpose_chk" CHECK ("consent_events"."purpose" in ('marketing_email', 'marketing_sms', 'marketing_push', 'analytics', 'personalization', 'ads_customer_match', 'sale_or_share', 'profiling')),
	CONSTRAINT "consent_events_status_chk" CHECK ("consent_events"."status" in ('granted', 'denied', 'withdrawn')),
	CONSTRAINT "consent_events_basis_chk" CHECK ("consent_events"."lawful_basis" in ('consent', 'contract', 'legitimate_interest', 'legal_obligation', 'vital_interest', 'public_task'))
);
--> statement-breakpoint
CREATE TABLE "consent_state" (
	"tenant_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"lawful_basis" text NOT NULL,
	"consent_event_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "consent_state_tenant_id_profile_id_purpose_pk" PRIMARY KEY("tenant_id","profile_id","purpose")
);
--> statement-breakpoint
CREATE TABLE "customer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"message_id" text NOT NULL,
	"profile_id" uuid,
	"anonymous_id" text,
	"event_name" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"revenue_micros" double precision,
	"currency" text
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text,
	"phone" text,
	"display_name" text,
	"locale" text,
	"country" text,
	"region" text,
	"timezone" text,
	"is_child" boolean,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_into_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsar_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_identifier_hash" text NOT NULL,
	"profile_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"jurisdiction" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verification_method" text,
	"completed_at" timestamp with time zone,
	"propagation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_object_key" text,
	"handled_by" text,
	CONSTRAINT "dsar_kind_chk" CHECK ("dsar_requests"."kind" in ('access', 'delete', 'correct', 'opt_out_sale_share')),
	CONSTRAINT "dsar_status_chk" CHECK ("dsar_requests"."status" in ('received', 'verified', 'processing', 'completed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "evidence_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"source_id" uuid,
	"source_type" text NOT NULL,
	"source_owner" text NOT NULL,
	"source_uri_or_object_id" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone,
	"geography" text,
	"lawful_basis_or_consent_id" text,
	"platform_terms_version" text,
	"license_or_usage_rights" text,
	"schema_version" text NOT NULL,
	"lineage_parent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"pii_classification" text,
	"freshness_status" text NOT NULL,
	"freshness_sla_hours" double precision,
	"confidence" double precision,
	"permitted_uses" text[] DEFAULT '{}'::text[] NOT NULL,
	"prohibited_uses" text[] DEFAULT '{}'::text[] NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"content" jsonb,
	"content_object_key" text,
	"content_sha256" text NOT NULL,
	"status" text NOT NULL,
	"quarantine_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_source_type_chk" CHECK ("evidence_records"."source_type" in ('primary', 'research', 'secondary', 'internal')),
	CONSTRAINT "evidence_status_chk" CHECK ("evidence_records"."status" in ('admitted', 'quarantined', 'rejected', 'expired')),
	CONSTRAINT "evidence_freshness_chk" CHECK ("evidence_records"."freshness_status" in ('current', 'stale', 'unknown')),
	CONSTRAINT "evidence_kind_chk" CHECK ("evidence_records"."kind" in ('metric', 'document', 'observation', 'api_response', 'snapshot', 'contract', 'license', 'consent', 'experiment_result', 'model_output')),
	CONSTRAINT "evidence_pii_chk" CHECK ("evidence_records"."pii_classification" is null or "evidence_records"."pii_classification" in ('none','pseudonymous','personal','sensitive','children')),
	CONSTRAINT "evidence_confidence_chk" CHECK ("evidence_records"."confidence" is null or ("evidence_records"."confidence" >= 0 and "evidence_records"."confidence" <= 1)),
	CONSTRAINT "evidence_admitted_complete_chk" CHECK ("evidence_records"."status" <> 'admitted' or ("evidence_records"."license_or_usage_rights" is not null and "evidence_records"."pii_classification" is not null and "evidence_records"."confidence" is not null))
);
--> statement-breakpoint
CREATE TABLE "identity_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_hash" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"evidence_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_kind_chk" CHECK ("identity_identifiers"."kind" in ('email', 'phone', 'user_id', 'device_id', 'anonymous_id', 'shopify_customer_id', 'app_install_id'))
);
--> statement-breakpoint
CREATE TABLE "identity_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"survivor_profile_id" uuid NOT NULL,
	"merged_profile_id" uuid NOT NULL,
	"match_rule" text NOT NULL,
	"match_policy_version" text NOT NULL,
	"matched_identifier_kind" text NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kg_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"evidence_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kg_entities_kind_chk" CHECK ("kg_entities"."kind" in ('product', 'feature', 'plan', 'price', 'policy', 'faq', 'brand_guide', 'release', 'integration', 'audience')),
	CONSTRAINT "kg_entities_status_chk" CHECK ("kg_entities"."status" in ('active', 'expired', 'superseded', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "kg_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
	"embedding" real[],
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"visibility" text NOT NULL,
	"allowed_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_sha256" text NOT NULL,
	"object_key" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_visibility_chk" CHECK ("knowledge_documents"."visibility" in ('public', 'internal', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"tenant_id" text NOT NULL,
	"data_class" text NOT NULL,
	"retain_days" integer,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_tenant_id_data_class_pk" PRIMARY KEY("tenant_id","data_class"),
	CONSTRAINT "retention_class_chk" CHECK ("retention_policies"."data_class" in ('customer_events', 'conversations', 'evidence_snapshots', 'webhook_payloads', 'messages', 'referral_clicks'))
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"owner" text NOT NULL,
	"uri" text NOT NULL,
	"license_or_usage_rights" text,
	"terms_version" text,
	"permitted_uses" text[] DEFAULT '{}'::text[] NOT NULL,
	"prohibited_uses" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_pii_class" text,
	"freshness_sla_hours" double precision,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_type_chk" CHECK ("sources"."source_type" in ('primary', 'research', 'secondary', 'internal')),
	CONSTRAINT "sources_status_chk" CHECK ("sources"."status" in ('approved', 'pending_review', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_channel_chk" CHECK ("suppressions"."channel" in ('email', 'sms', 'push', 'whatsapp', 'ads', 'all')),
	CONSTRAINT "suppressions_reason_chk" CHECK ("suppressions"."reason" in ('unsubscribe', 'bounce', 'complaint', 'dsar_delete', 'dsar_opt_out', 'manual', 'legal'))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"abstain_reason" text,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"triggered_by" text NOT NULL,
	CONSTRAINT "agent_runs_status_chk" CHECK ("agent_runs"."status" in ('running', 'completed', 'abstained', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "analytics_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"error" text,
	"result_ref" uuid,
	"result_summary" jsonb,
	CONSTRAINT "analytics_requests_kind_chk" CHECK ("analytics_requests"."kind" in ('forecast', 'mmm', 'experiment_analysis', 'trend_detection', 'topic_clustering', 'propensity_training', 'anomaly_scan', 'backup_verification')),
	CONSTRAINT "analytics_requests_status_chk" CHECK ("analytics_requests"."status" in ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "bandit_states" (
	"experiment_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"posteriors" jsonb NOT NULL,
	"allocation" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"competitor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_flag" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"confidence" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_observations_kind_chk" CHECK ("competitor_observations"."kind" in ('price_change', 'feature_added', 'feature_removed', 'positioning', 'release', 'creative', 'content_change', 'gap')),
	CONSTRAINT "competitor_observations_flag_chk" CHECK ("competitor_observations"."evidence_flag" in ('P', 'I')),
	CONSTRAINT "competitor_observations_evidence_chk" CHECK (cardinality("competitor_observations"."evidence_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "competitor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"http_status" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"text_excerpt" text NOT NULL,
	"extracted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_id" uuid NOT NULL,
	"diff_from_previous" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"competitor_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" text NOT NULL,
	"lawful_basis_note" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"crawl_interval_hours" integer DEFAULT 24 NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_robots_allowed" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_sources_kind_chk" CHECK ("competitor_sources"."kind" in ('pricing', 'features', 'changelog', 'docs', 'app_listing', 'ad_library', 'press', 'other')),
	CONSTRAINT "competitor_sources_status_chk" CHECK ("competitor_sources"."status" in ('pending', 'approved', 'revoked')),
	CONSTRAINT "competitor_sources_approval_chk" CHECK ("competitor_sources"."status" <> 'approved' or "competitor_sources"."approved_by" is not null)
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"domains" text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocation_snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_exposures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" text NOT NULL,
	"exposed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"experiment_id" uuid NOT NULL,
	"request_id" uuid,
	"per_variant" jsonb NOT NULL,
	"prob_best" jsonb NOT NULL,
	"expected_loss" jsonb NOT NULL,
	"srm" jsonb NOT NULL,
	"guardrails" jsonb NOT NULL,
	"frequentist" jsonb,
	"recommendation" text NOT NULL,
	"recommendation_reason" text NOT NULL,
	"inference_kind" text DEFAULT 'randomized_test' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_results_rec_chk" CHECK ("experiment_results"."recommendation" in ('continue', 'ship_candidate', 'stop_rollback', 'invalid_srm', 'inconclusive', 'guardrail_breach'))
);
--> statement-breakpoint
CREATE TABLE "experiment_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"experiment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_control" boolean DEFAULT false NOT NULL,
	"weight" double precision DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"idea_id" uuid,
	"design" text NOT NULL,
	"unit" text NOT NULL,
	"target_metric" text NOT NULL,
	"metric_type" text NOT NULL,
	"guardrails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_tier" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"assignment_salt" text NOT NULL,
	"planned_sample_per_variant" integer,
	"holdout_fraction" double precision DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiments_design_chk" CHECK ("experiments"."design" in ('ab_fixed', 'bandit_thompson')),
	CONSTRAINT "experiments_unit_chk" CHECK ("experiments"."unit" in ('profile', 'anonymous_id', 'session', 'geo')),
	CONSTRAINT "experiments_metric_type_chk" CHECK ("experiments"."metric_type" in ('binary', 'continuous')),
	CONSTRAINT "experiments_risk_chk" CHECK ("experiments"."risk_tier" in ('low', 'medium', 'high')),
	CONSTRAINT "experiments_status_chk" CHECK ("experiments"."status" in ('draft', 'approved', 'running', 'stopped', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "forecast_points" (
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"mean" double precision NOT NULL,
	"q025" double precision NOT NULL,
	"q10" double precision NOT NULL,
	"q50" double precision NOT NULL,
	"q90" double precision NOT NULL,
	"q975" double precision NOT NULL,
	CONSTRAINT "forecast_points_run_id_ts_pk" PRIMARY KEY("run_id","ts")
);
--> statement-breakpoint
CREATE TABLE "forecast_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"horizon" integer NOT NULL,
	"status" text NOT NULL,
	"champion_model" text NOT NULL,
	"baseline_model" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"gate" jsonb NOT NULL,
	"selection_reason" text NOT NULL,
	"calibration" jsonb NOT NULL,
	"drift" jsonb NOT NULL,
	"dataset_sha256" text NOT NULL,
	"config" jsonb NOT NULL,
	"seed" integer NOT NULL,
	"code_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_runs_status_chk" CHECK ("forecast_runs"."status" in ('champion_selected', 'fallback_baseline', 'abstained'))
);
--> statement-breakpoint
CREATE TABLE "growth_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"objective" text NOT NULL,
	"market" text NOT NULL,
	"horizon" jsonb NOT NULL,
	"proposed_action" jsonb,
	"evidence_ids" uuid[] NOT NULL,
	"predicted_outcomes" jsonb NOT NULL,
	"estimated_incremental_effect" jsonb NOT NULL,
	"expected_cost" jsonb NOT NULL,
	"downside_risk" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"counterfactual_baseline" jsonb,
	"policy_result" jsonb NOT NULL,
	"approval_requirement" jsonb NOT NULL,
	"model_versions" jsonb NOT NULL,
	"utility" jsonb NOT NULL,
	"narrative" text,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"idea_id" uuid,
	"agent_run_id" uuid,
	"action_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_decisions_status_chk" CHECK ("growth_decisions"."status" in ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
	CONSTRAINT "growth_decisions_evidence_chk" CHECK (cardinality("growth_decisions"."evidence_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "growth_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"hypothesis" text NOT NULL,
	"mechanism" text NOT NULL,
	"audience" text NOT NULL,
	"target_metric" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"impact_model" jsonb NOT NULL,
	"cost_model" jsonb NOT NULL,
	"risk_model" jsonb NOT NULL,
	"success_prior" jsonb NOT NULL,
	"value_summary" jsonb NOT NULL,
	"evidence_strength" double precision NOT NULL,
	"test_design" jsonb NOT NULL,
	"kill_criteria" jsonb NOT NULL,
	"novelty_score" double precision NOT NULL,
	"duplicate_of_id" uuid,
	"screening" jsonb NOT NULL,
	"route" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"source" text NOT NULL,
	"agent_run_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_ideas_status_chk" CHECK ("growth_ideas"."status" in ('candidate', 'rejected', 'queued_for_test', 'testing', 'validated', 'invalidated', 'duplicate')),
	CONSTRAINT "growth_ideas_route_chk" CHECK ("growth_ideas"."route" in ('discovery_test', 'full_test', 'reject')),
	CONSTRAINT "growth_ideas_source_chk" CHECK ("growth_ideas"."source" in ('agent', 'human')),
	CONSTRAINT "growth_ideas_evidence_chk" CHECK (cardinality("growth_ideas"."evidence_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "metric_points" (
	"tenant_id" text NOT NULL,
	"series_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"value" double precision NOT NULL,
	"evidence_id" uuid,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_points_series_id_ts_pk" PRIMARY KEY("series_id","ts")
);
--> statement-breakpoint
CREATE TABLE "metric_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"granularity" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text,
	"geography" text,
	"source_evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_series_granularity_chk" CHECK ("metric_series"."granularity" in ('hour', 'day', 'week', 'month')),
	CONSTRAINT "metric_series_kind_chk" CHECK ("metric_series"."kind" in ('kpi', 'spend', 'exposure', 'signal', 'control'))
);
--> statement-breakpoint
CREATE TABLE "mmm_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"kpi_series_id" uuid NOT NULL,
	"channel_series_ids" uuid[] NOT NULL,
	"control_series_ids" uuid[] NOT NULL,
	"priors" jsonb NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"converged" boolean NOT NULL,
	"causal_language_allowed" boolean NOT NULL,
	"posterior_summary" jsonb NOT NULL,
	"response_curves" jsonb NOT NULL,
	"budget_scenarios" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"dataset_sha256" text NOT NULL,
	"seed" integer NOT NULL,
	"code_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mmm_causal_requires_convergence_chk" CHECK (not "mmm_runs"."causal_language_allowed" or "mmm_runs"."converged")
);
--> statement-breakpoint
CREATE TABLE "propensity_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"target" text NOT NULL,
	"features" text[] NOT NULL,
	"coefficients" jsonb NOT NULL,
	"standardization" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"feature_policy" jsonb NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"dataset_sha256" text NOT NULL,
	"code_version" text NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "propensity_models_status_chk" CHECK ("propensity_models"."status" in ('candidate', 'champion', 'retired', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "propensity_scores" (
	"tenant_id" text NOT NULL,
	"model_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"score" double precision NOT NULL,
	"interval_low" double precision NOT NULL,
	"interval_high" double precision NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "propensity_scores_model_id_profile_id_pk" PRIMARY KEY("model_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "rea_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"target_description" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"authorization" jsonb NOT NULL,
	"legal_approved" boolean NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rea_jobs_status_chk" CHECK ("rea_jobs"."status" in ('registered', 'blocked_no_sandbox', 'rejected')),
	CONSTRAINT "rea_jobs_legal_chk" CHECK ("rea_jobs"."legal_approved" = true)
);
--> statement-breakpoint
CREATE TABLE "segment_members" (
	"tenant_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	CONSTRAINT "segment_members_snapshot_id_profile_id_pk" PRIMARY KEY("snapshot_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "segment_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"segment_id" uuid NOT NULL,
	"definition_sha256" text NOT NULL,
	"size" integer NOT NULL,
	"excluded_by_suppression" integer NOT NULL,
	"excluded_by_consent" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"definition" jsonb NOT NULL,
	"definition_sha256" text NOT NULL,
	"purpose" text NOT NULL,
	"uses_sensitive_attributes" boolean NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_status_chk" CHECK ("segments"."status" in ('active', 'archived', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "topic_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid,
	"label" text NOT NULL,
	"terms" text[] NOT NULL,
	"size" integer NOT NULL,
	"sample_refs" jsonb NOT NULL,
	"corpus" text NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" uuid,
	"series_id" uuid,
	"topic" text NOT NULL,
	"geography" text,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"baseline" jsonb NOT NULL,
	"direction" text NOT NULL,
	"sen_slope" double precision,
	"mann_kendall_z" double precision,
	"mann_kendall_p" double precision,
	"velocity" double precision,
	"change_points" jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"freshness_status" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"inference_kind" text DEFAULT 'correlation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trends_direction_chk" CHECK ("trends"."direction" in ('rising', 'falling', 'flat', 'shift_up', 'shift_down')),
	CONSTRAINT "trends_inference_chk" CHECK ("trends"."inference_kind" in ('correlation'))
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_campaign_id" text NOT NULL,
	"external_budget_id" text,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"daily_budget_micros" bigint,
	"currency" text,
	"objective" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ad_campaigns_platform_chk" CHECK ("ad_campaigns"."platform" in ('google_ads', 'meta'))
);
--> statement-breakpoint
CREATE TABLE "ad_daily_metrics" (
	"tenant_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"date" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost_micros" bigint NOT NULL,
	"conversions" double precision NOT NULL,
	"conversion_value_micros" bigint NOT NULL,
	"evidence_id" uuid,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_daily_metrics_campaign_id_date_pk" PRIMARY KEY("campaign_id","date")
);
--> statement-breakpoint
CREATE TABLE "app_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"platform" text NOT NULL,
	"install_id" text NOT NULL,
	"profile_id" uuid,
	"installed_at" timestamp with time zone NOT NULL,
	"referrer_click_at" timestamp with time zone,
	"referrer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attribution_method" text NOT NULL,
	"campaign_ref" text,
	"source_ref" text,
	"consent_analytics" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_installs_platform_chk" CHECK ("app_installs"."platform" in ('ios', 'android')),
	CONSTRAINT "app_installs_method_chk" CHECK ("app_installs"."attribution_method" in ('play_install_referrer', 'app_store_campaign_link', 'self_reported', 'unattributed'))
);
--> statement-breakpoint
CREATE TABLE "app_store_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"report_type" text NOT NULL,
	"period" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"evidence_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_rights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"component" text NOT NULL,
	"rights_holder" text NOT NULL,
	"license_ref" text NOT NULL,
	"artifact_license_id" uuid,
	"commercial_use" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_rights_component_chk" CHECK ("asset_rights"."component" in ('source_media', 'music', 'voice', 'likeness', 'font', 'model', 'plugin', 'template')),
	CONSTRAINT "asset_rights_commercial_chk" CHECK ("asset_rights"."commercial_use" in ('allowed', 'restricted', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"origin" text NOT NULL,
	"brief_id" uuid,
	"render_job_id" uuid,
	"persona_id" uuid,
	"manifest" jsonb NOT NULL,
	"qa" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publish_eligible" boolean DEFAULT false NOT NULL,
	"eligibility_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"disclosure" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_kind_chk" CHECK ("assets"."kind" in ('image', 'video', 'audio', 'font', 'caption')),
	CONSTRAINT "assets_origin_chk" CHECK ("assets"."origin" in ('upload', 'render', 'generated'))
);
--> statement-breakpoint
CREATE TABLE "chat_widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"public_key" text NOT NULL,
	"allowed_origins" text[] NOT NULL,
	"disclosure_text" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_widgets_disclosure_chk" CHECK (length(trim("chat_widgets"."disclosure_text")) >= 10)
);
--> statement-breakpoint
CREATE TABLE "commission_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"conversion_id" uuid,
	"kind" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"currency" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_ledger_kind_chk" CHECK ("commission_ledger"."kind" in ('accrual', 'clawback', 'payout', 'adjustment'))
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"redacted_text" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision,
	"handoff_reason" text,
	"model_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_role_chk" CHECK ("conversation_messages"."role" in ('customer', 'assistant', 'human_agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"widget_id" uuid,
	"profile_id" uuid,
	"channel" text NOT NULL,
	"visitor_token_hash" text,
	"authenticated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_channel_chk" CHECK ("conversations"."channel" in ('web_chat', 'email', 'chatwoot')),
	CONSTRAINT "conversations_status_chk" CHECK ("conversations"."status" in ('open', 'handoff', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "creative_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"channel" text NOT NULL,
	"audience" text NOT NULL,
	"angle" text NOT NULL,
	"hooks" jsonb NOT NULL,
	"proof_points" jsonb NOT NULL,
	"cta" text NOT NULL,
	"format_plan" jsonb NOT NULL,
	"prohibited_claims" text[] DEFAULT '{}'::text[] NOT NULL,
	"experiment_matrix" jsonb NOT NULL,
	"lint" jsonb NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"idea_id" uuid,
	"agent_run_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_briefs_status_chk" CHECK ("creative_briefs"."status" in ('draft', 'lint_failed', 'approved', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "creator_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"material_relationship" text NOT NULL,
	"commission_fraction" double precision DEFAULT 0 NOT NULL,
	"flat_fee_micros" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"required_disclosures" text[] NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"signed_evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_contracts_rel_chk" CHECK ("creator_contracts"."material_relationship" in ('paid', 'free_product', 'affiliate_commission', 'employee', 'family_or_friend', 'other')),
	CONSTRAINT "creator_contracts_disclosure_chk" CHECK (cardinality("creator_contracts"."required_disclosures") > 0),
	CONSTRAINT "creator_contracts_commission_chk" CHECK ("creator_contracts"."commission_fraction" >= 0 and "creator_contracts"."commission_fraction" <= 1)
);
--> statement-breakpoint
CREATE TABLE "creator_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"content_url" text,
	"content_text" text NOT NULL,
	"disclosure_check" jsonb NOT NULL,
	"status" text NOT NULL,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_submissions_status_chk" CHECK ("creator_submissions"."status" in ('pending_review', 'approved', 'rejected_missing_disclosure', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"handles" jsonb NOT NULL,
	"contact_email" text,
	"contact_consent_evidence_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creators_status_chk" CHECK ("creators"."status" in ('active', 'paused', 'terminated'))
);
--> statement-breakpoint
CREATE TABLE "cro_hypotheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"page_url" text NOT NULL,
	"hypothesis" text NOT NULL,
	"changes" jsonb NOT NULL,
	"dark_pattern_check" jsonb NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"experiment_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cro_status_chk" CHECK ("cro_hypotheses"."status" in ('draft', 'blocked_dark_pattern', 'queued_for_test', 'testing', 'shipped', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "fraud_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_id" uuid,
	"link_id" uuid,
	"kind" text NOT NULL,
	"details" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fraud_flags_kind_chk" CHECK ("fraud_flags"."kind" in ('click_velocity', 'self_referral', 'refund_rate', 'duplicate_customer', 'incentivized_review')),
	CONSTRAINT "fraud_flags_status_chk" CHECK ("fraud_flags"."status" in ('open', 'dismissed', 'confirmed'))
);
--> statement-breakpoint
CREATE TABLE "journey_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"journey_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"trigger_event_id" uuid,
	"exit_reason" text,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_enrollments_state_chk" CHECK ("journey_enrollments"."state" in ('active', 'completed', 'exited'))
);
--> statement-breakpoint
CREATE TABLE "journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger_event" text NOT NULL,
	"steps" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journeys_status_chk" CHECK ("journeys"."status" in ('draft', 'active', 'paused', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "keyword_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"query" text NOT NULL,
	"page_url" text,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"impressions" integer NOT NULL,
	"clicks" integer NOT NULL,
	"position" double precision,
	"source" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_metrics_source_chk" CHECK ("keyword_metrics"."source" in ('search_console', 'upload'))
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" uuid,
	"profile_id" uuid,
	"qualification" jsonb NOT NULL,
	"score" double precision,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_status_chk" CHECK ("leads"."status" in ('new', 'qualified', 'disqualified', 'handed_off'))
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"lint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_channel_chk" CHECK ("message_templates"."channel" in ('email')),
	CONSTRAINT "message_templates_category_chk" CHECK ("message_templates"."category" in ('transactional', 'commercial')),
	CONSTRAINT "message_templates_status_chk" CHECK ("message_templates"."status" in ('draft', 'approved', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"template_id" uuid NOT NULL,
	"journey_id" uuid,
	"enrollment_id" uuid,
	"category" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"provider_message_id" text,
	"action_id" uuid,
	"unsubscribe_token_hash" text,
	"sent_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_status_chk" CHECK ("messages"."status" in ('queued', 'blocked', 'suppressed', 'submitted', 'sent_unverified', 'delivered', 'bounced', 'complained', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"product_refs" text[] NOT NULL,
	"params" jsonb NOT NULL,
	"economics" jsonb NOT NULL,
	"guardrail_check" jsonb NOT NULL,
	"claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"scarcity_claim" text,
	"scarcity_evidence_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"experiment_id" uuid,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_kind_chk" CHECK ("offers"."kind" in ('percent_discount', 'fixed_discount', 'bundle', 'trial_extension', 'free_shipping')),
	CONSTRAINT "offers_status_chk" CHECK ("offers"."status" in ('draft', 'guardrail_failed', 'approved', 'testing', 'live', 'retired')),
	CONSTRAINT "offers_scarcity_chk" CHECK ("offers"."scarcity_claim" is null or "offers"."scarcity_evidence_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "price_guardrails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_ref" text NOT NULL,
	"currency" text NOT NULL,
	"list_price_micros" bigint NOT NULL,
	"unit_cost_micros" bigint NOT NULL,
	"min_price_micros" bigint NOT NULL,
	"max_discount_fraction" double precision NOT NULL,
	"min_margin_fraction" double precision NOT NULL,
	"inventory_available" integer,
	"approved_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_guardrails_fraction_chk" CHECK ("price_guardrails"."max_discount_fraction" >= 0 and "price_guardrails"."max_discount_fraction" < 1 and "price_guardrails"."min_margin_fraction" > -1 and "price_guardrails"."min_margin_fraction" < 1)
);
--> statement-breakpoint
CREATE TABLE "protected_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"link_id" uuid NOT NULL,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text NOT NULL,
	"user_agent_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"link_id" uuid NOT NULL,
	"order_ref" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"refunded_micros" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"customer_hash" text,
	"evidence_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_conversions_status_chk" CHECK ("referral_conversions"."status" in ('confirmed', 'partially_refunded', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "referral_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"code" text NOT NULL,
	"destination_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_links_status_chk" CHECK ("referral_links"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"composition" text NOT NULL,
	"input_props" jsonb NOT NULL,
	"input_asset_ids" uuid[] NOT NULL,
	"brief_id" uuid,
	"persona_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"output_asset_id" uuid,
	"workflow_config" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "render_jobs_composition_chk" CHECK ("render_jobs"."composition" in ('product_showcase', 'ugc_captioned', 'persona_story')),
	CONSTRAINT "render_jobs_status_chk" CHECK ("render_jobs"."status" in ('queued', 'rendering', 'completed', 'failed', 'blocked_license'))
);
--> statement-breakpoint
CREATE TABLE "seo_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"site_url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"max_pages" integer NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seo_audits_status_chk" CHECK ("seo_audits"."status" in ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "seo_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"audit_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status_code" integer NOT NULL,
	"title" text,
	"meta_description" text,
	"canonical" text,
	"robots_meta" text,
	"h1" text[] DEFAULT '{}'::text[] NOT NULL,
	"word_count" integer NOT NULL,
	"bytes" integer NOT NULL,
	"structured_data" jsonb NOT NULL,
	"links" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"kind" text NOT NULL,
	"author_hash" text NOT NULL,
	"text" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"moderation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reply_draft" text,
	"reply_status" text DEFAULT 'none' NOT NULL,
	"reply_action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_interactions_kind_chk" CHECK ("social_interactions"."kind" in ('comment', 'mention', 'message')),
	CONSTRAINT "social_interactions_reply_chk" CHECK ("social_interactions"."reply_status" in ('none', 'drafted', 'submitted', 'sent_verified', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"persona_id" uuid,
	"asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"caption" text NOT NULL,
	"link" text,
	"claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"disclosure" jsonb NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"action_id" uuid,
	"external_post_id" text,
	"external_url" text,
	"verified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_posts_platform_chk" CHECK ("social_posts"."platform" in ('facebook', 'instagram', 'tiktok', 'youtube')),
	CONSTRAINT "social_posts_status_chk" CHECK ("social_posts"."status" in ('draft', 'scheduled', 'submitted', 'published_verified', 'failed', 'cancelled', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "store_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"store" text NOT NULL,
	"app_ref" text NOT NULL,
	"locale" text NOT NULL,
	"fields" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"experiment_id" uuid,
	"action_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_listings_store_chk" CHECK ("store_listings"."store" in ('app_store', 'google_play')),
	CONSTRAINT "store_listings_status_chk" CHECK ("store_listings"."status" in ('draft', 'invalid', 'approved', 'submitted', 'live_verified'))
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" uuid,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_status_chk" CHECK ("support_tickets"."status" in ('open', 'pending', 'solved'))
);
--> statement-breakpoint
CREATE TABLE "synthetic_personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"persona_bible" jsonb NOT NULL,
	"visual_identity" jsonb NOT NULL,
	"voice_identity" jsonb NOT NULL,
	"disclosure_copy" text NOT NULL,
	"platform_disclosures" jsonb NOT NULL,
	"content_rules" jsonb NOT NULL,
	"likeness_attestation" jsonb NOT NULL,
	"impersonation_check" jsonb NOT NULL,
	"child_persona" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthetic_personas_status_chk" CHECK ("synthetic_personas"."status" in ('draft', 'approved', 'suspended', 'blocked')),
	CONSTRAINT "synthetic_personas_disclosure_chk" CHECK (length(trim("synthetic_personas"."disclosure_copy")) >= 10),
	CONSTRAINT "synthetic_personas_approval_chk" CHECK ("synthetic_personas"."status" <> 'approved' or "synthetic_personas"."approved_by" is not null)
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_auth_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_requests" ADD CONSTRAINT "action_requests_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_transitions" ADD CONSTRAINT "action_transitions_action_id_action_requests_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_action_requests_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_action_id_action_requests_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_proofs" ADD CONSTRAINT "execution_proofs_action_id_action_requests_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_proofs" ADD CONSTRAINT "execution_proofs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_action_id_action_requests_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_identifiers" ADD CONSTRAINT "identity_identifiers_profile_id_customer_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_from_entity_id_kg_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."kg_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_relations" ADD CONSTRAINT "kg_relations_to_entity_id_kg_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."kg_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bandit_states" ADD CONSTRAINT "bandit_states_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_observations" ADD CONSTRAINT "competitor_observations_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_snapshots" ADD CONSTRAINT "competitor_snapshots_source_id_competitor_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."competitor_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_sources" ADD CONSTRAINT "competitor_sources_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_variant_id_experiment_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."experiment_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_exposures" ADD CONSTRAINT "experiment_exposures_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_exposures" ADD CONSTRAINT "experiment_exposures_variant_id_experiment_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."experiment_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_outcomes" ADD CONSTRAINT "experiment_outcomes_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_outcomes" ADD CONSTRAINT "experiment_outcomes_variant_id_experiment_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."experiment_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_results" ADD CONSTRAINT "experiment_results_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD CONSTRAINT "experiment_variants_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_points" ADD CONSTRAINT "forecast_points_run_id_forecast_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."forecast_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_series_id_metric_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."metric_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_points" ADD CONSTRAINT "metric_points_series_id_metric_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."metric_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "propensity_scores" ADD CONSTRAINT "propensity_scores_model_id_propensity_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."propensity_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_members" ADD CONSTRAINT "segment_members_snapshot_id_segment_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."segment_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_snapshots" ADD CONSTRAINT "segment_snapshots_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trends" ADD CONSTRAINT "trends_series_id_metric_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."metric_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_daily_metrics" ADD CONSTRAINT "ad_daily_metrics_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_rights" ADD CONSTRAINT "asset_rights_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_contracts" ADD CONSTRAINT "creator_contracts_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_submissions" ADD CONSTRAINT "creator_submissions_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_submissions" ADD CONSTRAINT "creator_submissions_contract_id_creator_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."creator_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_enrollments" ADD CONSTRAINT "journey_enrollments_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_clicks" ADD CONSTRAINT "referral_clicks_link_id_referral_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."referral_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_conversions" ADD CONSTRAINT "referral_conversions_link_id_referral_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."referral_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_links" ADD CONSTRAINT "referral_links_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_links" ADD CONSTRAINT "referral_links_contract_id_creator_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."creator_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_pages" ADD CONSTRAINT "seo_pages_audit_id_seo_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."seo_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_uq" ON "auth_session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_email_uq" ON "auth_user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "invitation_org_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_org_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_user_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_uq" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uq" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE UNIQUE INDEX "action_requests_idem_uq" ON "action_requests" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "action_requests_status_idx" ON "action_requests" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "action_transitions_action_idx" ON "action_transitions" USING btree ("action_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedup_uq" ON "alerts" USING btree ("tenant_id","dedup_key") WHERE "alerts"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "approvals_action_idx" ON "approvals" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_licenses_uq" ON "artifact_licenses" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_tenant_seq_uq" ON "audit_log" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_action_uq" ON "budget_reservations" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_provider_account_uq" ON "connections" USING btree ("tenant_id","provider","external_account_id");--> statement-breakpoint
CREATE INDEX "connections_provider_account_idx" ON "connections" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_tenant_time_idx" ON "cost_ledger" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "execution_proofs_action_idx" ON "execution_proofs" USING btree ("action_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "executions_action_attempt_uq" ON "executions" USING btree ("action_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "jurisdiction_rules_uq" ON "jurisdiction_rules" USING btree ("jurisdiction","domain","version");--> statement-breakpoint
CREATE INDEX "kill_switches_active_idx" ON "kill_switches" USING btree ("tenant_id","engaged","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "model_registry_uq" ON "model_registry" USING btree ("provider","model_id");--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox_events" USING btree ("occurred_at") WHERE "outbox_events"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_tenant_type_idx" ON "outbox_events" USING btree ("tenant_id","event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_capabilities_uq" ON "platform_capabilities" USING btree ("platform","capability","api_version");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_ledger_report_uq" ON "spend_ledger" USING btree ("tenant_id","connection_id","campaign_ref","spend_date","source");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_dedup_uq" ON "webhook_inbox" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_normalized_uq" ON "claims" USING btree ("tenant_id","normalized_text");--> statement-breakpoint
CREATE INDEX "consent_events_profile_idx" ON "consent_events" USING btree ("tenant_id","profile_id","purpose","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_events_message_uq" ON "customer_events" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE INDEX "customer_events_profile_idx" ON "customer_events" USING btree ("tenant_id","profile_id","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_events_name_idx" ON "customer_events" USING btree ("tenant_id","event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "customer_profiles_tenant_idx" ON "customer_profiles" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_tenant_status_idx" ON "evidence_records" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "evidence_lineage_gin" ON "evidence_records" USING gin ("lineage_parent_ids");--> statement-breakpoint
CREATE INDEX "evidence_hash_idx" ON "evidence_records" USING btree ("tenant_id","content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_identifiers_uq" ON "identity_identifiers" USING btree ("tenant_id","kind","value_hash");--> statement-breakpoint
CREATE INDEX "identity_identifiers_profile_idx" ON "identity_identifiers" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kg_entities_key_version_uq" ON "kg_entities" USING btree ("tenant_id","kind","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "kg_relations_uq" ON "kg_relations" USING btree ("tenant_id","from_entity_id","relation","to_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_ord_uq" ON "knowledge_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv_gin" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_hash_uq" ON "knowledge_documents" USING btree ("tenant_id","content_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_tenant_uri_uq" ON "sources" USING btree ("tenant_id","uri");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_uq" ON "suppressions" USING btree ("tenant_id","channel","identifier_hash");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_idx" ON "agent_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "analytics_requests_queue_idx" ON "analytics_requests" USING btree ("status","priority","requested_at");--> statement-breakpoint
CREATE INDEX "competitor_snapshots_source_idx" ON "competitor_snapshots" USING btree ("source_id","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_sources_url_uq" ON "competitor_sources" USING btree ("tenant_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_name_uq" ON "competitors" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_assignments_unit_uq" ON "experiment_assignments" USING btree ("experiment_id","unit_id");--> statement-breakpoint
CREATE INDEX "experiment_exposures_unit_idx" ON "experiment_exposures" USING btree ("experiment_id","unit_id","exposed_at");--> statement-breakpoint
CREATE INDEX "experiment_outcomes_exp_idx" ON "experiment_outcomes" USING btree ("experiment_id","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_variants_key_uq" ON "experiment_variants" USING btree ("experiment_id","key");--> statement-breakpoint
CREATE INDEX "forecast_runs_series_idx" ON "forecast_runs" USING btree ("tenant_id","series_id","created_at");--> statement-breakpoint
CREATE INDEX "growth_decisions_tenant_idx" ON "growth_decisions" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "growth_ideas_tenant_idx" ON "growth_ideas" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_series_key_uq" ON "metric_series" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "segments_name_version_uq" ON "segments" USING btree ("tenant_id","name","version");--> statement-breakpoint
CREATE INDEX "trends_tenant_idx" ON "trends" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaigns_ext_uq" ON "ad_campaigns" USING btree ("tenant_id","connection_id","external_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_installs_uq" ON "app_installs" USING btree ("tenant_id","platform","install_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_store_reports_uq" ON "app_store_reports" USING btree ("tenant_id","connection_id","report_type","period");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_sha_uq" ON "assets" USING btree ("tenant_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_widgets_key_uq" ON "chat_widgets" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_ledger_ref_uq" ON "commission_ledger" USING btree ("tenant_id","ref");--> statement-breakpoint
CREATE INDEX "conversation_messages_conv_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_enrollments_active_uq" ON "journey_enrollments" USING btree ("journey_id","profile_id") WHERE "journey_enrollments"."state" = 'active';--> statement-breakpoint
CREATE INDEX "journey_enrollments_due_idx" ON "journey_enrollments" USING btree ("state","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_metrics_uq" ON "keyword_metrics" USING btree ("tenant_id","query","page_url","period_start","period_end","source");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_name_uq" ON "message_templates" USING btree ("tenant_id","name","version");--> statement-breakpoint
CREATE INDEX "messages_profile_idx" ON "messages" USING btree ("tenant_id","profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_uq" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_guardrails_product_uq" ON "price_guardrails" USING btree ("tenant_id","product_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "protected_identities_uq" ON "protected_identities" USING btree ("tenant_id","normalized_name");--> statement-breakpoint
CREATE INDEX "referral_clicks_link_idx" ON "referral_clicks" USING btree ("link_id","clicked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_conversions_order_uq" ON "referral_conversions" USING btree ("tenant_id","order_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_links_code_uq" ON "referral_links" USING btree ("code");--> statement-breakpoint
CREATE INDEX "render_jobs_queue_idx" ON "render_jobs" USING btree ("status","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_pages_audit_url_uq" ON "seo_pages" USING btree ("audit_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "social_interactions_ext_uq" ON "social_interactions" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "social_posts_schedule_idx" ON "social_posts" USING btree ("tenant_id","status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_personas_name_uq" ON "synthetic_personas" USING btree ("tenant_id","name");
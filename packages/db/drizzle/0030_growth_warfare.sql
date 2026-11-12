CREATE TABLE "acquisition_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"template" text NOT NULL,
	"public_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"methodology" text NOT NULL,
	"cta" jsonb NOT NULL,
	"consent" jsonb NOT NULL,
	"experiment_id" uuid,
	"data_updated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acquisition_tools_template_chk" CHECK ("acquisition_tools"."template" in ('courier_comparison', 'cod_reconciliation', 'seller_cost_calculator', 'vocabulary_assessment', 'practice_quiz', 'readiness_assessment')),
	CONSTRAINT "acquisition_tools_status_chk" CHECK ("acquisition_tools"."status" in ('draft', 'published', 'retired')),
	CONSTRAINT "acquisition_tools_public_chk" CHECK ("acquisition_tools"."public_id" ~ '^[a-z0-9]{12,40}$')
);
--> statement-breakpoint
CREATE TABLE "ai_spend_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"purpose" text NOT NULL,
	"holder" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_spend_reservations_amount_chk" CHECK ("ai_spend_reservations"."amount_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_brand_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"package" jsonb NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"approval" jsonb NOT NULL,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_micros" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_campaigns_kind_chk" CHECK ("growth_campaigns"."kind" in ('conquest', 'blitz', 'capture', 'rescue', 'referral', 'creator')),
	CONSTRAINT "growth_campaigns_status_chk" CHECK ("growth_campaigns"."status" in ('draft', 'ready_for_review', 'approved', 'in_flight', 'completed', 'cancelled', 'expired', 'blocked')),
	CONSTRAINT "growth_campaigns_budget_chk" CHECK ("growth_campaigns"."budget_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_channel_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"connection_id" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"dedup_key" text NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status_reason" text,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_channel_tasks_channel_chk" CHECK ("growth_channel_tasks"."channel" in ('facebook', 'instagram', 'email', 'paid_ads', 'owned_site', 'referral', 'partner', 'community', 'creator')),
	CONSTRAINT "growth_channel_tasks_status_chk" CHECK ("growth_channel_tasks"."status" in ('planned', 'blocked', 'ready', 'submitted', 'awaiting_approval', 'executed', 'verified', 'done_by_human', 'failed', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "growth_experiment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"campaign_id" uuid,
	"feature" text NOT NULL,
	"area" text NOT NULL,
	"dedup_key" text NOT NULL,
	"hypothesis" text NOT NULL,
	"control" jsonb NOT NULL,
	"variant" jsonb NOT NULL,
	"primary_kpi" jsonb NOT NULL,
	"guardrails" jsonb NOT NULL,
	"eligibility" jsonb NOT NULL,
	"assignment" jsonb NOT NULL,
	"sufficiency" jsonb NOT NULL,
	"stop_conditions" jsonb NOT NULL,
	"measurement_plan" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"experiment_id" uuid,
	"prior_memory_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_experiment_plans_feature_chk" CHECK ("growth_experiment_plans"."feature" in ('F1', 'F2', 'F3', 'F4', 'F5', 'F6')),
	CONSTRAINT "growth_experiment_plans_area_chk" CHECK ("growth_experiment_plans"."area" in ('positioning', 'offer', 'landing_page', 'acquisition_tool', 'onboarding', 'referral', 'campaign_variant')),
	CONSTRAINT "growth_experiment_plans_status_chk" CHECK ("growth_experiment_plans"."status" in ('proposed', 'approved', 'rejected', 'running', 'completed', 'insufficient_data', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "growth_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_operations_status_chk" CHECK ("growth_operations"."status" in ('running', 'completed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "growth_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"next_action" jsonb NOT NULL,
	"score" double precision NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"urgency" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"campaign_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_opportunities_status_chk" CHECK ("growth_opportunities"."status" in ('new', 'reviewing', 'accepted', 'dismissed', 'expired', 'converted')),
	CONSTRAINT "growth_opportunities_urgency_chk" CHECK ("growth_opportunities"."urgency" in ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "growth_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedup_key" text NOT NULL,
	"subject" text NOT NULL,
	"source_table" text NOT NULL,
	"source_ref" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_signals_kind_chk" CHECK ("growth_signals"."kind" in ('high_intent_demand', 'unmet_need', 'switching_intent', 'emerging_problem', 'demand_shift', 'competitor_price_change', 'competitor_feature_change', 'competitor_packaging_change', 'competitor_positioning_change', 'competitor_availability_change', 'competitor_policy_change')),
	CONSTRAINT "growth_signals_status_chk" CHECK ("growth_signals"."status" in ('active', 'expired', 'rejected', 'dismissed')),
	CONSTRAINT "growth_signals_evidence_chk" CHECK (cardinality("growth_signals"."evidence_ids") > 0),
	CONSTRAINT "growth_signals_confidence_chk" CHECK ("growth_signals"."confidence" >= 0 and "growth_signals"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "growth_strategy_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"plan_id" uuid,
	"experiment_id" uuid,
	"result_id" uuid,
	"tactic" text NOT NULL,
	"area" text NOT NULL,
	"channel" text,
	"hypothesis" text NOT NULL,
	"outcome" text NOT NULL,
	"inference_kind" text NOT NULL,
	"effect" jsonb NOT NULL,
	"confidence" double precision,
	"confounders" text[] DEFAULT '{}'::text[] NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_strategy_memory_outcome_chk" CHECK ("growth_strategy_memory"."outcome" in ('supported_winner', 'supported_loser', 'inconclusive', 'invalid', 'guardrail_breach', 'observational')),
	CONSTRAINT "growth_strategy_memory_inference_chk" CHECK ("growth_strategy_memory"."inference_kind" in ('randomized_test', 'observational')),
	CONSTRAINT "growth_strategy_memory_causal_chk" CHECK ("growth_strategy_memory"."inference_kind" = 'randomized_test' or "growth_strategy_memory"."outcome" in ('observational', 'inconclusive', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE "growth_warfare_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"features" jsonb NOT NULL,
	"aggression" text DEFAULT 'balanced' NOT NULL,
	"controls" jsonb NOT NULL,
	"emergency_stop" boolean DEFAULT false NOT NULL,
	"emergency_reason" text,
	"last_scan_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_warfare_settings_aggression_chk" CHECK ("growth_warfare_settings"."aggression" in ('balanced', 'aggressive', 'maximum_authorized'))
);
--> statement-breakpoint
CREATE TABLE "search_visibility_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"query" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"brand_mentioned" boolean NOT NULL,
	"brand_cited" boolean DEFAULT false NOT NULL,
	"competitors_mentioned" text[] DEFAULT '{}'::text[] NOT NULL,
	"cited_sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"recommended_products" text[] DEFAULT '{}'::text[] NOT NULL,
	"method" text NOT NULL,
	"provider" text,
	"evidence_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_visibility_method_chk" CHECK ("search_visibility_observations"."method" in ('manual_import', 'provider_api'))
);
--> statement-breakpoint
ALTER TABLE "acquisition_tools" ADD CONSTRAINT "acquisition_tools_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_brand_configs" ADD CONSTRAINT "growth_brand_configs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_campaigns" ADD CONSTRAINT "growth_campaigns_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_campaigns" ADD CONSTRAINT "growth_campaigns_opportunity_id_growth_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."growth_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_channel_tasks" ADD CONSTRAINT "growth_channel_tasks_campaign_id_growth_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."growth_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_experiment_plans" ADD CONSTRAINT "growth_experiment_plans_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_experiment_plans" ADD CONSTRAINT "growth_experiment_plans_campaign_id_growth_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."growth_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_opportunities" ADD CONSTRAINT "growth_opportunities_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_opportunities" ADD CONSTRAINT "growth_opportunities_signal_id_growth_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."growth_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_signals" ADD CONSTRAINT "growth_signals_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_strategy_memory" ADD CONSTRAINT "growth_strategy_memory_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_visibility_observations" ADD CONSTRAINT "search_visibility_observations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acquisition_tools_public_uq" ON "acquisition_tools" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "acquisition_tools_brand_idx" ON "acquisition_tools" USING btree ("tenant_id","brand_id","status");--> statement-breakpoint
CREATE INDEX "ai_spend_reservations_tenant_idx" ON "ai_spend_reservations" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_brand_configs_brand_uq" ON "growth_brand_configs" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_campaigns_opportunity_uq" ON "growth_campaigns" USING btree ("tenant_id","opportunity_id","kind") WHERE "growth_campaigns"."opportunity_id" is not null;--> statement-breakpoint
CREATE INDEX "growth_campaigns_brand_idx" ON "growth_campaigns" USING btree ("tenant_id","brand_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_channel_tasks_dedup_uq" ON "growth_channel_tasks" USING btree ("tenant_id","dedup_key");--> statement-breakpoint
CREATE INDEX "growth_channel_tasks_campaign_idx" ON "growth_channel_tasks" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE INDEX "growth_channel_tasks_channel_idx" ON "growth_channel_tasks" USING btree ("tenant_id","channel","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_experiment_plans_dedup_uq" ON "growth_experiment_plans" USING btree ("tenant_id","dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_experiment_plans_experiment_uq" ON "growth_experiment_plans" USING btree ("tenant_id","experiment_id") WHERE "growth_experiment_plans"."experiment_id" is not null;--> statement-breakpoint
CREATE INDEX "growth_experiment_plans_brand_idx" ON "growth_experiment_plans" USING btree ("tenant_id","brand_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_operations_idem_uq" ON "growth_operations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "growth_operations_kind_idx" ON "growth_operations" USING btree ("tenant_id","kind","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_opportunities_signal_uq" ON "growth_opportunities" USING btree ("tenant_id","signal_id");--> statement-breakpoint
CREATE INDEX "growth_opportunities_queue_idx" ON "growth_opportunities" USING btree ("tenant_id","brand_id","status","score");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_signals_dedup_uq" ON "growth_signals" USING btree ("tenant_id","brand_id","dedup_key");--> statement-breakpoint
CREATE INDEX "growth_signals_brand_idx" ON "growth_signals" USING btree ("tenant_id","brand_id","status","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_strategy_memory_result_uq" ON "growth_strategy_memory" USING btree ("tenant_id","result_id") WHERE "growth_strategy_memory"."result_id" is not null;--> statement-breakpoint
CREATE INDEX "growth_strategy_memory_brand_idx" ON "growth_strategy_memory" USING btree ("tenant_id","brand_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "search_visibility_obs_uq" ON "search_visibility_observations" USING btree ("tenant_id","brand_id","engine","query","observed_at");--> statement-breakpoint
CREATE INDEX "search_visibility_brand_idx" ON "search_visibility_observations" USING btree ("tenant_id","brand_id","observed_at");
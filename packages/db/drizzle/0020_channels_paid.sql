CREATE TABLE "paid_campaign_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid,
	"platform" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"geographies" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_id" uuid,
	"external_campaign_id" text,
	"created_by" text NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_campaign_drafts_platform_chk" CHECK ("paid_campaign_drafts"."platform" in ('meta', 'google_ads')),
	CONSTRAINT "paid_campaign_drafts_status_chk" CHECK ("paid_campaign_drafts"."status" in ('draft', 'submitted', 'created', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "social_analytics_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "social_analytics_runs_status_chk" CHECK ("social_analytics_runs"."status" in ('running', 'succeeded', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "social_metric_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"scope" text NOT NULL,
	"object_ref" text NOT NULL,
	"post_id" uuid,
	"metric_key" text NOT NULL,
	"value" double precision,
	"status" text NOT NULL,
	"observed_on" date NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_metric_obs_scope_chk" CHECK ("social_metric_observations"."scope" in ('account', 'post')),
	CONSTRAINT "social_metric_obs_status_chk" CHECK ("social_metric_observations"."status" in ('reported', 'not_returned')),
	CONSTRAINT "social_metric_obs_platform_chk" CHECK ("social_metric_observations"."platform" in ('facebook', 'instagram', 'tiktok', 'youtube', 'linkedin', 'x'))
);
--> statement-breakpoint
CREATE INDEX "paid_campaign_drafts_idx" ON "paid_campaign_drafts" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "social_analytics_runs_idx" ON "social_analytics_runs" USING btree ("tenant_id","connection_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_metric_obs_uq" ON "social_metric_observations" USING btree ("tenant_id","platform","scope","object_ref","metric_key","observed_on");--> statement-breakpoint
CREATE INDEX "social_metric_obs_conn_idx" ON "social_metric_observations" USING btree ("tenant_id","connection_id","observed_on");
CREATE TABLE "media_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text,
	"connection_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"request" jsonb NOT NULL,
	"request_sha256" text NOT NULL,
	"asset_id" uuid,
	"cost_usd" double precision,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "media_jobs_kind_chk" CHECK ("media_jobs"."kind" in ('ai_image', 'stock_import')),
	CONSTRAINT "media_jobs_status_chk" CHECK ("media_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "stock_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"media_type" text NOT NULL,
	"format" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"page_url" text NOT NULL,
	"author" text NOT NULL,
	"author_url" text,
	"attribution" text NOT NULL,
	"license" jsonb NOT NULL,
	"artifact_license_id" uuid NOT NULL,
	"imported_by" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "stock_assets_media_chk" CHECK ("stock_assets"."media_type" in ('photo', 'video'))
);
--> statement-breakpoint
CREATE TABLE "video_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'storyboard' NOT NULL,
	"status_reason" text,
	"preset" text NOT NULL,
	"storyboard" jsonb NOT NULL,
	"render_job_id" uuid,
	"output_asset_id" uuid,
	"thumbnail_asset_id" uuid,
	"subtitles_asset_id" uuid,
	"qa" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_projects_status_chk" CHECK ("video_projects"."status" in ('storyboard', 'rendering', 'qa_failed', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "assets_origin_chk";--> statement-breakpoint
ALTER TABLE "render_jobs" DROP CONSTRAINT "render_jobs_composition_chk";--> statement-breakpoint
ALTER TABLE "cost_ledger" DROP CONSTRAINT "cost_ledger_category_chk";--> statement-breakpoint
ALTER TABLE "model_registry" ADD COLUMN "usd_per_image" double precision;--> statement-breakpoint
ALTER TABLE "stock_assets" ADD CONSTRAINT "stock_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_jobs_queue_idx" ON "media_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "media_jobs_tenant_idx" ON "media_jobs" USING btree ("tenant_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_assets_item_uq" ON "stock_assets" USING btree ("tenant_id","provider","external_id","media_type","format");--> statement-breakpoint
CREATE INDEX "video_projects_tenant_idx" ON "video_projects" USING btree ("tenant_id","updated_at");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_origin_chk" CHECK ("assets"."origin" in ('upload', 'render', 'generated', 'stock'));--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_composition_chk" CHECK ("render_jobs"."composition" in ('product_showcase', 'ugc_captioned', 'persona_story', 'scene_story'));--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_category_chk" CHECK ("cost_ledger"."category" in ('llm', 'embedding', 'image_generation', 'media_render', 'api', 'analytics', 'storage'));
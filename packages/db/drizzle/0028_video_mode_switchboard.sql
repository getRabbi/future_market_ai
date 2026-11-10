ALTER TABLE "media_jobs" DROP CONSTRAINT "media_jobs_kind_chk";--> statement-breakpoint
ALTER TABLE "media_jobs" DROP CONSTRAINT "media_jobs_status_chk";--> statement-breakpoint
ALTER TABLE "media_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "video_routing" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "video_routing_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_jobs_idempotency_uq" ON "media_jobs" USING btree ("tenant_id","idempotency_key") WHERE "media_jobs"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_kind_chk" CHECK ("media_jobs"."kind" in ('ai_image', 'stock_import', 'voiceover', 'ai_video', 'video_import'));--> statement-breakpoint
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_status_chk" CHECK ("media_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'refused', 'awaiting_approval', 'cancelled'));
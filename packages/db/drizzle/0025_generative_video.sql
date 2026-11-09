ALTER TABLE "media_jobs" DROP CONSTRAINT "media_jobs_kind_chk";--> statement-breakpoint
ALTER TABLE "cost_ledger" DROP CONSTRAINT "cost_ledger_category_chk";--> statement-breakpoint
ALTER TABLE "model_registry" ADD COLUMN "usd_per_video_second" double precision;--> statement-breakpoint
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_kind_chk" CHECK ("media_jobs"."kind" in ('ai_image', 'stock_import', 'voiceover', 'ai_video'));--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_category_chk" CHECK ("cost_ledger"."category" in ('llm', 'embedding', 'image_generation', 'speech_generation', 'video_generation', 'media_render', 'api', 'analytics', 'storage'));
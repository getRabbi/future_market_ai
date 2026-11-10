CREATE TABLE "video_automation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"day" date NOT NULL,
	"slot" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"topic_key" text NOT NULL,
	"topic" jsonb NOT NULL,
	"category" text NOT NULL,
	"preset" text NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"status_reason" text,
	"origin" text,
	"script" jsonb,
	"mode" text,
	"manual_task" jsonb,
	"video_project_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_automation_items_status_chk" CHECK ("video_automation_items"."status" in ('planned', 'scripted', 'storyboarded', 'rendering', 'awaiting_approval', 'approved', 'rejected', 'manual_task', 'waiting', 'failed', 'skipped')),
	CONSTRAINT "video_automation_items_preset_chk" CHECK ("video_automation_items"."preset" in ('vertical_9x16', 'square_1x1', 'landscape_16x9'))
);
--> statement-breakpoint
ALTER TABLE "video_automation_items" ADD CONSTRAINT "video_automation_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_automation_items" ADD CONSTRAINT "video_automation_items_video_project_id_video_projects_id_fk" FOREIGN KEY ("video_project_id") REFERENCES "public"."video_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_automation_items_key_uq" ON "video_automation_items" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "video_automation_items_day_idx" ON "video_automation_items" USING btree ("tenant_id","day","brand_id");--> statement-breakpoint
CREATE INDEX "video_automation_items_topic_idx" ON "video_automation_items" USING btree ("tenant_id","brand_id","topic_key");
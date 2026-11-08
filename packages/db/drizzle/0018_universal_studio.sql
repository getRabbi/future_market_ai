CREATE TABLE "studio_content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"program_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"stage" text DEFAULT 'idea' NOT NULL,
	"pillar" text NOT NULL,
	"platform" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"title" text NOT NULL,
	"origin" text NOT NULL,
	"idea" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"campaign" text,
	"post_id" uuid,
	"scheduled_at" timestamp with time zone,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status_reason" text,
	"created_by" text NOT NULL,
	"updated_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_content_items_stage_chk" CHECK ("studio_content_items"."stage" in ('idea', 'brief', 'draft', 'validated', 'approved', 'scheduled', 'published', 'verified', 'measured', 'learned', 'rejected', 'failed')),
	CONSTRAINT "studio_content_items_origin_chk" CHECK ("studio_content_items"."origin" in ('ai', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "studio_programs" ADD COLUMN "kind" text DEFAULT 'curriculum' NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_programs" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "studio_programs" ADD COLUMN "plan" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_content_items" ADD CONSTRAINT "studio_content_items_program_id_studio_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."studio_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_content_items" ADD CONSTRAINT "studio_content_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_content_items" ADD CONSTRAINT "studio_content_items_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_content_items" ADD CONSTRAINT "studio_content_items_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_content_items_program_idx" ON "studio_content_items" USING btree ("tenant_id","program_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_content_items_post_uq" ON "studio_content_items" USING btree ("tenant_id","post_id");--> statement-breakpoint
ALTER TABLE "studio_programs" ADD CONSTRAINT "studio_programs_kind_chk" CHECK ("studio_programs"."kind" in ('curriculum', 'general'));--> statement-breakpoint
ALTER TABLE "studio_programs" ADD CONSTRAINT "studio_programs_general_brand_chk" CHECK ("studio_programs"."kind" <> 'general' or "studio_programs"."brand_id" is not null);
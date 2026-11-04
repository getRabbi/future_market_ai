CREATE TABLE "brand_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"app_id" text NOT NULL,
	"listing_url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_apps_platform_chk" CHECK ("brand_apps"."platform" in ('android', 'ios'))
);
--> statement-breakpoint
CREATE TABLE "brand_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"product_entity_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_status_chk" CHECK ("brands"."status" in ('active', 'paused', 'archived')),
	CONSTRAINT "brands_slug_chk" CHECK ("brands"."slug" ~ '^[a-z0-9][a-z0-9-]{1,47}$')
);
--> statement-breakpoint
CREATE TABLE "campaign_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"program_id" uuid,
	"plan_item_id" uuid,
	"post_id" uuid,
	"connection_id" uuid,
	"channel_platform" text NOT NULL,
	"app_platform" text NOT NULL,
	"app_id" text NOT NULL,
	"campaign" text NOT NULL,
	"content" text NOT NULL,
	"url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "campaign_links_app_platform_chk" CHECK ("campaign_links"."app_platform" in ('android', 'ios'))
);
--> statement-breakpoint
ALTER TABLE "studio_programs" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "brand_apps" ADD CONSTRAINT "brand_apps_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_channels" ADD CONSTRAINT "brand_channels_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_channels" ADD CONSTRAINT "brand_channels_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_program_id_studio_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."studio_programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_plan_item_id_content_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."content_plan_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_apps_app_uq" ON "brand_apps" USING btree ("tenant_id","platform","app_id");--> statement-breakpoint
CREATE INDEX "brand_apps_brand_idx" ON "brand_apps" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_channels_conn_uq" ON "brand_channels" USING btree ("tenant_id","connection_id");--> statement-breakpoint
CREATE INDEX "brand_channels_brand_idx" ON "brand_channels" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_uq" ON "brands" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_links_identity_uq" ON "campaign_links" USING btree ("tenant_id","app_platform","app_id","campaign","content");--> statement-breakpoint
CREATE INDEX "campaign_links_brand_idx" ON "campaign_links" USING btree ("tenant_id","brand_id","created_at");--> statement-breakpoint
ALTER TABLE "studio_programs" ADD CONSTRAINT "studio_programs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;
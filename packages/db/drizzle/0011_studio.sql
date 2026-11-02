CREATE TABLE "community_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"audience" text DEFAULT '' NOT NULL,
	"rules" text DEFAULT '' NOT NULL,
	"permission" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"relevance" double precision DEFAULT 0 NOT NULL,
	"relevance_notes" text DEFAULT '' NOT NULL,
	"member_count" integer,
	"notes" text DEFAULT '' NOT NULL,
	"last_shared_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_groups_permission_chk" CHECK ("community_groups"."permission" in ('unknown', 'members_may_post', 'admin_approval', 'admin_only', 'owned')),
	CONSTRAINT "community_groups_status_chk" CHECK ("community_groups"."status" in ('candidate', 'member', 'approved', 'declined', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "community_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" uuid NOT NULL,
	"plan_item_id" uuid,
	"kind" text DEFAULT 'lesson' NOT NULL,
	"caption" text NOT NULL,
	"asset_id" uuid,
	"status" text DEFAULT 'prepared' NOT NULL,
	"permalink" text,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_shares_status_chk" CHECK ("community_shares"."status" in ('prepared', 'shared', 'declined', 'expired')),
	CONSTRAINT "community_shares_kind_chk" CHECK ("community_shares"."kind" in ('lesson', 'permission_request'))
);
--> statement-breakpoint
CREATE TABLE "content_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"program_id" uuid NOT NULL,
	"goal_id" uuid,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"unit_id" text,
	"pack_version" text NOT NULL,
	"objective" text NOT NULL,
	"segment" text NOT NULL,
	"template" text NOT NULL,
	"palette" text NOT NULL,
	"variant" integer DEFAULT 0 NOT NULL,
	"hook_id" text,
	"prompt_id" text,
	"cta_feature" text,
	"rationale" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"status_reason" text,
	"post_id" uuid,
	"asset_id" uuid,
	"dhash" text,
	"published_at" timestamp with time zone,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"engagement" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_plan_status_chk" CHECK ("content_plan_items"."status" in ('planned', 'drafted', 'submitted', 'published', 'skipped', 'failed')),
	CONSTRAINT "content_plan_objective_chk" CHECK ("content_plan_items"."objective" in ('EDUCATE', 'ENGAGE', 'DISCOVER', 'VISIT_APP', 'INSTALL_APP', 'RETAIN')),
	CONSTRAINT "content_plan_variant_chk" CHECK ("content_plan_items"."variant" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "studio_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"pack" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_programs_status_chk" CHECK ("studio_programs"."status" in ('active', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "community_shares" ADD CONSTRAINT "community_shares_group_id_community_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."community_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_shares" ADD CONSTRAINT "community_shares_plan_item_id_content_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."content_plan_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_shares" ADD CONSTRAINT "community_shares_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plan_items" ADD CONSTRAINT "content_plan_items_program_id_studio_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."studio_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plan_items" ADD CONSTRAINT "content_plan_items_goal_id_growth_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."growth_goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plan_items" ADD CONSTRAINT "content_plan_items_post_id_social_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plan_items" ADD CONSTRAINT "content_plan_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_programs" ADD CONSTRAINT "studio_programs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_groups_url_uq" ON "community_groups" USING btree ("tenant_id","url");--> statement-breakpoint
CREATE INDEX "community_shares_group_idx" ON "community_shares" USING btree ("tenant_id","group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_plan_day_uq" ON "content_plan_items" USING btree ("program_id","day");--> statement-breakpoint
CREATE INDEX "content_plan_status_idx" ON "content_plan_items" USING btree ("tenant_id","status","day");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_programs_conn_uq" ON "studio_programs" USING btree ("tenant_id","connection_id");
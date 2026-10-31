CREATE TABLE "goal_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"goal_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"plan" jsonb NOT NULL,
	"summary" text,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "goal_cycles_status_chk" CHECK ("goal_cycles"."status" in ('running', 'completed', 'blocked', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "goal_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"goal_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"modules" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"needs" text,
	"uses_ai" boolean DEFAULT false NOT NULL,
	"ai_calls" integer DEFAULT 0 NOT NULL,
	"dedup_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"not_before" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"wait_until" timestamp with time zone,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_tasks_status_chk" CHECK ("goal_tasks"."status" in ('pending', 'running', 'waiting', 'completed', 'skipped', 'blocked', 'failed', 'cancelled')),
	CONSTRAINT "goal_tasks_kind_chk" CHECK ("goal_tasks"."kind" in ('observe', 'forecast', 'research', 'ideas', 'decide', 'content', 'submit', 'track', 'measure', 'learn'))
);
--> statement-breakpoint
CREATE TABLE "growth_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"statement" text NOT NULL,
	"kpi" jsonb NOT NULL,
	"market" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_date" timestamp with time zone NOT NULL,
	"channels" text[] NOT NULL,
	"ad_budget_micros" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"auto_submit" boolean DEFAULT true NOT NULL,
	"limits" jsonb NOT NULL,
	"site_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"pending_trigger" text,
	"last_cycle_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_goals_status_chk" CHECK ("growth_goals"."status" in ('active', 'paused', 'completed', 'cancelled')),
	CONSTRAINT "growth_goals_channels_chk" CHECK (cardinality("growth_goals"."channels") > 0 and "growth_goals"."channels" <@ array['organic_social', 'app_store', 'seo', 'email', 'experiments', 'paid_ads', 'offers']::text[]),
	CONSTRAINT "growth_goals_budget_chk" CHECK ("growth_goals"."ad_budget_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "growth_decisions" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "autopilot_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_cycles" ADD CONSTRAINT "goal_cycles_goal_id_growth_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."growth_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_tasks" ADD CONSTRAINT "goal_tasks_goal_id_growth_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."growth_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_tasks" ADD CONSTRAINT "goal_tasks_cycle_id_goal_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."goal_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goal_cycles_seq_uq" ON "goal_cycles" USING btree ("goal_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_cycles_one_running_uq" ON "goal_cycles" USING btree ("goal_id") WHERE "goal_cycles"."status" = 'running';--> statement-breakpoint
CREATE INDEX "goal_cycles_goal_idx" ON "goal_cycles" USING btree ("tenant_id","goal_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_tasks_dedup_uq" ON "goal_tasks" USING btree ("tenant_id","dedup_key");--> statement-breakpoint
CREATE INDEX "goal_tasks_cycle_idx" ON "goal_tasks" USING btree ("cycle_id","seq");--> statement-breakpoint
CREATE INDEX "goal_tasks_goal_idx" ON "goal_tasks" USING btree ("tenant_id","goal_id","updated_at");--> statement-breakpoint
CREATE INDEX "goal_tasks_open_idx" ON "goal_tasks" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "growth_goals_due_idx" ON "growth_goals" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "growth_goals_tenant_idx" ON "growth_goals" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "growth_decisions_goal_idx" ON "growth_decisions" USING btree ("goal_id");
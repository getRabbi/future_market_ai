CREATE TABLE "store_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_ref" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"health_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_checked_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_finished_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"backfill_cursor" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_accounts_provider_chk" CHECK ("store_accounts"."provider" in ('google_play', 'app_store_connect')),
	CONSTRAINT "store_accounts_status_chk" CHECK ("store_accounts"."status" in ('active', 'disabled')),
	CONSTRAINT "store_accounts_health_chk" CHECK ("store_accounts"."health_status" in ('unknown', 'ok', 'permission_denied', 'not_found', 'auth_failed', 'rate_limited', 'error'))
);
--> statement-breakpoint
CREATE TABLE "store_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"store_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"app_id" text NOT NULL,
	"store_app_id" text,
	"display_name" text,
	"status" text DEFAULT 'discovered' NOT NULL,
	"discovered_via" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"conflict_detail" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_apps_platform_chk" CHECK ("store_apps"."platform" in ('android', 'ios')),
	CONSTRAINT "store_apps_status_chk" CHECK ("store_apps"."status" in ('discovered', 'confirmed', 'ignored', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "store_metric_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"partition_id" uuid NOT NULL,
	"store_app_id" uuid NOT NULL,
	"store_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"app_id" text NOT NULL,
	"provider" text NOT NULL,
	"family" text NOT NULL,
	"dimension" text NOT NULL,
	"metric_key" text NOT NULL,
	"source_metric" text NOT NULL,
	"observation_date" date NOT NULL,
	"reporting_timezone" text,
	"dims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dims_key" text NOT NULL,
	"value" double precision,
	"report_file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_report_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"store_app_id" uuid NOT NULL,
	"family" text NOT NULL,
	"dimension" text NOT NULL,
	"period" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_report_coverage_status_chk" CHECK ("store_report_coverage"."status" in ('pending', 'unavailable', 'permission_denied', 'not_yet_published', 'partial', 'complete', 'revised'))
);
--> statement-breakpoint
CREATE TABLE "store_report_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"store_account_id" uuid NOT NULL,
	"store_app_id" uuid,
	"provider" text NOT NULL,
	"family" text NOT NULL,
	"dimension" text NOT NULL,
	"period" text NOT NULL,
	"source_uri" text NOT NULL,
	"source_version" text NOT NULL,
	"source_rank" bigint NOT NULL,
	"source_updated_at" timestamp with time zone,
	"source_checksum" text,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"encoding" text,
	"header" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_fingerprint" text,
	"unmapped_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_rejected" integer DEFAULT 0 NOT NULL,
	"observations" integer DEFAULT 0 NOT NULL,
	"partitions_changed" integer DEFAULT 0 NOT NULL,
	"partitions_revised" integer DEFAULT 0 NOT NULL,
	"partitions_skipped" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"object_key" text,
	"evidence_id" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_report_files_status_chk" CHECK ("store_report_files"."status" in ('imported', 'partial', 'failed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "store_report_partitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"store_app_id" uuid NOT NULL,
	"family" text NOT NULL,
	"dimension" text NOT NULL,
	"observation_date" date NOT NULL,
	"report_file_id" uuid NOT NULL,
	"source_rank" bigint NOT NULL,
	"rows" integer NOT NULL,
	"digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"first_imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_report_partitions_status_chk" CHECK ("store_report_partitions"."status" in ('provisional', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "store_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"store_account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"triggered_by" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "store_sync_runs_mode_chk" CHECK ("store_sync_runs"."mode" in ('discovery', 'incremental', 'backfill')),
	CONSTRAINT "store_sync_runs_status_chk" CHECK ("store_sync_runs"."status" in ('running', 'succeeded', 'partial', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "campaign_links" ADD COLUMN "report_scope" text DEFAULT 'content' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_accounts" ADD CONSTRAINT "store_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_apps" ADD CONSTRAINT "store_apps_store_account_id_store_accounts_id_fk" FOREIGN KEY ("store_account_id") REFERENCES "public"."store_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_metric_observations" ADD CONSTRAINT "store_metric_observations_partition_id_store_report_partitions_id_fk" FOREIGN KEY ("partition_id") REFERENCES "public"."store_report_partitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_report_coverage" ADD CONSTRAINT "store_report_coverage_store_app_id_store_apps_id_fk" FOREIGN KEY ("store_app_id") REFERENCES "public"."store_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_report_files" ADD CONSTRAINT "store_report_files_store_account_id_store_accounts_id_fk" FOREIGN KEY ("store_account_id") REFERENCES "public"."store_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_report_files" ADD CONSTRAINT "store_report_files_store_app_id_store_apps_id_fk" FOREIGN KEY ("store_app_id") REFERENCES "public"."store_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_report_partitions" ADD CONSTRAINT "store_report_partitions_store_app_id_store_apps_id_fk" FOREIGN KEY ("store_app_id") REFERENCES "public"."store_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_report_partitions" ADD CONSTRAINT "store_report_partitions_report_file_id_store_report_files_id_fk" FOREIGN KEY ("report_file_id") REFERENCES "public"."store_report_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_sync_runs" ADD CONSTRAINT "store_sync_runs_store_account_id_store_accounts_id_fk" FOREIGN KEY ("store_account_id") REFERENCES "public"."store_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_accounts_connection_uq" ON "store_accounts" USING btree ("tenant_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_accounts_ref_uq" ON "store_accounts" USING btree ("tenant_id","provider","account_ref");--> statement-breakpoint
CREATE INDEX "store_accounts_due_idx" ON "store_accounts" USING btree ("status","next_sync_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_apps_account_app_uq" ON "store_apps" USING btree ("tenant_id","store_account_id","platform","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_apps_confirmed_uq" ON "store_apps" USING btree ("tenant_id","platform","app_id") WHERE "store_apps"."status" = 'confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX "store_metric_observations_uq" ON "store_metric_observations" USING btree ("tenant_id","partition_id","metric_key","dims_key");--> statement-breakpoint
CREATE INDEX "store_metric_observations_app_idx" ON "store_metric_observations" USING btree ("tenant_id","store_app_id","metric_key","observation_date");--> statement-breakpoint
CREATE UNIQUE INDEX "store_report_coverage_uq" ON "store_report_coverage" USING btree ("tenant_id","store_app_id","family","dimension","period");--> statement-breakpoint
CREATE UNIQUE INDEX "store_report_files_source_uq" ON "store_report_files" USING btree ("tenant_id","store_account_id","source_uri","source_version");--> statement-breakpoint
CREATE INDEX "store_report_files_app_idx" ON "store_report_files" USING btree ("tenant_id","store_app_id","family","period");--> statement-breakpoint
CREATE UNIQUE INDEX "store_report_partitions_uq" ON "store_report_partitions" USING btree ("tenant_id","store_app_id","family","dimension","observation_date");--> statement-breakpoint
CREATE INDEX "store_sync_runs_account_idx" ON "store_sync_runs" USING btree ("tenant_id","store_account_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_links_campaign_scope_uq" ON "campaign_links" USING btree ("tenant_id","app_platform","app_id","campaign") WHERE "campaign_links"."report_scope" = 'campaign';--> statement-breakpoint
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_report_scope_chk" CHECK ("campaign_links"."report_scope" in ('content', 'campaign'));
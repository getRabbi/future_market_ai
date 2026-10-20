CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"object_key" text,
	"archive_sha256" text,
	"bytes" bigint,
	"table_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "backup_runs_kind_chk" CHECK ("backup_runs"."kind" in ('backup', 'verification', 'restore_drill')),
	CONSTRAINT "backup_runs_status_chk" CHECK ("backup_runs"."status" in ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "backup_runs_kind_time_idx" ON "backup_runs" USING btree ("kind","finished_at");
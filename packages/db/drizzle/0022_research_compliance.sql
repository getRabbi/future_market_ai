CREATE TABLE "research_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"description" text NOT NULL,
	"ownership" text NOT NULL,
	"authorization_evidence_id" uuid NOT NULL,
	"allowed_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_targets_kind_chk" CHECK ("research_targets"."kind" in ('artifact', 'package', 'domain')),
	CONSTRAINT "research_targets_status_chk" CHECK ("research_targets"."status" in ('active', 'revoked')),
	CONSTRAINT "research_targets_ownership_chk" CHECK ("research_targets"."ownership" in ('owned_by_tenant', 'licensed_with_analysis_rights', 'explicit_written_authorization'))
);
--> statement-breakpoint
CREATE TABLE "compliance_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"reviewer_name" text,
	"reviewer_role" text,
	"reviewed_at" timestamp with time zone,
	"document_ref" text,
	"evidence_id" uuid,
	"content_sha256" text,
	"note" text,
	"expires_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_items_status_chk" CHECK ("compliance_items"."status" in ('not_started', 'in_review', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "rea_jobs" DROP CONSTRAINT "rea_jobs_status_chk";--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "target_id" uuid;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "limits" jsonb;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "runner" text;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "terminated_by" text;--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD COLUMN "quarantine" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "research_targets_uq" ON "research_targets" USING btree ("tenant_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_items_uq" ON "compliance_items" USING btree ("tenant_id","key");--> statement-breakpoint
ALTER TABLE "rea_jobs" ADD CONSTRAINT "rea_jobs_status_chk" CHECK ("rea_jobs"."status" in ('registered', 'blocked_no_sandbox', 'rejected', 'pending_approval', 'approved', 'refused', 'running', 'completed', 'failed', 'terminated'));
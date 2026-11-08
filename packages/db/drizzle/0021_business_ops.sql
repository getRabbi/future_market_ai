CREATE TABLE "creator_payout_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"receiver" text NOT NULL,
	"kyc_status" text DEFAULT 'not_started' NOT NULL,
	"kyc_evidence_id" uuid,
	"tax_form_evidence_id" uuid,
	"country" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_payout_profiles_kyc_chk" CHECK ("creator_payout_profiles"."kyc_status" in ('not_started', 'pending', 'verified', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "event_forwarding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"destination" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cursor_received_at" timestamp with time zone,
	"cursor_event_id" uuid,
	"forwarded" integer DEFAULT 0 NOT NULL,
	"skipped_no_consent" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_forwarding_dest_chk" CHECK ("event_forwarding"."destination" in ('posthog'))
);
--> statement-breakpoint
CREATE TABLE "payout_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_id" uuid NOT NULL,
	"status" text NOT NULL,
	"amounts" jsonb NOT NULL,
	"readiness" jsonb NOT NULL,
	"blockers" text[] DEFAULT '{}'::text[] NOT NULL,
	"action_id" uuid,
	"provider_batch_id" text,
	"provider_status" text,
	"reconciled_at" timestamp with time zone,
	"dispute" jsonb,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_requests_status_chk" CHECK ("payout_requests"."status" in ('blocked', 'proposed', 'approved', 'sent', 'paid', 'failed', 'denied', 'disputed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "chatwoot_conversation_id" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_status" text;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_payout_profiles_uq" ON "creator_payout_profiles" USING btree ("tenant_id","creator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_forwarding_dest_uq" ON "event_forwarding" USING btree ("tenant_id","destination","connection_id");--> statement-breakpoint
CREATE INDEX "payout_requests_creator_idx" ON "payout_requests" USING btree ("tenant_id","creator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_external_uq" ON "conversation_messages" USING btree ("tenant_id","external_id");
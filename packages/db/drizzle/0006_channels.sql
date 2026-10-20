CREATE TABLE "ad_budget_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"daily_budget_micros" bigint NOT NULL,
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_budget_history_source_chk" CHECK ("ad_budget_history"."source" in ('sync', 'verified_action', 'external_change'))
);
--> statement-breakpoint
ALTER TABLE "journey_enrollments" ADD COLUMN "evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "connection_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "evidence_freshness_hours" integer DEFAULT 168 NOT NULL;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_budget_history" ADD CONSTRAINT "ad_budget_history_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_budget_history_campaign_idx" ON "ad_budget_history" USING btree ("campaign_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_enrollments_trigger_uq" ON "journey_enrollments" USING btree ("journey_id","trigger_event_id");--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_freshness_chk" CHECK ("journeys"."evidence_freshness_hours" between 1 and 720);--> statement-breakpoint
-- Budget history is the authorized-spend envelope used by reconciliation: append-only.
INSERT INTO fg_security_config (table_name, tenant_privileges) VALUES ('ad_budget_history', 'SELECT, INSERT')
ON CONFLICT (table_name) DO UPDATE SET tenant_privileges = EXCLUDED.tenant_privileges;
--> statement-breakpoint
CREATE TRIGGER fg_immutable_row BEFORE UPDATE OR DELETE ON ad_budget_history FOR EACH ROW EXECUTE FUNCTION fg_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER fg_immutable_truncate BEFORE TRUNCATE ON ad_budget_history FOR EACH STATEMENT EXECUTE FUNCTION fg_forbid_mutation();

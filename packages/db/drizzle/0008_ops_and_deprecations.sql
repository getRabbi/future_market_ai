CREATE TABLE "api_deprecation_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"api_version" text NOT NULL,
	"signal" text NOT NULL,
	"endpoint" text NOT NULL,
	"sunset_at" timestamp with time zone,
	"detail" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_deprecation_signals_signal_chk" CHECK ("api_deprecation_signals"."signal" in ('deprecation_header', 'sunset_header', 'provider_warning', 'version_upgraded', 'registry_eol'))
);
--> statement-breakpoint
CREATE TABLE "ops_notifications" (
	"dedup_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ops_notifications_severity_chk" CHECK ("ops_notifications"."severity" in ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_deprecation_signals_uq" ON "api_deprecation_signals" USING btree ("provider","api_version","signal","endpoint");--> statement-breakpoint
CREATE INDEX "ops_notifications_open_idx" ON "ops_notifications" USING btree ("kind","resolved_at");--> statement-breakpoint
-- Global table: tenants (fg_tenant) may read deprecation evidence for policy facts; writes are system-only.
INSERT INTO fg_security_config (table_name, tenant_privileges) VALUES ('api_deprecation_signals', 'SELECT') ON CONFLICT (table_name) DO UPDATE SET tenant_privileges = EXCLUDED.tenant_privileges;

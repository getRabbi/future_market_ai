CREATE TABLE "competitor_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"identity" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"category" text NOT NULL,
	"score" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"reasons" jsonb NOT NULL,
	"evidence_id" uuid NOT NULL,
	"status" text DEFAULT 'review' NOT NULL,
	"competitor_id" uuid,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"status" text NOT NULL,
	"query" text NOT NULL,
	"provider" text NOT NULL,
	"note" text,
	"result_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "competitor_discovery_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"country" text NOT NULL,
	"interval_hours" integer DEFAULT 168 NOT NULL,
	"lawful_basis_note" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "competitor_candidates" ADD CONSTRAINT "competitor_candidates_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_candidates" ADD CONSTRAINT "competitor_candidates_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_candidates" ADD CONSTRAINT "competitor_candidates_run_id_competitor_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."competitor_discovery_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_discovery_runs" ADD CONSTRAINT "competitor_discovery_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_discovery_settings" ADD CONSTRAINT "competitor_discovery_settings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_candidates_identity_uq" ON "competitor_candidates" USING btree ("tenant_id","brand_id","identity");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_discovery_brand_uq" ON "competitor_discovery_settings" USING btree ("tenant_id","brand_id");
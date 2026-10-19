CREATE TABLE "ingestion_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ingestion_keys_kind_chk" CHECK ("ingestion_keys"."kind" in ('server', 'browser')),
	CONSTRAINT "ingestion_keys_status_chk" CHECK ("ingestion_keys"."status" in ('active', 'revoked')),
	CONSTRAINT "ingestion_keys_browser_origin_chk" CHECK ("ingestion_keys"."kind" <> 'browser' or cardinality("ingestion_keys"."allowed_origins") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_keys_hash_uq" ON "ingestion_keys" USING btree ("key_hash");
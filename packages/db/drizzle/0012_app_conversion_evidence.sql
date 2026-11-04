ALTER TABLE "app_installs" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "app_installs" ADD COLUMN "ingestion_source" text;--> statement-breakpoint
ALTER TABLE "app_installs" ADD COLUMN "evidence_id" uuid;--> statement-breakpoint
CREATE INDEX "app_installs_campaign_idx" ON "app_installs" USING btree ("tenant_id","app_id","platform","campaign_ref","installed_at");
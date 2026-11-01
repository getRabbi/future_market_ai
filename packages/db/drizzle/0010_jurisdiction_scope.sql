ALTER TABLE "jurisdiction_rules" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "jurisdiction_rules" ADD COLUMN "sign_off" jsonb;--> statement-breakpoint
ALTER TABLE "jurisdiction_rules" ADD COLUMN "rules_hash" text;--> statement-breakpoint
ALTER TABLE "jurisdiction_rules" ADD CONSTRAINT "jurisdiction_rules_domain_chk" CHECK ("jurisdiction_rules"."domain" in ('organic_social', 'social_engagement', 'advertising', 'messaging', 'pricing_promotions', 'store_listing', 'data_export'));--> statement-breakpoint
-- D-037: an approval without sign-off provenance was only a technical submission; such rows become drafts.
UPDATE "jurisdiction_rules" SET "approved_by_legal" = false WHERE "approved_by_legal" AND "sign_off" IS NULL;--> statement-breakpoint
ALTER TABLE "jurisdiction_rules" ADD CONSTRAINT "jurisdiction_rules_approval_chk" CHECK (not "jurisdiction_rules"."approved_by_legal" or ("jurisdiction_rules"."approved_by" is not null and "jurisdiction_rules"."approved_at" is not null and "jurisdiction_rules"."sign_off" is not null and "jurisdiction_rules"."rules_hash" is not null and cardinality("jurisdiction_rules"."source_refs") > 0));
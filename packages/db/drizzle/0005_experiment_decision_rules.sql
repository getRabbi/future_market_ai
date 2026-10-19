ALTER TABLE "experiments" ADD COLUMN "decision_rules" jsonb;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "min_exploration_share" double precision;
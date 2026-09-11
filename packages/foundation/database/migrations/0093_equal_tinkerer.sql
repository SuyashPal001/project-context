CREATE TYPE "public"."agent_origin" AS ENUM('built_in', 'official', 'custom');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "origin" "agent_origin" DEFAULT 'custom' NOT NULL;
--> statement-breakpoint
-- Backfill existing rows from the same signals the column now makes
-- explicit: is_default marks the one agent every tenant already has (Olmo),
-- and persona_id marks a catalog-attached (official) agent. Everything else
-- keeps the column default of 'custom', which is already correct for them.
UPDATE "agents" SET "origin" = 'built_in' WHERE "is_default" = true;
--> statement-breakpoint
UPDATE "agents" SET "origin" = 'official' WHERE "persona_id" IS NOT NULL AND "is_default" = false;
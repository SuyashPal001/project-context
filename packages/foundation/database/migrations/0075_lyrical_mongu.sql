CREATE TABLE IF NOT EXISTS "credit_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"credits" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_packs_key_uq" ON "credit_packs" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_packs_active_idx" ON "credit_packs" USING btree ("is_active","sort_order");
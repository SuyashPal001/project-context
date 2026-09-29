ALTER TABLE "creative_products" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "creative_products" ADD COLUMN "usps" text[] DEFAULT '{}'::text[] NOT NULL;
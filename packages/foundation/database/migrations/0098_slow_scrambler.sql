CREATE TYPE "public"."creative_product_naming_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creative_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" text,
	"source_url" text,
	"image_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"naming_status" "creative_product_naming_status" DEFAULT 'done' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_products" ADD CONSTRAINT "creative_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_products" ADD CONSTRAINT "creative_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creative_products_tenant_created_idx" ON "creative_products" USING btree ("tenant_id","created_at");
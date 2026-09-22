CREATE TYPE "public"."creative_library_asset_kind" AS ENUM('avatar', 'product');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creative_library_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"slug" text NOT NULL,
	"kind" "creative_library_asset_kind" NOT NULL,
	"name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "creative_library_assets_tenant_id_slug_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_library_assets" ADD CONSTRAINT "creative_library_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

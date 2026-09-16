CREATE TABLE IF NOT EXISTS "creative_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"image_url" text NOT NULL,
	"reference_file_id" uuid,
	"clone_prompt" text NOT NULL,
	"negative_prompt" text NOT NULL,
	"clone_notes" text NOT NULL,
	"exclude_in_clone" text NOT NULL,
	"technical" jsonb NOT NULL,
	"scenes" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "creative_templates_tenant_id_slug_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_templates" ADD CONSTRAINT "creative_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_templates" ADD CONSTRAINT "creative_templates_reference_file_id_files_id_fk" FOREIGN KEY ("reference_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

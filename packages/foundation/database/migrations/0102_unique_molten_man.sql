CREATE TABLE IF NOT EXISTS "creative_brand" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text,
	"one_liner" text,
	"audience" text,
	"region" text DEFAULT 'IN' NOT NULL,
	"tone_words" text[] DEFAULT '{}'::text[] NOT NULL,
	"emoji_policy" text DEFAULT 'minimal' NOT NULL,
	"signature_phrases" text[] DEFAULT '{}'::text[] NOT NULL,
	"banned_phrases" text[] DEFAULT '{}'::text[] NOT NULL,
	"cta_examples" text[] DEFAULT '{}'::text[] NOT NULL,
	"voice_notes" text,
	"colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"headline_font" text,
	"logo_file_id" uuid,
	"favicon_file_id" uuid,
	"mascot_file_id" uuid,
	"source_type" text,
	"source_value" text,
	"import_status" text DEFAULT 'idle' NOT NULL,
	"import_error" text,
	"import_started_at" timestamp with time zone,
	"imported_at" timestamp with time zone,
	"edited_by_user" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_brand" ADD CONSTRAINT "creative_brand_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_brand" ADD CONSTRAINT "creative_brand_logo_file_id_files_id_fk" FOREIGN KEY ("logo_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_brand" ADD CONSTRAINT "creative_brand_favicon_file_id_files_id_fk" FOREIGN KEY ("favicon_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_brand" ADD CONSTRAINT "creative_brand_mascot_file_id_files_id_fk" FOREIGN KEY ("mascot_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_brand" ADD CONSTRAINT "creative_brand_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "creative_brand_tenant_unique" ON "creative_brand" USING btree ("tenant_id");
DO $$ BEGIN
 CREATE TYPE "public"."pack_status" AS ENUM('draft', 'sent', 'signed', 'revoked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pack_section_kind" AS ENUM('delivered', 'credentials', 'training', 'support', 'signoff');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pack_item_source" AS ENUM('manual', 'task', 'milestone', 'file');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handover_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"client_id" uuid,
	"title" text NOT NULL,
	"scope_summary" text,
	"delivery_date" timestamp,
	"prepared_by" uuid NOT NULL,
	"recipient_name" text,
	"recipient_email" text,
	"status" "pack_status" DEFAULT 'draft' NOT NULL,
	"token_hash" text,
	"sent_at" timestamp,
	"signed_at" timestamp,
	"signed_by_name" text,
	"signed_by_email" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"kind" "pack_section_kind" NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"eyebrow" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pack_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status_label" text,
	"category_label" text,
	"source_type" "pack_item_source" DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"file_id" uuid,
	"url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_sections" ADD CONSTRAINT "pack_sections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_sections" ADD CONSTRAINT "pack_sections_pack_id_handover_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."handover_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_pack_id_handover_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."handover_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_section_id_pack_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."pack_sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handover_packs_tenant_status_idx" ON "handover_packs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "handover_packs_token_hash_uniq" ON "handover_packs" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "handover_packs_plan_live_uniq" ON "handover_packs" USING btree ("plan_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_sections_pack_kind_uniq" ON "pack_sections" USING btree ("pack_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_sections_pack_sort_idx" ON "pack_sections" USING btree ("pack_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_section_sort_idx" ON "pack_items" USING btree ("section_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_pack_idx" ON "pack_items" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_source_idx" ON "pack_items" USING btree ("source_type","source_id");

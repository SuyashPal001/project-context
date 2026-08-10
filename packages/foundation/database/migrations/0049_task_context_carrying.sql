CREATE TYPE "public"."client_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."revision_actor_type" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TYPE "public"."pack_item_source" AS ENUM('manual', 'task', 'milestone', 'file');--> statement-breakpoint
CREATE TYPE "public"."pack_section_kind" AS ENUM('delivered', 'credentials', 'training', 'support', 'signoff');--> statement-breakpoint
CREATE TYPE "public"."pack_status" AS ENUM('draft', 'sent', 'signed', 'revoked');--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'product_manager';--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'analyst';--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'project_manager';--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'tech_lead';--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'architect';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" text,
	"workflow_id" text,
	"run_id" text,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"brand_name" text,
	"logo_url" text,
	"brand_color" text,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "clients_tenant_slug_unique" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"field" text NOT NULL,
	"original_content" jsonb,
	"corrected_content" jsonb,
	"was_edited" boolean NOT NULL,
	"actor_type" "revision_actor_type" NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
);
--> statement-breakpoint
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
);
--> statement-breakpoint
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
);
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_feedback" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ALTER COLUMN "score" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "personal_identifier" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "raw_input" text;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "repo_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "person_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "project_plans" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "project_plans" ADD COLUMN "context" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_folders" ADD CONSTRAINT "person_folders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handover_packs" ADD CONSTRAINT "handover_packs_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_pack_id_handover_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."handover_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_section_id_pack_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."pack_sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_items" ADD CONSTRAINT "pack_items_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_sections" ADD CONSTRAINT "pack_sections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pack_sections" ADD CONSTRAINT "pack_sections_pack_id_handover_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."handover_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "person_folders_tenant_identifier_uniq" ON "person_folders" USING btree ("tenant_id","identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_folders_tenant_idx" ON "person_folders" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_tenant_time_idx" ON "token_costs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_workflow_idx" ON "token_costs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clients_tenant_status_idx" ON "clients" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_revisions_task_created_at_idx" ON "task_revisions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_revisions_tenant_field_idx" ON "task_revisions" USING btree ("tenant_id","field");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handover_packs_tenant_status_idx" ON "handover_packs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "handover_packs_token_hash_uniq" ON "handover_packs" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "handover_packs_plan_live_uniq" ON "handover_packs" USING btree ("plan_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_section_sort_idx" ON "pack_items" USING btree ("section_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_pack_idx" ON "pack_items" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_items_source_idx" ON "pack_items" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pack_sections_pack_kind_uniq" ON "pack_sections" USING btree ("pack_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pack_sections_pack_sort_idx" ON "pack_sections" USING btree ("pack_id","sort_order");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_repo_id_github_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."github_repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_person_folder_id_person_folders_id_fk" FOREIGN KEY ("person_folder_id") REFERENCES "public"."person_folders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_conversation_idx" ON "agent_tasks" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_plans_client_idx" ON "project_plans" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "llm_providers" DROP COLUMN IF EXISTS "openclaw_model_id";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_personal_identifier_unique" UNIQUE("personal_identifier");
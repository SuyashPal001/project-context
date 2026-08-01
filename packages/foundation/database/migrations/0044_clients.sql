CREATE TYPE "public"."client_status" AS ENUM('active', 'archived');--> statement-breakpoint
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
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_feedback" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ALTER COLUMN "score" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "personal_identifier" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "person_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "project_plans" ADD COLUMN "client_id" uuid;--> statement-breakpoint
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
CREATE UNIQUE INDEX IF NOT EXISTS "person_folders_tenant_identifier_uniq" ON "person_folders" USING btree ("tenant_id","identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_folders_tenant_idx" ON "person_folders" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_tenant_time_idx" ON "token_costs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_workflow_idx" ON "token_costs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clients_tenant_status_idx" ON "clients" USING btree ("tenant_id","status");--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "project_plans_client_idx" ON "project_plans" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "llm_providers" DROP COLUMN IF EXISTS "openclaw_model_id";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_personal_identifier_unique" UNIQUE("personal_identifier");
CREATE TYPE "public"."ingestion_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_fairness_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_by" uuid NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"overall_status" "fairness_status" NOT NULL,
	"check_results" jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ALTER COLUMN "attachment_file_ids" SET DATA TYPE jsonb;--> statement-breakpoint
ALTER TABLE "agent_tasks" ALTER COLUMN "attachment_file_ids" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "format_detected" varchar(64);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "office_code" varchar(32) DEFAULT 'PB-001';--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "classification" varchar(32) DEFAULT 'Confidential';--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "chunk_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "ingestion_status" "ingestion_status" DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "extracted_fields" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_fairness_reviews" ADD CONSTRAINT "agent_fairness_reviews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_fairness_reviews" ADD CONSTRAINT "agent_fairness_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_fairness_reviews" ADD CONSTRAINT "agent_fairness_reviews_run_by_users_id_fk" FOREIGN KEY ("run_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_installations_tenant" ON "github_installations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_installations_installation" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_repos_tenant" ON "github_repos" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_repos_installation" ON "github_repos" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_repos_unique" ON "github_repos" USING btree ("tenant_id","repo_full_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_reviews_agent_idx" ON "agent_fairness_reviews" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_reviews_tenant_idx" ON "agent_fairness_reviews" USING btree ("tenant_id");
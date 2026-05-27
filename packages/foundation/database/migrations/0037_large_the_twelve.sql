CREATE TYPE "public"."finding_status" AS ENUM('pass', 'fail', 'cannot_evaluate');--> statement-breakpoint
CREATE TYPE "public"."officer_action" AS ENUM('accept', 'override', 'escalate');--> statement-breakpoint
CREATE TYPE "public"."pension_case_status" AS ENUM('pending_review', 'cleared', 'incomplete', 'reviewed', 'escalated');--> statement-breakpoint
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
CREATE TABLE IF NOT EXISTS "pension_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_ref" text NOT NULL,
	"pensioner_name" text NOT NULL,
	"office_code" text DEFAULT 'PB-001' NOT NULL,
	"document_ids" jsonb DEFAULT '[]' NOT NULL,
	"fields" jsonb DEFAULT '{}' NOT NULL,
	"status" "pension_case_status" DEFAULT 'pending_review' NOT NULL,
	"assigned_role" text DEFAULT 'Dealing Hand' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pension_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"status" "finding_status" NOT NULL,
	"provision" text NOT NULL,
	"narration" text NOT NULL,
	"declared_value" numeric,
	"calculated_value" numeric,
	"math" jsonb,
	"trace" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pension_officer_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"finding_id" uuid,
	"action" "officer_action" NOT NULL,
	"rationale" text,
	"actor_id" uuid,
	"actor_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pension_cases" ADD CONSTRAINT "pension_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pension_findings" ADD CONSTRAINT "pension_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pension_findings" ADD CONSTRAINT "pension_findings_case_id_pension_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pension_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pension_officer_actions" ADD CONSTRAINT "pension_officer_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pension_officer_actions" ADD CONSTRAINT "pension_officer_actions_case_id_pension_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pension_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pension_officer_actions" ADD CONSTRAINT "pension_officer_actions_finding_id_pension_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."pension_findings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pension_officer_actions" ADD CONSTRAINT "pension_officer_actions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_tenant_time_idx" ON "token_costs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_workflow_idx" ON "token_costs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pension_cases_tenant" ON "pension_cases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pension_findings_case" ON "pension_findings" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pension_actions_case" ON "pension_officer_actions" USING btree ("case_id");
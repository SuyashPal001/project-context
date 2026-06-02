CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('backlog', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'active', 'completed', 'archived');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"sequence_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "milestone_status" DEFAULT 'backlog' NOT NULL,
	"target_date" timestamp,
	"completed_at" timestamp,
	"assignee_id" uuid,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sequence_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "plan_status" DEFAULT 'draft' NOT NULL,
	"start_date" timestamp,
	"target_date" timestamp,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_counters" (
	"tenant_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_counters_tenant_id_resource_pk" PRIMARY KEY("tenant_id","resource")
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "sequence_id" integer;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_milestones_plan_status_idx" ON "project_milestones" USING btree ("plan_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_milestones_tenant_seq_uniq" ON "project_milestones" USING btree ("tenant_id","sequence_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_plans_tenant_status_idx" ON "project_plans" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_plans_tenant_seq_uniq" ON "project_plans" USING btree ("tenant_id","sequence_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_parent_task_id_agent_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_milestone_idx" ON "agent_tasks" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_plan_idx" ON "agent_tasks" USING btree ("plan_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_plan_id_project_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."project_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

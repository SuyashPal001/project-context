ALTER TABLE "agent_workflow_runs" ADD COLUMN "pending_approval" jsonb;--> statement-breakpoint
ALTER TABLE "agent_workflow_runs" ADD COLUMN "pending_approval_at" timestamp;
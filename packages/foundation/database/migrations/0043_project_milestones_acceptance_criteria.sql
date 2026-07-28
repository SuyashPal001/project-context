ALTER TABLE "project_milestones" ADD COLUMN IF NOT EXISTS "acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD COLUMN IF NOT EXISTS "estimated_hours" numeric(6, 2);

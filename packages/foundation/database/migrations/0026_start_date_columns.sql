ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS start_date timestamp;
ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS start_date timestamp;

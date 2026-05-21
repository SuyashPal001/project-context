ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS priority task_priority DEFAULT 'medium';
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS reference_text text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS embedding vector(768);

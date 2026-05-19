-- Add artifact_ref JSONB column to messages table
-- Stores { type, entityId, title } when an assistant message produced an artifact (PRD/roadmap/tasks)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS artifact_ref jsonb;

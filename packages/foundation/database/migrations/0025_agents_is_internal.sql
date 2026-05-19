ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

-- Mark internal agents by name
UPDATE agents SET is_internal = true
WHERE name IN ('Saarthi PRD', 'Saarthi Roadmap', 'Saarthi Task', 'formatter');

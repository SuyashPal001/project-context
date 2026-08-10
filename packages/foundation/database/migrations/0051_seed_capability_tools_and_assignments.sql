-- Insert the two platform-wide agent_tools rows (idempotent — matches on name+tenant_id IS NULL,
-- since agent_tools has no unique constraint on name alone, unlike role_permissions).
INSERT INTO "agent_tools" ("tenant_id", "name", "display_name", "description", "provider", "stakes", "requires_approval", "parameters_schema")
SELECT NULL, v.name, v.display_name, v.description, NULL, 'low', false, v.parameters_schema::jsonb
FROM (VALUES
  ('start_task', 'Start Task', 'Fetch everything needed to start work on a task: title/description/status, resolved plan steps, linked project context, and repo reference.', '{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}'),
  ('get_task_thread', 'Get Task Thread', 'Fetch the full comment history for a task.', '{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}')
) AS v(name, display_name, description, parameters_schema)
WHERE NOT EXISTS (
  SELECT 1 FROM "agent_tools" WHERE "name" = v.name AND "tenant_id" IS NULL
);
--> statement-breakpoint

-- Backfill agent_tool_assignments for every currently-active ops-agent/custom-agent agent,
-- for both new tools — so existing agents aren't locked out the moment this ships.
-- Mirrors the 0050_grant_agent_tasks_read.sql precedent (auto-grant on backfill, explicit
-- tenant action required only for new agents going forward).
INSERT INTO "agent_tool_assignments" ("agent_id", "tool_id", "tenant_id")
SELECT DISTINCT a."id", t."id", a."tenant_id"
FROM "agents" a
INNER JOIN "memberships" m ON m."agent_id" = a."id" AND m."tenant_id" = a."tenant_id"
INNER JOIN "roles" r ON r."id" = m."role_id"
CROSS JOIN "agent_tools" t
WHERE r."name" IN ('ops-agent', 'custom-agent')
  AND m."status" = 'active'
  AND t."name" IN ('start_task', 'get_task_thread')
  AND t."tenant_id" IS NULL
ON CONFLICT ("agent_id", "tool_id") DO NOTHING;

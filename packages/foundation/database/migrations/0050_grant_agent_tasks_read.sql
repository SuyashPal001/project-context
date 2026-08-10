-- Grant agent_tasks:read to the ops-agent and custom-agent platform roles.
-- Neither role's seed list included it, so no agent-type API key could pass
-- apiKeyAuthMiddleware's effectivePermissions intersection to reach the new
-- MCP start_task / get_task_thread tools — the role granted nothing to
-- intersect against. The seed file (role-permissions.ts) is updated for
-- fresh environments; this migration backfills already-seeded ones.

-- 1. Grant the role_permissions row. Idempotent via the table's
--    unique(role_id, permission_id) constraint.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" IN ('ops-agent', 'custom-agent')
  AND r."tenant_id" IS NULL
  AND p."resource" = 'agent_tasks'
  AND p."action" = 'read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint

-- 2. Backfill the frozen api_keys.permissions array for existing active
--    agent-type keys whose agent's role is now entitled to agent_tasks:read
--    but whose stored key string array doesn't have it yet. Unlike
--    0048_backfill_agent_key_permissions.sql (which only touched keys with
--    permissions = '{}'), this appends to whatever permissions a key already
--    has, since api_keys.permissions is a frozen snapshot taken at grant
--    time, not a live view of the role.
--
-- Joins through agents.api_key_id (NOT api_keys.agent_id, which no insert in
-- this repo ever populates — see 0048's note and apiKeyAuth.ts's agent
-- lookup for the same fix).
UPDATE "api_keys" AS ak
SET "permissions" = array_append(ak."permissions", 'agent_tasks:read')
FROM "agents" a
INNER JOIN "memberships" m ON m."agent_id" = a."id" AND m."tenant_id" = a."tenant_id"
INNER JOIN "roles" r ON r."id" = m."role_id"
WHERE ak."type" = 'agent'
  AND ak."status" = 'active'
  AND a."api_key_id" = ak."id"
  AND m."status" = 'active'
  AND r."name" IN ('ops-agent', 'custom-agent')
  AND NOT ('agent_tasks:read' = ANY(ak."permissions"));

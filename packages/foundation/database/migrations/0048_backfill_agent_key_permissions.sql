-- Freeze current effective access for every agent-type key that predates
-- permission-scope enforcement (empty permissions array = previously granted
-- the agent's full role, per the bug fixed in apiKeyAuthMiddleware).
-- Keys with a non-empty permissions array already reflect a real choice and
-- are left untouched.
UPDATE "api_keys" AS ak
SET "permissions" = role_perms.permission_strings
FROM (
  SELECT
    m."agent_id" AS agent_id,
    m."tenant_id" AS tenant_id,
    array_agg(DISTINCT (p."resource" || ':' || p."action")) AS permission_strings
  FROM "memberships" m
  INNER JOIN "role_permissions" rp ON rp."role_id" = m."role_id"
  INNER JOIN "permissions" p ON p."id" = rp."permission_id"
  WHERE m."status" = 'active'
  GROUP BY m."agent_id", m."tenant_id"
) AS role_perms
WHERE ak."type" = 'agent'
  AND ak."status" = 'active'
  AND ak."permissions" = '{}'
  AND ak."agent_id" = role_perms.agent_id
  AND ak."tenant_id" = role_perms.tenant_id;
--> statement-breakpoint

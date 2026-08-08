-- Freeze current effective access for every agent-type key that predates
-- permission-scope enforcement (empty permissions array = previously granted
-- the agent's full role, per the bug fixed in apiKeyAuthMiddleware).
-- Keys with a non-empty permissions array already reflect a real choice and
-- are left untouched.
--
-- Joins through agents.api_key_id (NOT api_keys.agent_id, which no insert in
-- this repo ever populates — see apiKeyAuth.ts's agent lookup for the same fix).
--
-- A key whose agent has no active membership, or whose role currently has zero
-- permissions, is intentionally left at '{}' — there is no current effective
-- access to freeze for it.
UPDATE "api_keys" AS ak
SET "permissions" = role_perms.permission_strings
FROM (
  SELECT
    a."api_key_id" AS api_key_id,
    array_agg(DISTINCT (p."resource" || ':' || p."action")) AS permission_strings
  FROM "agents" a
  INNER JOIN "memberships" m ON m."agent_id" = a."id" AND m."tenant_id" = a."tenant_id"
  INNER JOIN "role_permissions" rp ON rp."role_id" = m."role_id"
  INNER JOIN "permissions" p ON p."id" = rp."permission_id"
  WHERE m."status" = 'active'
  GROUP BY a."api_key_id"
) AS role_perms
WHERE ak."type" = 'agent'
  AND ak."status" = 'active'
  AND ak."permissions" = '{}'
  AND ak."id" = role_perms.api_key_id;

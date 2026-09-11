-- Any agent onboarded between 0091 and the PR 1 deploy got a 'default' row
-- but no system_prompt. Copy those before the rows go.
UPDATE "agents" a SET "system_prompt" = s."system_prompt"
FROM (
  SELECT DISTINCT ON (agent_id) agent_id, system_prompt
  FROM "agent_skills"
  WHERE name = 'default' AND install_id IS NULL AND status = 'active'
  ORDER BY agent_id, created_at DESC
) s
WHERE s.agent_id = a.id AND a.system_prompt IS NULL;
--> statement-breakpoint
-- The base prompt now lives on agents.system_prompt. No table references
-- agent_skills.id, so these rows can go. The sentinel is name='default' AND
-- install_id IS NULL together — a real installed skill whose manifest
-- happens to be named "default" is not this row and must survive.
DELETE FROM "agent_skills" WHERE name = 'default' AND install_id IS NULL;
--> statement-breakpoint
ALTER TABLE "agent_skills" DROP CONSTRAINT "agent_skills_agent_id_tenant_id_name_version_unique";--> statement-breakpoint
-- Installed rows take their manifest name. Task 4's reactivation keeps a row's
-- existing name, so this is where names are normalised. The old constraint is
-- already gone at this point; the NOT EXISTS guard stays as a belt-and-braces
-- skip for any row that would still clash on the same name and version.
UPDATE "agent_skills" s SET "name" = sv.manifest->>'name', "updated_at" = now()
FROM "skill_installs" si
JOIN "skill_versions" sv ON sv.skill_id = si.skill_id AND sv.version = si.installed_version
WHERE s.install_id = si.id AND s.status = 'active'
  AND coalesce(sv.manifest->>'name', '') <> '' AND s.name <> sv.manifest->>'name'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_skills" o
    WHERE o.agent_id = s.agent_id AND o.tenant_id = s.tenant_id
      AND o.name = sv.manifest->>'name' AND o.version = s.version AND o.id <> s.id
  );
--> statement-breakpoint
-- The new index allows one active hand-authored skill per name. Keep the
-- highest version where more than one is active.
UPDATE "agent_skills" SET "status" = 'archived', "updated_at" = now()
WHERE "id" IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY agent_id, tenant_id, name ORDER BY version DESC, created_at DESC
    ) AS rn
    FROM "agent_skills"
    WHERE install_id IS NULL AND status = 'active'
  ) d
  WHERE d.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_agent_authored_name_active_unique" ON "agent_skills" USING btree ("agent_id","tenant_id","name") WHERE install_id is null and status = 'active';

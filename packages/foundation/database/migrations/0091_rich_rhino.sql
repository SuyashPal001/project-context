ALTER TABLE "agents" ADD COLUMN "system_prompt" text;--> statement-breakpoint
-- Copy each agent's base prompt off its 'default' agent_skills row. Latest
-- active row wins, matching fetchAgentPersonaPrompt's old ORDER BY
-- created_at DESC LIMIT 1. The 'default' rows stay until migration 0092,
-- because the code running while this applies still reads them.
UPDATE "agents" a SET "system_prompt" = s."system_prompt"
FROM (
  SELECT DISTINCT ON (agent_id) agent_id, system_prompt
  FROM "agent_skills"
  WHERE name = 'default' AND status = 'active'
  ORDER BY agent_id, created_at DESC
) s
WHERE s.agent_id = a.id AND a.system_prompt IS NULL;
--> statement-breakpoint
-- Archive duplicate active attachments of the same install, keeping the
-- earliest. Dev has one: Olmo in yash-test holds install 006d2a14 twice.
UPDATE "agent_skills" SET "status" = 'archived', "updated_at" = now()
WHERE "id" IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY agent_id, install_id ORDER BY created_at ASC, id ASC
    ) AS rn
    FROM "agent_skills"
    WHERE install_id IS NOT NULL AND status = 'active'
  ) d
  WHERE d.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_agent_install_active_unique" ON "agent_skills" USING btree ("agent_id","install_id") WHERE install_id is not null and status = 'active';

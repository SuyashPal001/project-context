# Agent skills model: one job per table, and "/" that matches Anthropic

Date: 2026-09-11
Status: approved in brainstorming. Next step: an implementation plan.

## Problem

The chat composer shows chips that are not skills anyone picked for the message.
On dev, Olmo in `yash-test` shows four: `UGC Ad Production`, `ugc-ads-production`,
`design-taste` and `default`. Three separate defects produce them. They share one
root: `agent_skills` does three unrelated jobs. The native Mastra skills migration
(`2026-09-10-mastra-native-runtime-migration-design.md`) changed how skills are
*composed* for the model. It did not change what `agent_skills` stores, what
identifies an attached skill, or what `/` does.

### 1. The agent's base prompt is stored as a fake skill

Onboarding writes a row named `default` holding the agent's base prompt and a tool
list (`apps/api/src/routes/onboarding.ts`, nine inserts from line 201;
`packages/foundation/database/seeds/backfill-agents.ts:204`). Every reader must
remember to special-case the string `'default'`:

- The orchestrator does. `usage.ts:136` excludes it from attached skills, and
  `usage.ts:201` reads it back as the prompt override.
- `GET /agents/:id/skills` (`agent-skills.ts:71`) does not, so the composer shows
  a `default` chip.
- `DELETE /agents/:id/skills/:skillId` has no guard. Nothing in the web app calls
  it on that row today, but one API call would silently strip an agent's base
  prompt.

The override replaces the platform prompt outright (`platformAgent.ts`:
`override ?? await fetchPlatformPrompt()`). No screen edits it: it is a copy made
once at onboarding. On dev, 53 rows hold 22 distinct prompts, from different
agent types with the workspace name substituted.

### 2. Attached skills are identified by a free-text name

Two writers name the same install differently:

- The import worker auto-attaches using the manifest name
  (`skillImport.ts:186`, `${manifest.name}`), and writes no audit row.
- The skills page attaches using the display name (`actions.ts:86`,
  `name: skill.name`).

Uniqueness is `(agent_id, tenant_id, name, version)`, so both rows are allowed.
On dev, install `006d2a14` is attached to Olmo twice, 17 seconds apart:
`ugc-ads-production` at 08:20:39 from the worker, and `UGC Ad Production` at
08:20:56 from a human (audit row `agent_skill_created`). At runtime both rows
resolve to the same content and collapse under one Mastra skill name, but
`recordSkillRuns` counts the install twice per turn.

### 3. `/` is a permanent attach disguised as a per-message pick

Picking a skill in the composer calls `attachSkillToAgent`
(`ChatInput.tsx:482-483` to `:316`). It looks like "use this for my message" but
adds the skill to the agent for good. The orchestrator never loads a picked skill
for a turn: `skillsUsed` is only saved on the message for display
(`chatStream.ts:563`, `:605`). The model sees the skill only because it is now
permanently attached. The composer then renders every attached skill as a chip
on every chat (`ChatInput.tsx:175-186`), so every skill ever tried piles up.

### Also found

- The tool allowlist in `agent_skills.tools` is dead. Both runtime paths pass
  `enabledTools: null`, commented "has had no reader since platformAgent's tools
  resolver" (`tasks.execution.ts:79`, `documents.ts:213`). Onboarding and
  `integrations.sync.ts` still write it. The sync writes into the first
  unordered active `agent_skills` row of the first unordered active agent
  (`.limit(1)` twice), then calls `/update/:tenantId/:agentId`, a route the
  orchestrator does not have.
- The 24,000-character attach budget (`MAX_COMPOSED_SKILL_CHARS`, in
  `agent-skills.ts:19`, `skillImport.ts:46` and `createSkill.ts:12`) measured a
  prompt that native skills no longer build. The worker's version also counts
  the `default` row and duplicates.
- `Producer` in `Test team` has no `default` row, so it already runs on the
  platform prompt.

### Dev audit (read-only, 2026-09-11)

5 tenants, 53 non-retired agents. 52 have an active `default` row. One agent has
a duplicate install. 6 active non-default rows exist in total, all installed
skills. One `default` row has a non-empty `tools` list.

## How Anthropic does it

Checked against Anthropic's own documentation, 2026-09-11:

1. **Skills are installed once, in settings, not in the chat box.** In the Claude
   app they are toggled per account: "Disabled skills won't be available to
   Claude." In Claude Code, "Where you save a skill decides which sessions load
   it."
2. **An installed skill is available, not forced.** "Claude pre-loads the `name`
   and `description` of every installed skill into its system prompt", and "If
   Claude thinks the skill is relevant to the current task, it will load the
   skill by reading its full `SKILL.md` into context."
3. **`/skill-name` is explicit, and it holds for the conversation.** "Claude uses
   skills when relevant, or you can invoke one directly with `/skill-name`." The
   invocation changes nothing installed, and the content "stays in context
   across later turns."
4. **Per-skill controls exist.** `disable-model-invocation: true` makes a skill
   user-only; `user-invocable: false` makes it model-only. Out of scope here.
5. **Installed skills are not shown as chips in the composer.**

Mastra 1.64 already matches point 2 for attached skills: the agent "automatically
gets `skill`, `skill_read`, and `skill_search` tools so it can discover and load
skills during conversations" (`docs-skills.md`).

Sources:
- https://code.claude.com/docs/en/skills
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- https://support.claude.com/en/articles/12512180-use-skills-in-claude

## Decisions

| Question | Decision |
|---|---|
| Where the base prompt lives | `agents.system_prompt`, nullable. Null means the platform prompt, exactly as a missing `default` row does today |
| What identifies an attached installed skill | Its install. Unique on `(agent_id, install_id)` for active installed rows. The server takes the name from the manifest and ignores the client's |
| What identifies a hand-authored skill | Its name, as today. Only `create_skill` writes these |
| What `/` means | Turn a skill on for this conversation. It never attaches to the agent |
| Where invoked skills are stored | On the conversation's metadata, beside `testSkillInstallId` |
| How attached skills reach the model | Progressively: name and description, loaded when relevant |
| How invoked skills reach the model | Force-loaded: full instructions in every turn of that conversation |
| What the composer shows | Chips for skills invoked in this conversation. Never the agent's standing set, never `default` |
| Removing an invoked skill | The chip's X removes it from this conversation. An addition to Anthropic's model, kept because the composer shows chips and an unremovable chip confuses |
| Where the agent's standing skills are managed | The agent page, `AgentSkillSection.tsx`, which gains a detach control |
| A "Keep for this agent" action on `/` chips | No. Not Anthropic's model |
| The tool allowlist | Stop every write. Keep the column until the fairness routes stop reading it |
| The 24,000-character budget | Removed everywhere |
| The 8-skill cap | Kept per agent, as an abuse limit. The same cap applies to skills invoked in one conversation |

## Design

### 1. Storage

- **Base prompt.** Add `agents.system_prompt text` (nullable). Onboarding and
  `backfill-agents.ts` write it instead of inserting a `default` row.
  `fetchAgentPersonaPrompt` reads it. The `default` rows are copied over, then
  deleted.
- **Attached installed skills.** Add a unique index on
  `(agent_id, install_id)` where `install_id is not null and status = 'active'`.
  The attach route (`agent-skills.ts` POST) and the import worker both upsert on
  the install, and both take the row name from the manifest. A second attach of
  the same install is a no-op, not a second row.
- **Dead weight.** Remove the tool allowlist writes from onboarding,
  `integrations.sync.ts` (including its call to the missing `/update` route) and
  the import worker. Remove `MAX_COMPOSED_SKILL_CHARS` and every check against it.
- **Readers.** Every `name != 'default'` / `name = 'default'` check goes, because
  the row no longer exists. The fairness routes (`ops.fairness.ts:86`,
  `agents.fairness.ts:81`) read the prompt from `agents.system_prompt` instead of
  the `default` row.

### 2. `/` for a conversation, the composer, and the agent page

**In the orchestrator, per turn:**

1. `/` picks arrive in `skillsUsed`, as today: catalog skill ids sent by the
   client.
2. Each id is resolved to this tenant's own active install, with the tenant id
   from the verified token. An id without a matching active install for this
   tenant is dropped and logged. It never errors and never reaches another
   tenant's content.
3. The resolved installs are added to the conversation's invoked list, stored in
   conversation metadata through the same PATCH that sets `testSkillInstallId`.
   Each entry is `{ installId, skillId, name }`: `installId` is what the resolver
   loads, and `name` is the skill's display name, resolved on the server so the
   composer can label chips without a second lookup.
4. `fetchConversationTestSkillInstallId` becomes one fetch of the conversation's
   skill settings: the test skill as before, plus the invoked list. Still one
   request per turn.

**What reaches the model:**

- A Test-in-chat conversation still loads only its test skill. A `/` pick in a
  test conversation is recorded on the message but not loaded, because the test's
  one-skill isolation is the point of that conversation.
- Otherwise the agent's attached skills stay progressive, and the conversation's
  invoked skills are force-loaded into every turn. A skill both attached and
  invoked appears once.
- Resolution is fresh every turn, so an uninstalled skill drops out of active
  conversations on the next turn.

**Composer (`ChatInput.tsx`):**

- `/` no longer calls `attachSkillToAgent`. It adds a draft chip.
- After send, the chip becomes an "active in this chat" chip, read from the
  conversation's invoked list. Its X removes that entry through the conversation
  PATCH, for this conversation only.
- The `GET /agents/:id/skills` query that rendered attached skills as chips is
  removed.

**Agent page (`AgentSkillSection.tsx`):** lists attached skills, keeps the
existing attach picker, and gains detach through the existing `DELETE` route.

### 3. Data and rollout

Two migrations, because today's orchestrator reads the `default` rows. Deleting
them before new code is live would silently put every agent on the platform
prompt.

1. **Migration A, additive.** Add `agents.system_prompt`. Copy each agent's active
   `default` prompt into it. Leave the `default` rows in place. Safe while old
   code runs.
2. **Deploy the new code everywhere:**
   - the orchestrator;
   - the API Lambda: onboarding, the attach route, the conversation PATCH, the
     integration sync;
   - the worker Lambda: the import worker;
   - the web app: composer and agent page.

   This change needs a Lambda deploy. Rebuild the schema package's `dist/` first;
   a stale one ships silently.
3. **Migration B, cleanup:**
   - re-run the copy for any agent whose `system_prompt` is still null and has an
     active `default` row (a tenant onboarded between steps 1 and 2);
   - delete the `default` rows;
   - archive duplicate active installs per agent, keeping the earliest, and rename
     the kept row to its manifest name;
   - add the unique index.

Before applying either migration on dev, confirm which migrations are pending.
`0084` carries a hand-set `when` that sorts after `0085` and `0086`, and drizzle
skips anything older than the latest recorded migration.

## Testing

Unit tests, no database and no model call:

- Resolving `/` ids is tenant-scoped: another tenant's skill id is dropped.
- The resolver merges attached and invoked skills without duplicates.
- Test-in-chat still loads only its one skill.
- A second attach of the same install is a no-op, from both the route and the
  worker.
- `fetchAgentPersonaPrompt` reads `agents.system_prompt`.
- The composer renders only this conversation's chips, and X removes one.
- Detach on the agent page calls `DELETE` and removes the row from the list.

Done means these are observable on dev after Migration B:

1. 52 of 53 agents have `system_prompt` set. `Producer` in `Test team` stays null.
2. No `default` rows remain.
3. Olmo in `yash-test` has one UGC row.
4. A fresh chat's composer shows no chips.
5. A `/` pick shows a chip that survives a reload of that conversation, is absent
   from a new conversation, and never appears on the agent page.
6. The skill-used chip still appears on the message where the skill was invoked.

## Out of scope

- The per-skill controls `disable-model-invocation` and `user-invocable`.
- Resolving the base prompt from a template at runtime. Today a new platform
  template never reaches existing agents, because each agent holds a copy.
- Dropping the `agent_skills.tools` column. That needs the fairness routes
  cleaned up first.
- Separate memory per agent. Every agent in a workspace shares one memory record
  (`resource: tenantId`).

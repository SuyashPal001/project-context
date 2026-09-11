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
| What identifies an attached installed skill | Its install. Unique on `(agent_id, install_id)` for active installed rows. A newly inserted row takes the manifest's name, never the client's. A reactivated row keeps its existing name until migration 0092 normalises names, because renaming it while the old `(agent_id, tenant_id, name, version)` constraint still covers archived rows can collide permanently (found in Task 4's review). An insert that finds an archived row with the same name and version reuses it |
| What identifies a hand-authored skill | Its name, as today. Only `create_skill` writes these |
| What `/` means | Turn a skill on for this conversation. It never attaches to the agent |
| Where invoked skills are stored | On the conversation's metadata, beside `testSkillInstallId` |
| How attached skills reach the model | Progressively: name and description, loaded when relevant |
| How invoked skills reach the model | Natively. They join the resolver's skill set for the whole conversation, and on the invoking turn `prepareStep` forces the first step (one step per invoked skill) to call Mastra's own `skill` tool. The loaded instructions then stay in the conversation as a tool result. Nothing is pasted into the prompt by hand |
| What the composer shows | Chips for skills invoked in this conversation. Never the agent's standing set, never `default` |
| Removing an invoked skill | The chip's X removes it from this conversation. An addition to Anthropic's model, kept because the composer shows chips and an unremovable chip confuses |
| Where the agent's standing skills are managed | The agent page, `AgentSkillSection.tsx`, which gains a detach control |
| A "Keep for this agent" action on `/` chips | No. Not Anthropic's model |
| `/` inside a Test-in-chat conversation | Turned off, with a hint to start a normal chat. The orchestrator ignores `skillsUsed` there too |
| The tool allowlist | Stop every write. Keep the column until the fairness routes stop reading it |
| The 24,000-character budget | Removed everywhere |
| The 8-skill cap | Kept per agent, as an abuse limit. The same cap applies to skills invoked in one conversation |

## What is Mastra-native and what is ours

Checked against the installed `@mastra/core@1.64.0`, per the CLAUDE.md rule.

Native, used as-is: the per-request `skills` resolver, `createSkill()`, the
built-in `skill` / `skill_read` / `skill_search` tools (`workspace-*.js`,
`createSkillTool`), the per-call `prepareStep` and `toolChoice` options
(`agent.types.d.ts:548`, `:562`; `processors/index.d.ts:210-216`), and Memory
keeping tool results in the thread.

Ours, because Mastra has no equivalent for them:
- Resolving a client-sent skill id to this tenant's install. It is tenant data
  and a security boundary.
- The conversation's invoked-skill list. Mastra keeps loaded-skill thread state
  only inside `SkillSearchProcessor`, which requires a `Workspace`; our skills
  are agent-level and come through the resolver. The list also drives the
  composer chips.
- The one line naming which skills were invoked, so the forced `skill` call loads
  the right ones.

Rejected as hand-rolled: pasting an invoked skill's full instructions into the
prompt on every turn. An earlier draft of this spec did that; Mastra's `skill`
tool already provides it.

Evaluated and not used here: Mastra's editor (`MastraEditor`, already registered
in `mastra/index.ts`). Editor overrides are keyed by the code agent's id, and all
tenant agents run through one Mastra agent (`olmo`) with a per-request override,
so an editor override would change every tenant's agents at once. It cannot hold
a different prompt per agent row without turning each tenant agent into a stored
agent. The per-agent prompt is tenant data, so `agents.system_prompt` stays.

The editor did expose a second hand-rolled duplicate, left for its own spec:
`agent_templates` versions the platform prompt with its own draft / published /
archived status, and onboarding fills in `${workspaceName}` by hand. The editor
provides draft and publish versioning, reusable prompt blocks, `{{workspaceName}}`
template values from request context, and display conditions. A published block
also "reaches every agent that references its published version", which ends the
frozen copies noted under Out of scope. Decided 2026-09-11: a separate spec after
this one.

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
2. Each id is resolved to this tenant's own install, with the tenant id from the
   verified token. An id counts as resolved only when the install is active, its
   pinned version is ready, and its manifest body is non-empty: the same predicate
   the loader uses, so anything counted, forced, recorded or saved is guaranteed
   to load. Anything else is dropped. It never reaches another tenant's content.
   A database error returns `null`, distinct from "nothing resolved".
3. The resolved installs are added to the conversation's invoked list, stored in
   conversation metadata through the same PATCH that sets `testSkillInstallId`.
   Each entry is `{ installId, skillId, name }`: `installId` is what the resolver
   loads, and `name` is the skill's display name, resolved on the server so the
   composer can label chips without a second lookup.
4. `fetchConversationTestSkillInstallId` becomes `fetchConversationSkillSettings`,
   one fetch of the conversation's skill settings: the test skill as before, plus
   the invoked list, plus an `ok` flag. Still one request per turn.
5. The stored invoked list is never trusted as it is. The conversation PATCH
   accepts any uuid, so every turn the stored entries are re-resolved by `skillId`
   through the same tenant-scoped lookup, in parallel with this turn's picks.
   Forged, foreign or uninstalled entries drop out, and the list is saved back
   when something was newly invoked or the stored entries changed. Chip order is
   kept.
6. If the conversation read fails (`ok: false`) or either lookup returns `null`,
   the whole `/` step is skipped for that turn: nothing loads, nothing is recorded,
   nothing is saved. A transient failure can't wipe the list or open the
   Test-in-chat gate.

**What reaches the model:**

- A Test-in-chat conversation still loads only its test skill. `/` is turned off
  there (see Composer), and the orchestrator enforces the same rule: in a
  conversation with `testSkillInstallId` set, `skillsUsed` is neither loaded nor
  added to the invoked list, even if a client sends it.
- Otherwise the resolver returns the agent's attached skills plus the
  conversation's invoked skills, deduplicated by install. Both kinds are native
  Mastra skills (`createSkill`), listed to the model by name and description.
- On the turn a skill is invoked, the `stream()` call passes a `prepareStep` that
  returns `toolChoice: { type: 'tool', toolName: 'skill' }` for step numbers below
  the count of skills invoked that turn, and nothing after. One line in that
  turn's instructions names the invoked skills, so the forced `skill` calls load
  the right ones. Mastra's `skill` tool (`{ name }`) resolves against this
  request's skills and returns the instructions.
- After that turn nothing is forced. Mastra's own docs: "Loading is stateless. The
  instructions remain in the conversation as a tool result, and the agent can call
  `skill` again if they leave the context after compaction." That is Anthropic's
  "stays in context". The invoked skill stays in the resolver's set for the rest of
  the conversation, so it can be re-loaded. That matters here: a turn with no
  thinking budget sends no history (`chatStream.ts:300`, `lastMessages: false`),
  and older turns fall outside Olmo's 20-message window.
- Resolution is fresh every turn, so an uninstalled skill drops out of active
  conversations on the next turn. The loader, `fetchInvokedSkills`, re-checks each
  install tenant-scoped at load time as defense in depth; neither check is to be
  removed as redundant.
- The resolver reads invoked skills ONLY from the request-context key that
  `chatStream` sets after re-resolution. It never falls back to the conversation's
  stored metadata.

**Composer (`ChatInput.tsx`):**

- `/` no longer calls `attachSkillToAgent`. It adds a draft chip.
- After send, the chip becomes an "active in this chat" chip, read from the
  conversation's invoked list. Its X removes that entry through the conversation
  PATCH, for this conversation only.
- The `GET /agents/:id/skills` query that rendered attached skills as chips is
  removed.
- In a Test-in-chat conversation, `/` does not open the skill picker. A short hint
  says: "Test chats run one skill. Start a normal chat to combine skills." A test
  chat exists to show one skill on its own, and a pick that silently does nothing
  would be worse than no picker.

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
- On an invoking turn, `prepareStep` forces `toolChoice` to `skill` for exactly as
  many steps as skills were invoked, and returns nothing on later steps and on
  turns with no invocation.
- Test-in-chat still loads only its one skill, and ignores a `skillsUsed` sent
  into a test conversation.
- The composer does not open the `/` picker in a test conversation, and shows the
  hint instead.
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

## Known constraints

- The forced `/` invocation needs Mastra's eager `skill` tool. Mastra 1.64 drops
  that tool when an on-demand `SkillSearchProcessor` is configured
  (`suppressEagerSkillTools`). Adding one to Olmo would break `/`: the forced call
  would target a tool that no longer exists.
- The `/` path runs only on the SSE chat route. The WebSocket route never resolves
  `/` picks, the same known gap as the sub-agent control plane's inert WebSocket
  path.

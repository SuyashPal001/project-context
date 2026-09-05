# In-conversation skill creation

Date: 2026-09-05
Status: approved for planning

## Problem

Skills can only be created from the Skills dashboard: open a dialog, type a
brief, wait for a draft, save. But the moment a skill is most obviously worth
writing is in the middle of a conversation — the user has just spent ten turns
teaching the agent how their RFP responses open, which tone their client
tolerates, what never to promise. That knowledge is in the thread, and the only
way to keep it is to leave the conversation, re-describe it to a dialog, and
hope the second telling is as good as the first.

A skill is a page in a manual the agent reads. The agent should be able to write
that page while the lesson is still in front of it.

## Goal

`create_skill` — a tool the agent calls when the user asks it to save what it
just learned. The agent writes SKILL.md itself, shows it for confirmation, and
on approval the skill is created, installed, and attached to the agent in that
conversation.

## Non-goals

- The agent deciding on its own to create skills. The tool fires only on an
  explicit user request. No "I noticed you repeat this — shall I save it?".
- A slash-command registry. `/create-skill` typed in the composer is just text
  the model reads; `SlashPalette` today lists agents, not commands, and building
  a command system is its own project.
- Editing or versioning an existing skill from chat. Create only.
- A delete-skill endpoint (see Known gaps).
- Create Expert — brief-to-persona agent creation. Separate spec; it depends on
  the composition change here.

## Decisions taken

| Question | Decision |
|---|---|
| Who writes the SKILL.md | The agent, inline, as a tool argument — not a second model call |
| Trigger | Explicit user request only |
| Gate | The existing generation-confirm card, extended with a non-priced mode |
| On approval | Created, installed, and attached — live from the user's next message |
| Multiple attached skills | Composed into the prompt, capped by count and characters |
| Visibility | `private`, as today. Nothing chat-authored is published automatically |

## The landmine this uncovers

`fetchAgentSkill` (`apps/agent-orchestrator/src/usage.ts:47`) reads:

```sql
SELECT system_prompt, tools, config, install_id FROM agent_skills
WHERE agent_id = $1 AND status = 'active'
ORDER BY version DESC, created_at DESC LIMIT 1
```

**Only one attached skill has ever reached the prompt.** Every additional
`agent_skills` row is silently ignored, and the newest one wins. Attaching a
skill mid-conversation would therefore switch off whatever skill the agent was
already running — the user would experience it as the agent forgetting what it
knew.

Nothing in this feature works honestly without fixing that, so the fix is part
of this spec rather than a follow-up.

### Composition rules

- All `status = 'active'` rows for the agent, ordered by `created_at ASC` —
  attachment order, stable across turns so the prompt does not reshuffle between
  messages.
- Cap: **8** attached skills per agent, and **24,000 characters** of composed
  skill text total.
- Exceeding either cap **rejects the attach** with a specific error. A skill is
  never silently truncated into the prompt: half a manual page is worse than
  none, and the failure must be visible at attach time, not diagnosed later from
  bad output.
- `recordSkillRun` currently increments the single install that won the
  `LIMIT 1`. It must fan out to every composed install, or per-skill run counts
  become fiction the moment an agent has two skills.

### Migration risk, stated plainly

Existing agents that already have several `agent_skills` rows will change
behavior on deploy: skills that were being ignored start applying. This is the
only part of this work that alters agents nobody edited. Before deploying, count
affected agents:

```sql
SELECT agent_id, count(*) FROM agent_skills WHERE status = 'active'
GROUP BY agent_id HAVING count(*) > 1;
```

If that set is large or contains agents with contradictory skills, land the
composition change on its own, watch it, then ship the tool.

## Architecture

```
chat turn
   │
   ├─ user: "save that as a skill"
   │
   ├─ agent calls create_skill { name, description, body }
   │        │
   │        ├─ validate frontmatter locally      → invalid: tool error, agent retries
   │        ├─ filterPII(body)                   → detections attached to the card
   │        ├─ confirmGenerationOrDecline(alwaysAsk: true)
   │        │        │
   │        │        └─ SSE card → user approves / declines / times out
   │        │
   │        └─ POST /api/v1/internal/skills   (x-internal-service-key)
   │                 │
   │                 ├─ resolveUserPermissions → enforce skills:create
   │                 ├─ daily quota check
   │                 ├─ idempotency key lookup
   │                 ├─ insert skill + createVersionAndEnqueue({type:'authored'})
   │                 ├─ insert skill_installs row
   │                 └─ enqueue carries attachToAgentId
   │
   └─ worker: skill.import → parse → S3 → status ready → attach agent_skills row
```

### 1. The tool — `apps/agent-orchestrator/src/mastra/tools/createSkill.ts`

Arguments: `{ name, description, body }`. The agent writes the body; the tool
description carries the format contract that `parseSkillManifest` enforces (a
`---` YAML frontmatter block with `name` and `description`, then instructions
addressed to an agent). The same contract already lives in
`src/skills/generationPrompt.ts` — the tool description references those rules
rather than restating them differently, so the two cannot drift apart.

**No second model call.** The agent is already a model holding the conversation
that motivated the skill. Asking another model to write a document this one
could write is a wasted hop, a second debit, and a lossy re-telling.

Before anything else the tool:

- validates the frontmatter locally, returning a tool error the agent can act on
  immediately rather than a `failed` version row discovered minutes later;
- rejects a body over 64KB, matching the API's cap;
- requires a live SSE session (`sendEvent`, `sessionId`, `tenantId`, `userId`).
  Without one it returns an error. See "Silent approval" below — inheriting the
  gate's default here would mean unattended library writes.

### 2. The confirm gate gains a non-priced mode

`confirmGenerationOrDecline` returns `confirmed: true` early in two cases: the
tenant is unlimited, and no `credit_rates` row matches the resource. It is a
*spend* gate. Skill creation costs nothing, so as written it would auto-approve
and never show a card.

Add an `alwaysAsk` option that skips both early returns and goes straight to the
card. The alternative — seeding a ¢0 `credit_rates` row so the rate lookup
succeeds — puts a non-price in a pricing table, where someone will eventually
tidy it away and silently disable the gate.

`allowMode: 'auto'` is still respected: a user who turned on auto-allow has
consented, and no card is shown. This is a stated property, not an accident.

The card shows the skill name, the first lines of the body, and any `filterPII`
detections.

### 3. `POST /api/v1/internal/skills`

New route in `products/agent-platform/packages/api/routes/internal/skills.ts`,
mounted through `mountInternalRoutes`. Authorized by `isAuthorized()` from
`internal/tasks.auth.ts` (timing-safe comparison, already written).

Body: `{ tenantId, userId, agentId, conversationId, messageId, name, description, body }`.

It does what the public `POST /skills` does — insert the skill row, then
`createVersionAndEnqueue` with `{ type: 'authored', body }` — plus four things
the public route gets from middleware it does not have:

- **Permissions.** `resolveUserPermissions(userId, tenantId)` then enforce
  `skills:create`. Without this, a viewer-role user who cannot create a skill in
  the UI creates one by asking in chat. The service key authenticates the
  *service*, never the person.
- **Quota.** 20 chat-created skills per tenant per day. There is no `skills`
  entitlement in the features seed, so nothing else bounds this.
- **Idempotency.** Key derived from `conversationId + messageId + name` via
  `packages/foundation/idempotency`. Slugs carry a random suffix, so no database
  constraint catches a duplicate — a retried tool call would otherwise create a
  second skill.
- **`createdBy`** is the real acting user (`skills.createdBy` is an FK to
  `users`), which is also the honest attribution: the person asked for it.

It creates the `skill_installs` row itself. Install is not a separate user
action here.

### 4. Attach happens in the worker, not by polling

The version is `pending` until the import worker finishes, and attach against a
pending version returns `NOT_READY` (`agent-skills.ts:137`). So the queue message
carries `attachToAgentId`, and `skillImport.ts` inserts the `agent_skills` row
after the version reaches `ready`.

This is better than polling from the tool: the attach survives the user closing
the tab, and there is no arbitrary timeout to tune. The worker already owns the
`pending → ready` transition; attaching is one more thing that happens at that
moment.

The worker is also the right place because it already holds what the row needs:
`agent_skills.system_prompt` is the parsed manifest body it just wrote, and
`agent_skills.version` must be the version it just marked ready — the table's
unique constraint is `(agent_id, tenant_id, name, version)`, so getting the
version wrong turns a legitimate re-attach into a constraint violation.

**The skill is live from the user's next message, not the current reply.**
Skills are read once at stream start (`chatStream.ts:251`), so the reply that
creates a skill cannot be shaped by it. The tool's success message says so
explicitly — otherwise the next answer looks broken.

## Error handling

| Failure | Behaviour |
|---|---|
| Invalid frontmatter | Tool error naming the missing field; agent rewrites and retries |
| Body over 64KB | Tool error before any write |
| No live SSE session | Tool refuses — no unattended library writes |
| User declines | Tool returns a terminal "not created"; the tool description tells the agent not to retry a decline |
| Confirm timeout (5 min) | Treated as a decline, same terminal result |
| `CONFIRM_BUSY` (one pending confirm per session) | Terminal error the agent reports; never a retry loop |
| Caller lacks `skills:create` | 403 from the internal route; agent tells the user their role can't create skills |
| Daily quota reached | 429; agent reports the cap |
| Duplicate (idempotency hit) | Returns the original skill; no second row |
| Import worker fails | Skill shows `failed` on the Skills page with the existing toast; no attach row is written |
| Attach would exceed 8 skills or 24,000 chars | Skill is still created and installed; attach is refused with a specific message naming the cap |

## Testing

- **Composition** (`usage.ts`): two active skills compose in `created_at` order;
  8-skill and 24,000-character caps reject rather than truncate; `recordSkillRun`
  increments every composed install, not just one.
- **Tool**: frontmatter validation; oversized body; missing `sendEvent` refuses;
  decline and `CONFIRM_BUSY` return terminal results; PII detections reach the
  card payload.
- **Confirm gate**: `alwaysAsk` reaches the card for an unlimited tenant with no
  matching rate row — the case that silently auto-approves today.
- **Internal route**: wrong/missing service key rejected; a user without
  `skills:create` gets 403; quota returns 429 at the cap; the same
  conversation+message+name returns the first skill rather than creating a
  second; the enqueued message carries `attachToAgentId`.
- **Worker**: a payload with `attachToAgentId` writes exactly one `agent_skills`
  row after the version reaches `ready`, and none when the import fails.

## Known gaps, deliberately not fixed here

- **No delete.** Nothing in the API deletes a skill; the Skills page filters dead
  rows rather than removing them. A badly-created skill is permanent tenant
  clutter, and chat makes creation cheaper, so this gets worse before it gets
  better. Worth its own small piece of work.
- **`filterPII` does not cover credentials.** Its rules are India identity
  patterns — email, phone, Aadhaar, PAN, passport, voter ID. A pasted API key in
  a conversation can reach a skill body untouched. The confirmation card is the
  real control, and the spec does not pretend otherwise.
- **The confirm card is not persisted without an `idToken`**, so in
  service-initiated conversations it exists only live.
- **Composition caps are judgment, not measurement.** 8 skills and 24,000
  characters are a first guess at a sane prompt budget; revisit once real agents
  carry real skill sets.

## Deployment

Order matters, and this touches all three surfaces:

1. `sam deploy` — the internal route and the worker's attach branch. Rebuild
   `products/agent-platform/packages/*` first or a stale `dist/` ships silently.
2. `pm2 restart agent-orchestrator` on the VM, by hand — the tool, the gate
   change, and the composition change all live there. `./deploy.sh` does not
   touch it.
3. `./deploy.sh` — only if the confirm card's rendering changes.

The composition change takes effect the moment the orchestrator restarts. Run
the affected-agent query above before that restart, not after.

# Skill authoring — create a skill from a brief

Date: 2026-09-05
Status: approved for planning

## Problem

The Skills dashboard's only entry point is **+ Import skill**, which asks the
user for a zip, a GitHub repo, or a URL. Every one of those presupposes that a
skill package already exists somewhere — that the user has authored SKILL.md by
hand, in the right format, and packaged it. Nobody on a content team does that.

Skills are the product's moat, and the dashboard is where a tenant meets them.
Import is a developer's on-ramp on a page that is not for developers. It belongs
in the dev studio, which does not exist yet.

## Goal

The Skills page offers **+ Create skill**: the user describes what the skill
should teach the agent, an agent writes SKILL.md, the user reviews it and saves.
The user never learns the skill file format.

## Non-goals

- Editing SKILL.md by hand in the dialog. The generated draft is accepted,
  regenerated, or discarded — nothing else. A hand editor is a separate decision.
- Multi-file packages. A created skill is exactly one SKILL.md. Import already
  covers multi-file packages and stays capable of it.
- Editing or regenerating an existing skill into a version 2. Create only.
- Building the dev studio, or moving the import UI into it.
- Deleting the import backend. It stays, whole and tested, with no UI.

## Decisions taken

| Question | Decision |
|---|---|
| Who writes SKILL.md | An agent, from the user's brief |
| Fate of import | Hide the UI; keep routes, worker, and dialog file on disk |
| Where generation runs | agent-orchestrator, streamed to the dialog |
| Package contents (v1) | SKILL.md only |
| Credits | Debited like a chat turn |
| Visibility on save | `private` — the existing default. No publish toggle in the dialog; the detail modal's existing publish action covers it |

## Architecture

Four surfaces change. Three of them are small; the fourth (save) is deliberately
a one-branch addition to code that already works.

```
Skills page ──POST /api/skills/generate──▶ agent-orchestrator (VM :3001)
  (brief)     ◀────── SSE text deltas ─────  streamText via inference-gateway
                                             debitChatTurn on completion
     │
     └──POST /api/v1/skills {source:{type:'authored',body}}──▶ API Lambda
                                                                │
                                             SQS skill.import ──┘
                                                    │
                                        TaskWorker → skillImport.ts
                                        authored branch → one SKILL.md entry
                                        → parse manifest → S3 → status 'ready'
```

### 1. Skills page (`apps/web/app/[tenant]/dashboard/skills/page.tsx`)

- Header button becomes `+ Create skill`, opening `CreateSkillDialog`.
- `ImportSkillDialog` import, its `importOpen` state, and its JSX are removed.
- Subtitle: "Create, install, and share reusable skill packages".
- `mine` empty state: "No skills yet — create one to get started."
- `ImportSkillDialog.tsx` and the three `createSkillFrom*` actions stay on disk,
  referenced by nothing, each carrying a header comment saying they are parked
  for the dev studio and why. Their tests stay green.

Everything else on the page — polling, the dead/stuck filter, the failure toasts,
`SkillGrid` — is untouched. An authored skill passes through the same
`pending → ready` states as an imported one, so all of it already applies.

### 2. `CreateSkillDialog` (`apps/web/components/platform/skills/CreateSkillDialog.tsx`)

Two steps in one dialog.

**Brief.** Skill name (required), one-line description (optional), and a
textarea: "What should this skill teach the agent?" with placeholder text
showing a real example. Primary action: Generate.

**Preview.** The generated SKILL.md streams into a read-only monospace pane as
it arrives. Actions:

- **Regenerate** — reveals a one-line feedback input ("what should change?") and
  re-runs generation with the brief, the previous draft, and the feedback.
- **Save skill** — posts the draft, closes, invalidates `["skills"]`.
- **Cancel** — discards. Generation already charged; the dialog says so only if
  the user has generated more than once, to avoid alarming copy on the common path.

Name and description shown on the preview come from the generated frontmatter,
read-only. The user's typed name seeds the prompt; the model's frontmatter is
what gets stored, and the server derives the slug from it as it does today.

Errors surface inline in the dialog: a failed stream, a 402 from the credit
check, or a save rejection each leave the draft intact and retryable.

### 3. Generation route (`apps/agent-orchestrator/src/routes/skills.ts`)

New Hono router, mounted `app.route('', skillsRouter)` in `app.ts` beside the
others.

`POST /api/skills/generate`

- Auth: `Authorization: Bearer <jwt>` → `validateToken`, tenantId read from the
  `custom:tenantId` claim — never from the body. Same shape as
  `routes/explanation.ts`.
- Body: `{ name, description?, brief, previousDraft?, feedback? }`.
- Model: `streamText` from `ai` against `platformModel`
  (`src/mastra/model.ts`) — the `@ai-sdk/openai-compatible` client pointed at
  the inference gateway on :4001. Not `llm/quickCall.ts`, which calls Vertex
  directly and would bypass the gateway's adapter chain and metering.
- Response: SSE, `delta` events carrying text, then a terminal `done` event.
  A `error` event carries a user-safe message.
- System prompt pins the contract that `parseSkillManifest` enforces: a `---`
  YAML frontmatter block with `name` and `description`, then a body written as
  instructions addressed to an agent, not documentation addressed to a human.
  Getting this right at generation time is what keeps the save path from
  producing `failed` versions.

On stream completion, beside each other, matching `chatStream.ts`'s post-turn
block:

- `persistCost` / `recordUsage` for the usage row.
- `debitChatTurn({ tenantId, agentId: 'skill-generator', messageId:
  'skillgen:<uuid>', model, inputTokens, outputTokens })` — fire-and-forget by
  contract, never throws out. `agentId` is a required non-null string on
  `DebitChatTurnArgs` and is only carried into the ledger entry's metadata, so a
  sentinel is honest here: no agent ran this turn.

Each Regenerate is a fresh debit. At `gemini-2.5-flash` rates (15 credits/1M in,
60/1M out) a generate is roughly 0.135 credits — about 0.14¢ of inference. The
debit exists so the endpoint is not an unmetered LLM per tenant, not for revenue.

### 4. Save (`products/agent-platform/packages/api/routes/skills.ts` + worker)

`POST /api/v1/skills` gains a fourth source variant:

```ts
z.object({ type: z.literal('authored'), body: z.string().min(1).max(65_536) })
```

The route is otherwise unchanged: it creates the skill row, calls
`createVersionAndEnqueue`, and returns. `sourceRef` for an authored version is
`null`; `sourceType` is `'authored'`.

`skillImport.ts`'s `extractForSource` gains an `authored` branch returning
`{ entries: [{ fileName: 'SKILL.md', buffer: Buffer.from(source.body) }],
manifestSource: source.body, skipped: [] }`. Everything downstream — manifest
parse, S3 write under `skill-packages/{skillId}/{version}`, the `ready`
transition, the `latestVersion` bump, sanitised failure reasons, the audit row —
runs unchanged.

**Why route authored content through the import worker rather than writing S3
from the Lambda:** `parseSkillManifest` and the version state machine live in
`worker-handlers`. Writing files from the API route would mean either the API
Lambda importing the worker package (dragging its SQS and extraction deps into
the bundle) or a second copy of the manifest parser that can drift from the one
the runtime trusts. The worker branch is about ten lines and reuses tested code.

The cost is that Save leaves the card `pending` for a second or two before it
turns ready. The page already polls for exactly this and already handles a
stuck or failed import, so the behaviour is free.

**Migration.** `skill_source_type` gains `'authored'`:
`ALTER TYPE skill_source_type ADD VALUE 'authored'` via `drizzle-kit generate`
against the updated enum in `products/agent-platform/packages/schema/skills.ts`.

## Error handling

| Failure | Behaviour |
|---|---|
| No/invalid JWT on generate | 401, dialog shows "Session expired — sign in again" |
| Gateway down / stream dies mid-draft | `error` SSE event; partial draft stays on screen, Regenerate offered |
| Model emits SKILL.md without valid frontmatter | Save succeeds, version goes `failed` with the existing sanitised reason, card is filtered by the page's dead-skill rule, failure toast fires. Prompt design is the mitigation; the fallback is the one already shipped |
| Body over 64KB | 400 `VALIDATION_ERROR` before anything is created |
| Credit debit fails | Swallowed and logged, per `debitChatTurn`'s contract — never breaks a delivered draft |
| Duplicate slug for tenant | Existing unique-constraint path, unchanged |

## Testing

- `products/agent-platform/packages/api/__tests__/skills.test.ts` — authored
  source accepted and enqueued with `sourceType: 'authored'`; a body over 64KB
  rejected 400; a non-authored source still behaves as before.
- `products/agent-platform/packages/worker-handlers/__tests__/skillImport.test.ts`
  — authored payload writes exactly one `SKILL.md` and reaches `ready`; a body
  with no frontmatter reaches `failed` with a sanitised reason.
- Orchestrator route test — missing token → 401; tenantId comes from the claim
  even when the body carries a different one; a completed stream calls
  `debitChatTurn` once with the right token counts (injected deps, as
  `credits.ts` is written for).
- Web — `CreateSkillDialog` renders brief → preview → save and posts the
  authored source; the Skills page no longer offers import.

## Deployment

Three surfaces, deployed independently, all required:

1. `sam deploy` for the API Lambda and TaskWorker — rebuild
   `products/agent-platform/packages/*` and `packages/foundation/*` first, or a
   stale `dist/` ships silently.
2. `pm2 restart agent-orchestrator` on the VM by hand — `./deploy.sh` does not
   touch it.
3. `./deploy.sh` for the web frontend.
4. Run the enum migration before the Lambda deploy that references `'authored'`.

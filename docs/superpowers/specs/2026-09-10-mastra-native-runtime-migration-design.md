# Move agent runtime onto native Mastra primitives (skills, suspend/resume, workflows)

Date: 2026-09-10
Status: approved for planning

## Problem

`@mastra/core` is already on 1.64.0 in this repo (`apps/agent-orchestrator`).
That version ships three primitives this codebase re-implemented by hand
instead of using, found via a targeted audit this session (triggered by a
real bug: skill attachments accumulating on an agent forever, contaminating
unrelated "test one skill" sessions):

1. **Skills.** `agent_skills` (DB table) + `usage.ts`'s `fetchAgentSkills`
   concatenate every active row — including the `default` persona
   bootstrap row — into one string, force-fed into `instructions` on every
   turn. No per-request scoping exists: attaching a skill is permanent and
   agent-wide, there is no way to try one skill in isolation, and a hard
   cap (`MAX_ATTACHED_SKILLS = 8`, `MAX_COMPOSED_SKILL_CHARS = 24_000`)
   exists purely to bound this hand-rolled composition. Mastra ships a
   native per-request `skills: ({ requestContext }) => SkillInput[]`
   resolver (`docs-skills.md`) plus automatic `skill` / `skill_read` /
   `skill_search` tools — the model pulls in one skill's content on demand
   instead of everything being pasted into context every turn.

2. **Pause-and-wait-for-a-human, in chat.** `confirmGeneration.ts`'s
   `confirmGenerationOrDecline` — called from inside chat tool calls
   (`generateImage`, `generateVideo`, `generateSong`, `createSkill`'s
   `alwaysAsk` path) — hand-rolls a suspend: a
   `pendingGenerationConfirmations` in-memory Map, a manual 5-minute
   `setTimeout`, an SSE push to show the approval card, and a wait for the
   Map entry to resolve. **Corrected after Opus review of this spec
   against the actual docs**: chat tool calls run through `agent.stream()`,
   not a workflow, so there is no workflow step to suspend here. Mastra
   ships a *separate* native mechanism for exactly this —
   `docs-agents-human-in-the-loop.md`: a `tool-call-approval` stream chunk,
   `agent.approveToolCall({ runId })` / `agent.declineToolCall({ runId, reason })`,
   and three places to demand approval from (confirmed against the
   installed bundle, see Finding 7 of
   `docs/superpowers/specs/2026-09-10-subagent-control-plane-design.md`):
   a stream-level `requireToolApproval` on `agent.stream()`, a static
   `requireApproval: true` on `createTool()`, or a per-call
   `needsApprovalFn(args, ctx)` on the tool itself. **This spec places the
   rule on the tool (`needsApprovalFn`), not on the stream** — see Design
   section 2 for why. The existing `isUnlimited`/`resolveRate`/`alwaysAsk`/
   `allowMode` logic (all already reachable from `requestContext`) becomes
   the body of `needsApprovalFn`, evaluated pre-execution, in place of the
   hand-rolled Map.

3. **Multi-step execution, in the Tasks feature.** `mastra/workflow.ts`'s
   `runMastraWorkflow` (called from `routes/tasks.workflow.ts`, itself
   invoked by `POST /workflows/execute` in `routes/tasks.ts` — PRDs,
   roadmaps, any planned multi-step work) is a hand-written loop over
   `steps[]`, calling `agent.generate()` per step and branching in plain
   JS. No persisted run state — a crash mid-run loses all progress,
   nothing survives to resume from. **Corrected after review**: this is
   narrower than it first looked. `mastra/index.ts` already registers 7
   native Mastra workflows (`taskExecution`, `documentWorkflow`,
   `documentIngestion`, `prd`, `roadmap`, `tasks`, `pm-workflow`), and one
   of them — `pmWorkflow.ts`'s `prdStep` — already does suspend/resume
   correctly today:
   `execute: async ({ inputData, resumeData, suspend, suspendData, ... }) => { ...; return await suspend({ phase: 'prd', prdId, title }) }`
   with `resumeSchema`/`suspendSchema` declared on the step. That's the
   real, working pattern to follow — `runMastraWorkflow` in
   `mastra/workflow.ts` is the one hand-rolled outlier, not evidence native
   workflows are unused here.

Also audited and confirmed **not** duplicated (native Mastra used
correctly, no change needed): `memory.ts` (native `Memory` class),
`guardrails.ts` (native processor violation hooks), `platformAgent.ts`'s
`tools:` field (already the same per-request dynamic-resolver shape skills
should have used), and the 6 workflows listed above other than
`runMastraWorkflow`/`pm-workflow`'s already-correct suspend usage.
`registry.ts`'s static per-conversation agent router resembles Mastra's
native Subagents feature but solves a different problem (binding once to a
conversation's fixed agent, not runtime model-driven delegation) —
flagged, not changed by this spec.

## Goal

- A skill attached via the dashboard/`/` picker stays exactly as
  permanent, agent-wide behavior it is today — but is composed through
  Mastra's native `skills:` resolver, not a hand-built string.
- "Test in chat" tests exactly one skill, scoped to that one conversation,
  touching nothing else attached to the agent — via the same native
  resolver, fed a conversation-scoped override instead of a DB attach.
- The agent's persona (`default` row) is structurally isolated from
  skills — no skill's content can ever land in `instructions`.
- `confirmGenerationOrDecline`'s pause mechanism moves onto Mastra's native
  tool-level approval (`needsApprovalFn` on `generateImage`/`generateVideo`/
  `generateSong`), and `runMastraWorkflow`'s step execution moves onto
  Mastra's native workflow suspend/resume — two different native
  mechanisms for two genuinely different call sites (a chat tool call vs.
  a workflow step), replacing two separate hand-rolled ones with the two
  matching native ones, not one shared mechanism.
- Credit/billing logic (`isUnlimited`, `resolveRate`, `chargeTaskEstimate`,
  `settleTask`/`refundTask`) is untouched — only the execution/pause
  plumbing underneath it changes.

## Non-goals

- Rewriting the skills catalog/marketplace (`skills`, `skill_versions`,
  `skill_installs` tables, the dashboard Skills page, import/publish
  flows). Those stay exactly as they are — this spec only changes how an
  already-installed skill's content reaches the agent at runtime.
- `registry.ts`'s agent router — flagged as a maybe against Subagents, not
  a confirmed duplicate. Separate investigation if picked up later.
- The 6 already-native workflows other than the `runMastraWorkflow` path
  (`taskExecutionWorkflow`, `documentWorkflow`, `ingestionWorkflow`,
  `prdWorkflow`, `roadmapWorkflow`, `taskWorkflow`) and `pmWorkflow.ts`'s
  existing correct suspend/resume — all untouched, already right.
- Any change to `cost.ts`, `thinking.ts`, `composio.ts`, or the credit
  pricing/estimation logic in `tasks.ts` — all confirmed legitimate
  app-specific logic with no Mastra equivalent.
- Retroactive data migration of existing `agent_skills.system_prompt`
  content — the resolver re-derives content fresh from `skill_installs`/
  `skill_versions` on every request, so nothing needs backfilling.

## Decisions taken

| Question | Decision |
|---|---|
| Does persona (`default` row) go through the skills resolver | No — stays read only by `instructions:` (`platformAgent.ts`), exactly as today. Skills resolver never sees it. |
| How does "Test in chat" scope to one skill | The web app creates the test conversation with `metadata.testSkillInstallId` set (already implemented this session in `actions.ts`/`conversations.ts` PATCH schema) — no agent-level attach at all. `chatStream.ts` reads it via `fetchConversationTestSkillInstallId` and passes it into `requestContext`; the `skills:` resolver returns only that one skill when present. |
| What happens to `agent_skills.system_prompt` | Stops being read for composition. The table keeps its role as "which skills are attached to this agent" (attach/detach, `installId`, `name`) but content is resolved fresh per-request from `skill_installs`/`skill_versions`, same pattern already built for the test path (`fetchTestSkillPrompt` in `usage.ts`). |
| What happens to `MAX_ATTACHED_SKILLS`/`MAX_COMPOSED_SKILL_CHARS` | Deleted. Nothing gets composed into one string anymore, so there's no char budget to enforce. A count cap on *attach* (not compose) may still be reasonable to prevent unbounded growth in the attach UI, but is a product decision, not carried over automatically — flagged as an open question below. |
| Does `confirmGenerationOrDecline`'s credit logic change | Moves up one level, not otherwise changed. Native approval is pre-execution — it pauses before the tool's `execute` runs at all — so `isUnlimited`/`resolveRate`/`alwaysAsk`/`allowMode` can't stay inside a function called from partway through execution like today. They become the body of `needsApprovalFn(args, ctx)` on the tool, which receives the same args and request context `confirmGenerationOrDecline` reads today. Same logic, same decision, evaluated one level up. |
| Where does the approval rule attach — stream, static tool flag, or per-call tool function | Tool-level `needsApprovalFn`, not stream-level `requireToolApproval`. Verified against the installed bundle (Finding 7, `2026-09-10-subagent-control-plane-design.md`): a stream-level rule does reach delegated sub-agent runs (it rides `requestContext` under `__mastra_requireToolApproval`, not among the four keys the delegation boundary strips at `agent-Dp3vcrIx.cjs:35119`, and Mastra escalates a suspended sub-agent's approval up to the parent via `isDelegatedApproval`/`suspendedToolRunId`/`requireApprovalMetadata[primitiveId]`) — but a tool-level rule holds in that case too, *and* keeps holding when a specialist later becomes an agent a user talks to directly, which a stream-only rule does not. Generation sits behind marketing specialists per the Olmo supervisor design, so tool-level is the durable placement. |
| Do workflow steps need their own agents | No. `createStep(existingAgent)` (needs a preceding `.map()` to shape input into `{ prompt }`, per `docs-workflows-agents-and-tools.md`) or calling `mastra.getAgent(name).generate()` inside a step's `execute()` both reuse the agents `registry.ts` already builds (`platformAgent`, `pmAgent`, `architectAgent`, `directorAgent`, `producerAgent`). |
| Does `runMastraWorkflow`'s approval gate share the same mechanism as `confirmGeneration` | No — different call sites, different native mechanisms. Chat tool calls (`confirmGeneration`) use tool-level `requireApproval`/`needsApprovalFn`; Tasks workflow steps use workflow `suspend`/`resume`, the exact pattern `pmWorkflow.ts`'s `prdStep` already uses correctly today. |
| Who cleans up an approval nobody answers | The watchdog (`WatchdogFunction`, already runs every 5 minutes over stalled tasks) — extended with a new case: a suspended run awaiting tool approval, untouched for N hours, distinct from "crashed". See Design section 2 and open question 2. |

## Design

### 1. Skills

```
instructions: async ({ requestContext }) => {
  // UNCHANGED — reads the agent's `default` agent_skills row only.
}

skills: async ({ requestContext }) => {
  const testInstallId = requestContext.get('testSkillInstallId')
  if (testInstallId) {
    const skill = await fetchTestSkill(testInstallId, tenantId) // one skill only
    return skill ? [skill] : []
  }
  return fetchAttachedSkills(agentId, tenantId) // every active non-default row
}
```

Both `fetchTestSkill` and `fetchAttachedSkills` return Mastra `Skill`
objects (via `createSkill({ name, description, instructions, ... })`),
resolving `instructions` fresh from `skill_installs` → `skill_versions`
(pinned version's manifest body) at request time — no stored composed
string anywhere.

`chatStream.ts` sets `requestContext.set('testSkillInstallId', ...)` when
`fetchConversationTestSkillInstallId` returns non-null (conversation-scoped,
read via the existing ownership-checked `GET /conversations/:id`), otherwise
leaves it unset so the resolver falls through to the agent's real attached
skills.

`startSkillTestChat` (web, already implemented) creates the conversation
with `metadata.testSkillInstallId` and does **not** call
`attachSkillToAgent` — no DB write to `agent_skills` for a test at all.

Attach (the `/` picker, dashboard Install) is unchanged in the web/API
layer — still writes an `agent_skills` row. What changes is only that the
row's `system_prompt` column stops being read (may stop being written too,
since nothing consumes it — implementation detail for the plan).

**Delegation caveat (Finding 1, `2026-09-10-subagent-control-plane-design.md`):**
the delegation boundary strips only four Mastra-internal keys from
`requestContext` (`MastraMemory`, `mastra__threadId`, `mastra__resourceId`,
`mastra__inheritedMemory`) — `agentId`, `agentName` and `agentSystemPrompt`
all pass through unchanged into a delegated sub-agent's run. A `skills:`
resolver that reads `agentId`, called inside a delegated run, resolves the
**parent's** attached skills, not the sub-agent's. Confirmed dormant today
— the four current Olmo delegates (`pmAgentDelegate`/`architectAgentDelegate`/
`directorAgentDelegate`/`producerAgentDelegate`) declare no `skills:` of
their own, so nothing calls this resolver from inside a delegated run yet —
but it bites the moment a delegate gains its own skills resolver, which the
Olmo supervisor design's marketing verticals will need. That design owns
the fix (`resolve.ts`'s identity rewrite in `onDelegationStart`); this spec
only flags it so the resolver isn't built on an assumption the control
plane spec already disproves.

### 2. Pause-and-wait-for-a-human (chat tool calls)

The `pendingGenerationConfirmations` Map becomes a persisted run snapshot
(Mastra's, not ours); the SSE `generation_confirm` push becomes a
`tool-call-approval` stream chunk carrying `toolCallId`, `toolName` and
`args`; resolving the Map entry becomes
`agent.approveToolCall({ runId })` / `agent.declineToolCall({ runId, reason })`.
`declineToolCall`'s `reason` is returned to the model in place of the tool
result — a real improvement over today's plain rejection, the model can
adjust instead of blindly retrying.

The rule that decides *whether* to pause goes on the tool, not the stream.
`createTool()` takes `needsApprovalFn(args, ctx)` — called with the tool's
own args and the request context, before `execute` runs at all — on
`generateImage`, `generateVideo`, `generateSong`, and `createSkill`'s
`alwaysAsk` path:

```
createTool({
  id: 'generateImage',
  // ...
  needsApprovalFn: async (args, { requestContext }) => {
    // today's confirmGenerationOrDecline body — isUnlimited/resolveRate/
    // alwaysAsk/allowMode — moved up one level: this runs BEFORE execute,
    // where confirmGenerationOrDecline used to run partway through it.
    // Reads requestContext exactly as it does today.
  },
  execute: async (args, ctx) => { /* unchanged tool body */ },
})
```

Why the tool and not `requireToolApproval` on `agent.stream()`: verified
against the installed `@mastra/core@1.64.0` bundle
(Finding 7, `2026-09-10-subagent-control-plane-design.md`) that a
stream-level rule *does* reach a delegated sub-agent's tool calls — it
rides `requestContext` under `__mastra_requireToolApproval`, a key the
delegation boundary does not strip, and Mastra escalates a suspended
sub-agent's approval up to the parent stream
(`isDelegatedApproval`/`suspendedToolRunId`/
`requireApprovalMetadata[primitiveId]`). But a tool-level rule holds in
that same case *and* keeps holding when a specialist later becomes an
agent a user talks to directly, with no chat stream re-establishing the
rule for it. Generation is going behind marketing specialists (Olmo
supervisor design), so the tool is the durable placement — `chatStream.ts`
attaches nothing approval-related to `agent.stream()` itself.

`confirmGenerationOrDecline` as a standalone function goes away — its body
splits across each gated tool's `needsApprovalFn`, not because the logic
changes, but because there's no longer a single call site to hold it.

Mastra requires a configured storage provider for this (snapshots hold the
resume state) — the repo already has one (`getMastraStore()`), so no new
infra needed. No built-in timeout exists on a pending approval (confirmed —
neither this doc, `run`, `step`, nor `workflow` references expose one), and
unlike the Map-based version, an unanswered native approval now persists
indefinitely instead of expiring after 5 minutes — a deliberate behavior
change (a deploy today kills every in-flight confirmation; after this it
won't) that trades a self-cleaning timeout for accumulating suspended
runs. Cleanup moves to an explicit sweep: `WatchdogFunction`, which
already runs every 5 minutes over stalled `in_progress` tasks, gets a new
case — a run suspended awaiting tool approval, untouched for N hours — a
different condition from "crashed," not something its existing stall
check covers. See open question 2 for the threshold.

### 3. Multi-step execution (Tasks)

`routes/tasks.ts`'s `POST /workflows/execute` stays as the entry point —
same request body, same credit estimate/charge before starting. Internally,
`runMastraWorkflowSteps` moves off the hand-written loop in
`mastra/workflow.ts` onto `createWorkflow`/`createStep`.

**The step list is data, not code — this rules out a declared step chain.**
`runMastraWorkflow` executes a plan generated per task, so `steps[]` differs
on every run. A `.then(step1).then(step2)` chain is a fixed graph written
at build time and can't express "however many steps this task's plan has."
Two shapes fit a dynamic step list:

- **`.foreach()` over the plan, inside one committed workflow.** The graph
  itself is fixed — "run the plan" — and the plan is input data. This is
  the safer default: one workflow definition, ordinary `createWorkflow`
  registration, no beta surface.
- **Dynamic workflows** (`mastra.addDynamicWorkflow`, a JSON definition
  validated, registered and persisted) fit "an LLM authored this exact
  graph" more precisely, but the API is marked Beta and it means one
  registered definition per plan rather than one committed workflow.

This spec uses `.foreach()`. Real API, corrected against the installed
bundle (the earlier draft's shape was wrong on two counts):

```
const taskExecutionWorkflow = createWorkflow({
  id: 'task-execution',
  inputSchema: z.object({ steps: z.array(planStepSchema), taskId: z.string() }),
  outputSchema: z.object({ results: z.array(stepResultSchema) }),
})
  .foreach(
    createStep({
      id: 'run-plan-step',
      inputSchema: planStepSchema,
      outputSchema: stepResultSchema,
      resumeSchema,   // shape of the data a resume call supplies
      suspendSchema,  // shape of the data shown while suspended
      execute: async ({ inputData, resumeData, suspend, suspendData, mastra, requestContext }) => {
        if (requires approval and not yet resumed) {
          return await suspend({ ...cardData })   // NOT step.suspend() — suspend
        }                                          // is a parameter Mastra passes
        // ...call the step's agent (mastra.getAgent(name)), or use
        // createStep(agent) with a preceding .map() to shape { prompt }
        // when no custom logic is needed
      },
    })
  )
  .commit()   // required — a workflow without .commit() is never runnable
```

A run starts via `createRunAsync()` then `run.start({ inputData })`, and
resumes via `run.resume({ step, resumeData, forEachIndex })` — not
`run.resume({ decision })` as an earlier draft of this spec had it, and not
`run.resume({ resumeData, step })` alone as a later draft had it either;
under `.foreach()` the resume call needs a third field. The resume payload
must match the step's declared `resumeSchema`.
`settleTask()`/`refundTask()` still run after the workflow
completes/fails — unchanged.

**Resolved (was open question 3): a step DOES suspend correctly inside
`.foreach()`, targeted by index.** Confirmed against the installed bundle's
own docs (`docs-workflows-suspend-and-resume.md`): Mastra tracks a
per-iteration `foreachIndex` in the run's suspended state, and
`createWorkflowStateReader(state).getResumeLabel(...)` returns a label
carrying that `foreachIndex` for a foreach suspension. Resuming the exact
suspended item is `run.resume({ step, resumeData, forEachIndex })` — not
implicit; the caller must read `foreachIndex` off the suspended state (via
`reader.getSuspendedStep()`/`getResumeLabel()`) and pass it back. One step
definition executing many times across the plan's items does not lose or
conflate per-item suspend state — each iteration's suspend is independently
addressable. This unblocks Plan 3 (Tasks workflow) on the `.foreach()`
shape chosen above; no architecture change needed.

## Testing

- Skills: existing `agent-skills.test.ts` (API) stays — attach/detach
  behavior unchanged. New tests: `skills:` resolver returns only the test
  skill when `testSkillInstallId` is set, returns all attached (minus
  `default`) otherwise, returns `[]` gracefully for a revoked/foreign
  install id.
- Confirm/approval: existing `confirmGeneration.test.ts` behavior
  (alwaysAsk, isUnlimited, allowMode) stays green: re-target assertions at
  the `requireToolApproval` function's return value and
  `approveToolCall`/`declineToolCall` calls instead of the Map.
- Workflow: existing `tasks-workflow-settle.test.ts` /
  `tasks-execute-attempt-key.test.ts` / `tasks-resume-attempt-key.test.ts`
  stay green against the new `createWorkflow` internals — same external
  `runMastraWorkflowSteps` signature, same settle/refund behavior asserted.

## Open questions

1. Should attach (not test) still have a count cap now that there's no
   char budget to enforce? `MAX_ATTACHED_SKILLS` prevented unbounded
   growth; removing it entirely means an agent could accumulate arbitrarily
   many real attached skills over time (same shape of problem this spec's
   trigger bug came from, just for real attachments instead of test ones).
   Recommend keeping a small count cap (e.g. 8) at attach time as a product
   guard, decoupled from the deleted char-budget logic — confirm before
   planning.
2. ~~Suspended-run expiry~~ — **decided.** `WatchdogFunction` sweeps runs
   suspended awaiting tool approval, untouched for a named constant
   `APPROVAL_EXPIRY_HOURS = 24` (not a literal in the sweep code). A swept
   run calls `agent.declineToolCall({ runId, reason: 'expired' })` — never
   deletes the snapshot — so the run finishes cleanly, the model sees the
   reason, and the path is identical to a user clicking decline; nothing
   distinguishes a timed-out decision from a human one downstream. The
   sweep query matches on the approval payload specifically (the
   suspended step's payload shape/kind, not merely "suspended and old") —
   other workflow suspends persist in the same storage, and matching by
   age alone repeats the false-positive pattern from the earlier watchdog
   bug that marked every non-ingestible file `failed` by scanning too
   broad a condition.
3. ~~Suspend-inside-`.foreach()` semantics~~ — **resolved, see Design
   section 3.** A step suspends correctly per-iteration; resume targets the
   exact item via `forEachIndex` read off `createWorkflowStateReader`'s
   suspended-state accessors. No longer blocks Plan 3.

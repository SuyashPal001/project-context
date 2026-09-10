# Sub-agent control plane for the Olmo supervisor

Date: 2026-09-10
Status: draft — depends on `2026-09-10-mastra-native-runtime-migration-design.md` landing first

## Problem

`platformAgent.ts:417` already makes Olmo a Mastra supervisor
(`agents: buildOlmoDelegates`), and `olmoDelegates.ts` hands it four
delegates — `pm`, `architect`, `director`, `producer` — gated to the
seeded Olmo row. The delegation works. Nothing around it does.

Today, on that path:

- **No step budget.** Nothing passes `maxSteps`, so Mastra falls back to
  `stepCountIs(5)` (`agent-Dp3vcrIx.cjs:27699-27703`). Five is not a
  decision anyone made.
- **No visibility into failure.** No delegation hooks are configured, so
  when a delegate fails there is no record of which one, why, or what it
  cost.
- **No spend ceiling.** Mastra's `maxSteps` and a goal's `maxRuns` count
  *steps*. Fifty steps of text and fifty steps of video generation are
  indistinguishable to it. A creative loop spends an image or video
  generation per iteration.
- **No way to add or retire a delegate without a deploy.** The delegate
  map is four hardcoded constants.
- **No depth control.** Nesting is supported and unguarded.
- **No long-running work.** `backgroundTasks` is absent from the Mastra
  instance config, so a video-length delegation blocks its parent.

The goal of this spec is the control plane, not the first vertical. The
marketing/ad-creative agents that will exercise it are deliberately out of
scope — see [Non-goals].

## Findings that shape the design

Each was verified against the installed `@mastra/core@1.64.0` in this
repo, not recalled.

### 1. Request context leaks agent identity across the delegation boundary

This is the most important finding in the spec, and it is a correctness
bug in the current architecture rather than a missing feature.

`agent-Dp3vcrIx.cjs:35119` builds the sub-agent's request context:

```js
const subAgentRequestContext = new RequestContext(
  [...requestContext.entries()].filter(([key]) =>
    key !== "MastraMemory" && key !== "mastra__threadId" &&
    key !== "mastra__resourceId" && key !== "mastra__inheritedMemory")
)
```

Exactly four keys are excluded, all Mastra-internal. Every field in our
`TenantContext` (`mastra/context.ts`) passes through unchanged, including
`agentId`, `agentName`, `agentSystemPrompt` and `personaPersonality`.

Three consequences:

1. A sub-agent resolving skills per request from `agentId` — which is
   precisely what the native `skills:` resolver in the companion spec
   does — resolves **Olmo's** attached skills, not its own. The premise
   that each specialist carries its own skills does not hold by default.
2. `agentSystemPrompt`, the per-agent prompt override, leaks into every
   delegate on top of that delegate's own instructions.
3. `agentName` leaks, which undermines the delegation gate itself.
   `buildOlmoDelegates` returns the full map when `agentName === 'olmo'`;
   inside a delegated run that value is still `'olmo'`. Any sub-agent that
   declares its own `agents:` resolver is therefore handed the same four
   delegates and can re-delegate in a circle. This does not bite today
   only because none of the four declares `agents:`. It bites the moment a
   vertical supervisor exists.

Consequence 3 makes depth stamping load-bearing rather than advisory: it
is the only thing standing between the system and a delegation loop,
because the gate's own input is inherited.

### 2. Storage, editor and scheduler are already wired; background tasks are not

`mastra/index.ts` registers `storage: getMastraStore()` (PostgresStore on
the `mastra` schema), `editor: new MastraEditor()`, and
`scheduler: { enabled: true, tickIntervalMs: 30_000 }`. So `goal` is
usable today with no new infrastructure, and Mastra's subagent versioning
(`versions: { agents: { '<id>': { status: 'published' } } }`) is already
available. `backgroundTasks` is absent and is the one missing config
block.

### 3. Delegations are already traced

`Observability` with `DefaultExporter` is registered, and delegations are
dispatched as tool calls, so each already produces a typed span with
duration, tokens, model and errors, persisted to Mastra Storage and
queryable in-process through the observability storage domain
(`mastra.getStorage()?.getStore('observability')`). Automatic metrics
include `mastra_agent_duration_ms` and `mastra_tool_duration_ms`.

An earlier draft of this design proposed a full delegation telemetry
table. That would have rebuilt what is already recorded. What Mastra does
not know is our credit ledger, tenant, and task — so what remains is a
narrow link row, not a telemetry subsystem.

### 4. Hook failures are swallowed by default

If a delegation hook throws, Mastra continues the delegation:
`onDelegationStart` proceeds with the original prompt and
`onDelegationComplete` keeps the original result. Failures are recorded on
the request context under `__mastra_delegationHookErrors`. Since credit
accounting will live in these hooks, that default would mean work done and
nobody billed, silently.

### 5. `goal` is the right loop primitive, not `isTaskComplete`

`isTaskComplete` is per-`stream()`: criteria re-supplied every call, dead
when the request ends. `goal` (`@mastra/core@1.42.0`) persists the
objective in thread state, survives reloads, keeps judging when a message
arrives mid-run, and carries a `maxRuns` budget whose exhaustion sets
status `paused` — resumable by raising the budget rather than starting
over. The two compose: the goal step runs immediately after
`isTaskComplete` in the same loop.

### 6. The entitlements helpers cannot be used for this

`packages/foundation/entitlements/src/check.ts`'s `hasFeature` looks
entitlements up by `featureKey`, while the middleware populates the set
keyed by feature UUID, so it returns `feature_not_found` for everything.
The delegate gate must not be built on it.

### 7. Tool approval does survive delegation, and belongs on the tool

Verified, resolving what an earlier draft left open.

`requireToolApproval`, when it is a function, is written into the request
context under `__mastra_requireToolApproval` (`agent-Dp3vcrIx.cjs`
27413-27415) and read back by the tool-call step when it was not passed
directly (26401). That key is **not** among the four excluded by the
delegation copy at 35119, so the parent's approval rule reaches a
sub-agent's tool calls. The same permissive copy that leaks identity in
Finding 1 is what makes approvals work.

Mastra also ships the escalation explicitly: `isDelegatedApproval`, a
`suspendedToolRunId`, and `requireApprovalMetadata[primitiveId]`. When a
sub-agent suspends for approval the delegation step re-suspends upward
carrying that sub-agent's approval payload (28647), so the request climbs
to whoever is hosting the conversation.

Approval can be demanded in three places, combined with OR — if any says
yes, the call pauses:

| Where | Scope |
|---|---|
| `requireToolApproval` on `stream()` / `generate()` | Every tool call in that request |
| `requireApproval: true` on `createTool()` | That tool, whoever calls it |
| `needsApprovalFn` on the tool | That tool, decided per call from the arguments |

The durable choice for generation is the **tool** level. Put it on
`generateImage` / `generateVideo` / `generateSong`, with `needsApprovalFn`
carrying the existing unlimited / rate / always-ask logic, and the rule
holds however the tool is reached: Olmo directly, a specialist under
delegation, or that specialist later promoted to an agent the user talks
to on its own. A rule attached only to the chat stream holds for the first
case and has to be re-established for the other two.

### 8. Ownership and usage are different facts, and only ownership is needed now

`agents.tenantId` is `NOT NULL`, so a platform-owned agent has no legal
home in that table: every row must belong to a tenant. That is a defect
for a system that must carry both official and tenant-authored
sub-agents, and no install table fixes it.

Skills already model this correctly and are the pattern to follow. That
feature carries **two** separate facts: `skills.isOfficial` /
`skills.visibility` say who owns a skill and whether it is published,
while a `skill_installs` row says that a given tenant has it, at a pinned
version, and can uninstall it. Two facts, two homes, because a public
skill is available to everyone and installed by few.

The same triple applies to sub-agents:

| Fact | Where it lives |
|---|---|
| Who owns it | An ownership marker — platform-owned vs tenant-owned |
| Is it shared | Visibility — private vs public |
| Does this tenant use it | An install row |

The sequencing follows from that split. The ownership marker is required
now, because of the `NOT NULL` gap above. Install rows are only required
when tenants can share sub-agents with each other — until then, "which
sub-agents does this tenant have" is fully answered by *owned by the
platform, or owned by me, and not retired*.

This costs nothing later because the resolver reads a **set of allowed
ids** out of the request context rather than querying anything itself
(Design 3). Today that set is filled by an ownership query; when sharing
ships it is filled by an install query. The resolver does not change.
`agent_tools` already uses `tenantId IS NULL` to mean platform-owned, so
the marker follows an existing convention rather than inventing one.

## Goals

- Every delegation runs with a step budget that was chosen, a spend check
  that can refuse it, and a record of what it cost.
- A sub-agent runs as itself: its own skills, its own instructions, its
  own identity — never Olmo's.
- Depth is enforced structurally, by absence from the delegate map, not by
  a prompt instruction a model can ignore.
- Which delegates Olmo can see is a filter over a list, so "hide the
  sub-agents and present it all as Olmo" is a resolver change, not a
  re-architecture.
- Adding, upgrading or retiring a delegate does not require rewriting the
  resolver.
- Long-running work survives: an objective that runs out of budget pauses
  and resumes rather than failing.

## Non-goals

- **The marketing/ad-creative agents, their skills, and the ad rubric.**
  That is the first vertical this control plane exists to serve, and it
  gets its own spec. One throwaway stub delegate is built here purely as a
  smoke consumer, so every piece is exercised as it lands.
- **A database-backed sub-agent registry.** The runtime contract is built
  so the registry is a later source swap. Designing its schema before a
  single delegate has run under hooks and a budget would repeat the
  mistake that left `agent_tools` / `agent_tool_assignments` half-wired.
- **Fallback chains and self-healing.** One optional fallback target per
  delegate, or none.
- **Adopting `AgentController`.** It covers sessions, modes, approvals and
  session state, much of which the orchestrator hand-builds around the SSE
  and WebSocket bridge. Adopting it is a large rewrite and is not this
  spec. It should be a deliberate decision later, not drift.
- **`registry.ts`'s per-conversation agent router.** The companion spec
  flags it as resembling Subagents but solving a different problem. This
  spec leans on the delegate resolver, which makes resolving that flag
  ours rather than theirs — but not here.
- **The two hand-rolled retry loops** (`workflow.ts`'s single fixed-delay
  retry behind an error-string regex, and `geminiExtract.ts`'s four-attempt
  linear backoff). Mastra workflows support `retries` at workflow and step
  level. Neither is on this path; both are flagged because a delegate
  wrapping a workflow inherits whichever behaviour it sits under.
- **Nested tasks.** Olmo opens one task per real ask. Task trees produce
  orphans.

## Decisions taken

| Question | Decision |
|---|---|
| Build the control plane first, or the marketing vertical first | Control plane first, with one throwaway stub delegate as a smoke consumer — a control plane with zero consumers gets its interface wrong |
| Code-defined delegates, DB-defined, or hybrid | Hybrid, expressed as a runtime contract: one `SubAgentSpec` per delegate, first sourced from code constants, later from rows, same resolver either way |
| Loop primitive | `goal`, not `isTaskComplete` |
| Where the objective lives | On a task, not on the chat thread. Chat stays conversational; Olmo opens a task for real work and reports progress back |
| Workflow or goal owns the task | The workflow owns the task; the goal runs inside one step |
| Where the credit budget binds | Both: a per-delegation gate in `onDelegationStart`, and a ceiling across the goal loop |
| Official vs tenant-authored sub-agents | Both. Ownership is marked platform vs tenant, following `agent_tools`' existing `tenantId IS NULL` convention; `agent_templates` gains a nullable `tenantId` on the same convention. `agents.tenantId` being `NOT NULL` is the gap forcing this |
| Ownership marker or install rows | Ownership marker plus visibility now; install rows deferred until tenants can share sub-agents. They answer different questions — who owns it vs who may use it — and only the first is needed before sharing exists |
| Delegate identity across the boundary | Rewritten in `onDelegationStart`, and closed over by `defineSubAgent()` as a second line of defence |
| Delegation telemetry | A narrow link row joining a delegation to tenant, task and credit charge. Timing, tokens and errors are read from Mastra's observability store |
| Hook error strategy | `hookErrorStrategy: 'throw'` |
| Where the approval rule lives | On the tool (`requireApproval` / `needsApprovalFn`), not only on the chat stream — so it survives delegation and survives a specialist becoming directly addressable |
| Ownership filtering | Stable facets only — ownership, visibility, `status != 'retired'`. Fails open when the source is unconfigured |
| Intent-based filtering | Designed as a seam, not built. Mechanism undecided |

## Design

### 1. Shape

Five new modules under `apps/agent-orchestrator/src/mastra/subagents/`:
`spec.ts` (the contract and its validation), `sources.ts` (where specs come
from), `resolve.ts` (specs to a delegate map), `hooks.ts` (the delegation
hooks), `budget.ts` (the credit gate), `link.ts` (the delegation link row).

`olmoDelegates.ts` shrinks to a call into `resolve.ts`.
`platformAgent.ts:417` keeps `agents: buildOlmoDelegates` unchanged — the
signature is already correct.

Per turn:

```
request  →  resolve.ts
              reads requestContext (agentName, delegationDepth, allowed set)
              filters specs: host → depth → ownership
              returns Record<string, Agent>   (or {} at the depth limit)
         →  Olmo's model picks a delegate (dispatched as a tool call)
         →  onDelegationStart
              credit check → { proceed: false, rejectionReason } if exhausted
              rewrite identity on context.requestContext
              stamp delegationDepth + 1
              modifiedMaxSteps from the spec
         →  sub-agent runs
         →  onDelegationComplete
              write the link row (success or failure)
              on error: the spec's fallback, else feedback + bail()
              on empty text after a tool-calls stop: replace resultText
```

The structural claim: **`resolve.ts` never returns an `Agent` the caller
is not allowed to use.** No downstream check, no prompt telling Olmo what
not to call. Depth, entitlement and retirement are all expressed as
absence from the map. This is stricter than the tool path, which
authorizes at invocation time in `capabilities/src/tools.ts:159`; that
path is not changed.

### 2. `SubAgentSpec`

```ts
export interface SubAgentSpec {
  id: string
  build: () => Agent
  description: string
  tags: string[]
  maxSteps: number
  estimatedCredits: number
  maxDepth: number
  requiresEntitlement?: string
  background?: { enabled: true; timeoutMs: number }
  fallback?: string
}
```

`build: () => Agent` is the hinge. The code source returns the existing
constant; a DB source later constructs one from a row. `resolve.ts` never
knows which it got — that is what makes the registry a source swap rather
than a rewrite.

`maxDepth` defaults to `0`, meaning "cannot delegate". A vertical
supervisor declares `1` explicitly. The two-level rule is therefore
per-spec rather than a global constant anyone can raise, and the boring
case is the safe one.

Deliberately absent: `tools` and `model` (the delegates already own
theirs; duplicating them creates two sources of truth with nothing keeping
them in sync — when a DB source lands they belong in the row `build()`
reads), and any routing `priority` or `weight` (ordering a delegate map
does nothing; the model reads descriptions).

`defineSubAgent()` validates at registration and throws, so a malformed
delegate fails at boot rather than mid-delegation:

- `description` must contain a negative clause, matched by regex — the
  same mechanism `skillManifest.ts` already uses to enforce a `/\bwhen\b/i`
  floor on skill descriptions. The description is the entire routing
  signal, and one without a "not for" clause is the largest single cause
  of misrouting.
- `maxSteps >= 1`, `estimatedCredits >= 0`, `maxDepth >= 0`.
- `fallback`, if set, resolves to another registered id and is not self —
  checked after all specs register.
- `background.enabled` requires `backgroundTasks` enabled on the Mastra
  instance, otherwise the spec declares something inert.

Known limitation, accepted: `estimatedCredits` is static, so the
pre-check is an estimate rather than a reservation. A delegate that
generates three videos when its spec said one overruns, and the gate
catches it on the *next* delegation. Reserving properly means charge-then-
settle, which `chargeTaskEstimate` / `settleTask` already do for tasks —
an argument for routing expensive work through tasks rather than building
a second reservation system.

### 3. Resolver

```ts
export function resolveDelegates(
  { requestContext }: { requestContext?: RequestContext<TenantContext> }
): Record<string, Agent> {
  const ctx = requestContext
  const agentName = (ctx?.get('agentName') ?? '').toLowerCase().trim()
  const depth = ctx?.get('delegationDepth') ?? 0
  const allowed = ctx?.get('allowedSubAgents')  // ownership query now, installs later

  const hostMaxDepth = maxDepthForHost(agentName)   // from the host's own spec

  const specs = depth >= hostMaxDepth ? [] : listSpecs()
    .filter(s => hostAllows(agentName, s))
    .filter(s => !allowed || !s.requiresEntitlement || allowed.includes(s.id))

  return Object.fromEntries(specs.map(s => [s.id, s.build()]))
}
```

Synchronous and pure. Nothing here does IO: specs are module-level, depth
and the allowed set come from context. When the DB source lands, the
allowed set is loaded into `RequestContext` upstream — the pattern
`fetchAgentName()` and `fetchAgentContext()` already use — rather than
making the resolver async and putting an `await` in front of every turn.
It is also trivially testable with no database.

The `agentName` gate stays. It is what stops every custom agent falling
through `platformAgent` and inheriting Olmo's delegates. It generalises to
"which host is asking" but does not go away.

Depth is read from the *host's* spec, not the delegate's: `maxDepth` on a
spec says how deep **that** agent may delegate, so a specialist with
`maxDepth: 0` receives `{}` and has nothing to call. Olmo's own host depth
is its ceiling as the root.

`TenantContext` gains `delegationDepth?: number` and
`allowedSubAgents?: string[]`. The file's own comment directs new fields
here.

### 4. Hooks

**`onDelegationStart`**, in order:

1. **Credit check.** Remaining balance against the spec's
   `estimatedCredits`. On refusal, `{ proceed: false, rejectionReason }` —
   Olmo sees the reason and can wrap up with what it has.
2. **Identity rewrite.** Set `agentId` and `agentName` to the delegate's
   own; clear `agentSystemPrompt` and `personaPersonality`. Only
   `tenantId`, `userId` and `sessionId` survive unchanged. This is the fix
   for Finding 1 and is not optional.
3. **Depth stamp.** `delegationDepth + 1` onto the outgoing context.
4. **Step budget.** `modifiedMaxSteps` from the spec, replacing the silent
   `stepCountIs(5)`.
5. **Message filter.** Delegates receive the parent's full conversation by
   default; trim per spec where a delegate should not see it.

**`onDelegationComplete`**:

1. **Write the link row**, success or failure — the join from a delegation
   to tenant, task and credit charge. Timing, tokens and errors come from
   Mastra's observability store, keyed by run id.
2. **On error**, hand to the spec's single `fallback` if it has one,
   otherwise return `feedback` and `bail()`.
3. **On empty text after a tool-calls stop**, replace `resultText` with an
   honest description. A delegate stopped mid-tool-call returns empty
   text, which the parent model reads as "done, nothing to report" — a
   quiet failure Mastra provides this hook specifically to fix.

`hookErrorStrategy: 'throw'`, per Finding 4.

### 5. Chat, task, goal

Most turns are conversation and stay in chat. When the ask is real work,
Olmo opens an `agent_tasks` row carrying the objective, keeps talking in
the chat, and reports progress back into it.

A chat thread is long-lived and wanders; a standing objective on it would
keep judging every turn against a goal the user left twenty messages ago.
A task is one job with a start and an end, which is what an objective is.

**The workflow owns the task; the goal runs inside one step.** The
workflow is the durable spine — plan, generate, review, deliver — and
handles crash recovery and human approval between phases. One step runs
the goal-driven agent, which iterates until the rubric passes or the
budget is spent. The two nest rather than compete: one answers "which
phase", the other "is this phase's output good enough yet".

**Which step, precisely.** The companion spec's `runMastraWorkflow`
replacement executes a per-task plan, so the task workflow is expected to
be a `.foreach()` over that plan rather than a declared `.then()` chain —
the graph is fixed at "run the plan" and the plan is input data. Under
that shape "one step" is ambiguous, because a `foreach` body is one step
definition executed many times. The objective attaches to the plan step
that produces the creative artifact, **not** to the `foreach` as a whole.
Otherwise every plan step gets its own objective and its own budget.

**Two consequences of that shape:**

- **Verify that a step can suspend inside a `.foreach()` and that
  `resume()` lands on the correct iteration.** The design depends on a
  paused goal suspending its step and resuming cleanly; the docs say a
  resumed workflow restarts from the step where it paused, but under
  `foreach` one definition runs many times. Confirm before planning.
- **`.foreach()` takes a `concurrency` option, default `1`.** The default
  is safe. Raising it runs plan steps simultaneously, and the per-loop
  credit counter is then incremented from parallel iterations — it must be
  a single shared counter, not one per iteration.

**Mastra's own run statuses may already carry the distinction.** A
workflow run's status is one of `success | failed | suspended | tripwire |
paused`, with `suspended` and `paused` as separate states. That is close
to the three-state split below — waiting on a human, waiting on money,
broken — but the installed docs do not say what `paused` means, so this is
a check rather than an assumption. If it fits, the work is adopting a
state Mastra already has rather than inventing one.

Two details this must get right, both silent-money bugs if missed:

- **A paused goal suspends its step; it does not fail it.** Out of budget
  is a suspend with resume data. Surfaced as a failure, the workflow's
  retry logic re-runs it and spends more.
- **One counter, not two.** Step-level `retries` and the goal's own loop
  both cause repeated work. A retried step re-entering a goal that has
  already consumed budget must share a single counter.

What already exists on this path: task status, a charge path that survives
retries via `agent_tasks.credit_attempt`, a stored `mastraRunId`, handling
for a run returning suspended, and a watchdog sweeping stalled tasks.

What is missing: Olmo opening a task and staying with it; task progress
published into a conversation (the transport exists, the publication does
not); and a distinction between paused and blocked.

**Paused is not blocked.** The watchdog marks stalled tasks blocked with
one message — *"Task timed out. The agent may have crashed. Please
retry."* Told to a user whose job ran out of credits, that is simply
wrong. Paused means top up and resume the same objective; blocked means
something broke. They need distinct states and distinct recoveries.

### 6. Filtering, and hiding the sub-agents

Delegate count has no code limit — `agents` is an arbitrary `Record`. The
real limit is routing accuracy: each delegate adds a tool schema to a map
already holding roughly 24 `SERVER_TOOLS` keys plus
`platformCapabilityTools` plus per-tenant MCP tools, and past roughly a
dozen similar-sounding choices the model picks wrong. A wrong delegation
costs a whole sub-agent run.

Three levers, in order of value: filter the set per request; nest a
vertical supervisor as one entry; write descriptions that discriminate
(hence the required negative clause).

"Hide the sub-agents and present it all as Olmo" is therefore a resolver
filter. The registry may hold fifty specs while Olmo sees six.

Stable facets — ownership, visibility, `agents.status != 'retired'` —
are a plain lookup and are in scope. Intent-based
filtering is wanted but its mechanism is undecided (an LLM classifier
before the resolver, an embedding match against spec tags, or a per-thread
sticky choice). It is designed as a seam here and left unbuilt.

Two constraints hold whichever mechanism wins:

- **Fail open.** Below threshold, or on any error, return the full
  allowed set. Unlike a filter a person chooses, a bad inferred filter is
  invisible: Olmo silently lacks a capability and does the job badly with
  no signal anything was hidden.
- **Record the candidate set and the surviving set every turn**, or "Olmo
  could not do X" cannot be told apart from a bad prompt.

Note for whoever builds it: `classifierAgent` is not reusable — it is a
document classifier with one caller, `ingestionWorkflow.classify.ts`.

### 7. Background tasks

`backgroundTasks` is added to the Mastra instance config, and generation-
heavy specs opt in via `background`. `streamUntilIdle()` replaces
`stream()` on the paths where a delegation may outlive the response. This
must land before any generation-heavy delegate exists, not after.

## Testing

`olmoDelegates.test.ts` already pins the current contract: the exact
four-delegate map for "Olmo", case-insensitivity, empty for other agent
rows, empty when the name is unset. Those assertions will need rewriting
where they compare an exact map, but every behaviour they pin must still
hold. That is the safety net for the refactor.

Testable with no model calls — most of the design, which is why the
resolver is pure:

- Resolver: which delegates come back for a given context; empty at the
  depth limit; empty for a non-Olmo host; an unentitled delegate absent
  rather than present-and-blocked.
- Validation: a description with no negative clause fails at startup; a
  fallback pointing at a missing or self id fails; a background flag with
  the manager disabled fails.
- Credit gate: with a stubbed balance, the delegation is refused at the
  right point and the refusal carries a reason.
- Identity rewrite: after `onDelegationStart`, the outgoing context
  carries the delegate's own `agentId`/`agentName`, no
  `agentSystemPrompt`, and depth incremented — asserted directly, since
  Finding 1 shows the default is to inherit all three.

Requires a live run: whether Olmo picks the right delegate, and whether
the goal loop converges. Neither is unit-testable, and both are what the
throwaway stub delegate is for.

Done means all six of these are observable:

1. A delegation writes one link row, success or failure.
2. A delegation that would exceed budget is refused before it runs, with
   a reason Olmo can act on.
3. A delegate at the depth limit has an empty delegate map.
4. A delegate takes the step count its spec declares, not five.
5. A crashing hook fails the delegation instead of continuing quietly.
6. An objective that exhausts its budget lands in a resumable paused
   state, distinct from blocked.

## Dependencies and open questions

**Depends on `2026-09-10-mastra-native-runtime-migration-design.md`
landing first**, for three reasons:

1. **Tool approvals must be native before generation moves behind a
   delegate.** Native approvals propagate through delegation and escalate
   upward (Finding 7). `confirmGeneration` does not: it is a hand-rolled
   in-memory Map with its own timeout and SSE push, so behind a sub-agent
   the approval card has no path back to the user — the delegate blocks on
   a Map nobody is watching and times out. That lands precisely on the
   generation-heavy marketing vertical.

   **Recommendation for that spec:** attach the rule to the generation
   tools via `requireApproval` / `needsApprovalFn` rather than only to the
   chat stream's `requireToolApproval`. Same credit logic, one level down,
   and it then holds for delegated calls and for a specialist that later
   becomes directly addressable.
2. **Sub-agent skills need the native per-request resolver.** Today skills
   are concatenated permanently into one agent's instructions, capped at
   8. Building specialist skills on that is building on something already
   scheduled for deletion.
3. **The task path should have one execution model**, not our resumable
   objectives against their resumable steps.

Open, and needing an answer before implementation:

- **What may a tenant author when they build their own sub-agent?** A
  persona only, with tools and loop policy inherited from an official
  template; or a full tenant-owned `agent_templates` row with its own
  prompt, model and tool list. If the latter, the tool list must be
  constrained server-side to `agent_tools` rows visible to that tenant —
  `agent_tools.stakes` and `requiresApproval` exist for exactly this and
  are currently decorative. This is the one genuinely open registry
  question and is deferred with the registry itself.

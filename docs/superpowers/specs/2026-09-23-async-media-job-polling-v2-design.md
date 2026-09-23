# Async media job polling v2 — redesign after failed final review

Date: 2026-09-23
Status: v2 — supersedes `2026-09-23-async-media-job-polling-design.md` (v1/v2
of the original spec), whose implementation (7-task plan, commits
9c2a782c..a5e1f45b) was rejected at the final whole-branch review. This
document is a from-scratch redesign incorporating that review's findings
plus a follow-up Opus review of the fix approach. Both reviews are
summarized in "What went wrong" below; their full text lives in this
session's transcript, not reproduced here.

> **Superseded** by `2026-09-23-batch-media-generation-design.md`. Kept as history; do not implement.

## What went wrong with the original implementation

The original plan (Tasks 1-6) opted `generateVideo`/`generateImage` into
Mastra's native `background: {enabled}` and added `untilIdle: true` plus a
`tool-error` case to `chatStream.ts`. It passed all 7 per-task reviews and a
green full-suite run. The final whole-branch review — which traced real
`@mastra/core@1.64.0` compiled source and ran one live probe rather than
trusting the plan's documentation-derived claims — found the architecture
didn't work:

1. **Olmo auto-promotes the whole Director delegation to a background task**
   the moment Director has any background-enabled tool
   (`deriveSubAgentBackgroundConfig`), then forces the tools *inside* that
   delegation back to synchronous (`disableBackgroundTasks: true` on
   subagent calls). Net effect on the primary Olmo→Director path: zero
   parallelism gain, plus new, untested risk around how approval interacts
   with a background-wrapped delegation.
2. **A completed background task reaches `chatStream.ts` as
   `background-task-completed`, not `tool-result`, in the common case**
   (whenever the task finishes after the dispatching turn has already
   closed, which is the normal timing under `untilIdle`). The plan's
   premise — "Mastra auto-transforms completion into a normal `tool-result`
   chunk" — only holds while the *original* turn is still streaming, not
   after `untilIdle` starts a continuation. `chatStream.ts` had no handler
   for `background-task-completed`, so the generated file's fileId was
   never attached — the same silent-drop bug class fixed live on
   2026-09-17, reopened.
3. **Approval-resume calls never received `untilIdle`.** For any
   billed tenant (the normal case — both tools always require approval),
   after the user approves, the resumed stream closes before the generation
   finishes. Nothing reaches the browser.
4. **Multiple `finish` chunks per turn under `untilIdle`** (one per
   continuation), but `chatStream.ts`'s `case 'finish'` finalized
   (saved messages, sent `done`, debited credits) on every one —
   duplicate saves, premature `done` events.

A follow-up review of this document's proposed fix direction (turn off
background mode for the Olmo→Director path; fix the chatStream integration
properly; revert the premature prompt change; verify with real traces)
confirmed the direction was sound but found four more real bugs the fix
needed to also cover:

5. Approval resume used `currentStream.runId`, which goes stale once
   `untilIdle` starts a continuation turn — approving would target the
   wrong run.
6. A background task that completes *while a separate approval card is
   pending* has its result silently discarded: the pending-approval flow
   tears down the old idle loop (`forceClose`), and the new loop's snapshot
   only replays tasks still `running`, not already-`completed` ones.
7. `tool-result` (the automatic chunk transform) and `background-task-completed`
   (the manager's own chunk) can both arrive for the same completion when
   timing is close — undeduplicated, this double-attaches.
8. Neither tool reads `execContext.abortSignal`, so the manager's own
   `timeoutMs` never actually stops the gateway call — a "timed out" video
   can still finish, charge the tenant, and have its result silently
   discarded. Separately, the LLM can inject a `_background` field into
   tool args to override `maxRetries`/`timeoutMs`/`enabled`, so
   `maxRetries: 0` was configured but not actually enforced.
9. A full orchestrator process restart (PM2) marks orphaned running tasks
   `failed` directly in Mastra's storage, bypassing the tool's `onFailed`
   closure entirely (it doesn't survive the restart) — charged generations
   in flight during a restart are never refunded.

This spec's job is to close all nine, not just re-patch the four the first
review found.

## Scope

Same feature goal as the original spec: let Director issue several
`generate-video`/`generate-image` calls per turn instead of blocking
serially on each one, using Mastra's native background-task manager
(already registered, unchanged from the original spec's finding).

**Explicit non-goal, stated up front (this was implicit and wrong in the
original plan):** this spec does NOT make the Olmo→Director path faster.
That path is left exactly as it behaves today. The parallelism gain from
this feature applies only to the direct-Director-chat path (a user or
Director agent dispatching generation tools without the Olmo delegation
layer in between), and even there, full parallel-approved-generation is
still bounded by the fact that `chatStream.ts` can only resume one pending
approval per turn step — a separate, larger problem this spec does not
solve. Director's prompt keeps its "one generation call per step" rule for
that reason; background dispatch still lets that one call's execution
overlap with the next step's work, which is the real, honest scope of the
win here.

## Architecture

### 1. Olmo-level: disable background mode for delegation

Add `backgroundTasks: { disabled: true }` to the Olmo `Agent` constructor
config (`platformAgent.ts`). Confirmed against `@mastra/core`'s compiled
source: `AgentBackgroundConfig.tools` accepts `'all' | Record<string,
boolean | {enabled, timeoutMs?}>`; an agent-level `false`/`disabled: true`
wins over whatever `deriveSubAgentBackgroundConfig` would otherwise compute
for a delegate that contains background-enabled tools
(`resolveBackgroundConfig`'s precedence: `agentToolConfig?.enabled ??
toolConfig?.enabled`). With this set, `isToolBackgroundEligible` returns
false for every delegate call, so the `_background` schema field is never
injected and the LLM can't re-enable it. Using the blanket `disabled: true`
rather than a `director`-only entry, so any future delegate that gains a
background tool doesn't silently regress into this same bug.

This takes Olmo→Director back to exactly its pre-this-feature behavior —
not a new code path, a reversion to already-trace-verified behavior. No new
testing burden on that path beyond confirming the config change took
effect.

### 2. Server-side completion log (closes the lost-completion race)

New table, `generation_completions` (Drizzle schema in
`apps/agent-orchestrator`'s own schema, or wherever this app's
non-foundation tables live — not `packages/foundation/database`, this is
agent-platform/product-specific):

| column | type | purpose |
|---|---|---|
| `toolCallId` | text, PK | ties back to the dispatch |
| `conversationId` | text | scoping — matches Mastra's `threadId` |
| `tenantId` | text | scoping — matches Mastra's `resourceId` |
| `toolName` | text | `generate-video` \| `generate-image` |
| `status` | text | `completed` \| `failed` |
| `result` | jsonb | the tool's actual return value (fileId/refusalReason/etc.) |
| `deliveredAt` | timestamp, nullable | null until attached to a chat message |
| `createdAt` | timestamp | |

Written once, unconditionally, at the moment the outcome is known:
- On success, at the end of `execute()` (both tools), right after
  attachment upload succeeds — same place the function already returns its
  success shape.
- On failure via the manager (timeout/uncaught throw), in
  `background.onFailed` — the same hook that already does the refund
  backstop; this write is added alongside it, not replacing it.
- On failure via `execute()`'s own catch paths, at each existing refusal
  return — these already run synchronously, so this is a small addition
  next to the existing refund-on-catch calls, not new control flow.

This write happens independent of whether any SSE connection exists,
whether an approval card is pending, or whether the process later restarts
— it is the single source of truth the rest of the system reconciles
against, replacing "did the live SSE handler see this in time" as the
correctness condition.

**Read paths:**

1. **Live path** — `chatStream.ts`'s new `background-task-completed`/
   `background-task-failed` chunk handler (Architecture §3) attaches the
   file via `attachmentFromCanvasToolResult`, then marks `deliveredAt`.
   This is the fast path for the common case and needs no DB read (the
   chunk payload already carries `result`) — only a write to mark
   delivered.
2. **Reconciliation path** — at the start of every new turn for a
   conversation (both the top-level chat turn and, separately, right after
   an approval/decline resume), query
   `generation_completions WHERE conversationId = ? AND deliveredAt IS
   NULL`, attach anything found (same `attachmentFromCanvasToolResult`
   call), mark delivered. This catches: a completion that landed while an
   approval card was pending and the old idle loop got torn down; a
   completion that arrived after a client disconnect; a completion whose
   live chunk got lost to `acquireStreamSlot`'s single-loop-per-thread
   takeover; and (via a separate periodic sweep, §4) a completion recorded
   by `onFailed` after a PM2 restart killed the live process mid-generation.

### 3. `chatStream.ts` rewrite

- `untilIdle: true` on the initial `stream()` call (as before) AND on both
  `approveToolCall`/decline resume calls — the original plan's gap.
- New chunk cases:
  - `background-task-started`: record the `toolCallId` as in-flight for
    heartbeat purposes. Do NOT send `tool_done` for this chunk — it is an
    acknowledgement, not a completion (this was the original plan's I2
    bug: it stopped the heartbeat and reported a fake result immediately).
  - `background-task-completed` / `background-task-failed`: dedupe by
    `toolCallId` against anything already handled via the automatic
    `tool-result`/`tool-error` transform (§ below); if not already
    handled, attach via `attachmentFromCanvasToolResult(payload.toolName,
    payload.result)`, mark `generation_completions.deliveredAt`, end the
    heartbeat for that call.
  - `background-task-cancelled` / `background-task-suspended`: both
    terminal states; end the heartbeat, no attachment (nothing to attach).
  - Existing `tool-result`/`tool-error` cases (unchanged from before, these
    already work when the chunk transform happens to land inside the still-
    open dispatching turn): now also mark `deliveredAt` on the matching
    `generation_completions` row and record the `toolCallId` in the same
    per-turn dedupe set the background-chunk handlers check, so a later
    `background-task-completed` for the same call is a no-op.
- **Fix stale-runId approvals**: `case 'tool-call-approval'` reads
  `part.runId` from the chunk itself, not `currentStream.runId` — the
  latter is pinned to the first turn and wrong once `untilIdle` has spawned
  a continuation.
- **Finalize once, not per `finish`**: accumulate token usage across every
  `finish` chunk the idle loop's `for await` produces; only run
  `saveUserMessage`/`saveAssistantMessage`/`sendEvent('done')`/
  `generateFollowUps`/`runFairnessCheck`/`flushMetrics`/`debitChatTurn`
  once, after the loop exits naturally (no more chunks — Mastra's own
  `tryClose`/`forceClose` ends the combined stream once nothing is running
  or queued).
- **Reconciliation call**: before dispatching a new turn's `stream()` call,
  and again immediately after an approval/decline resume returns, run the
  reconciliation query from §2 and attach anything undelivered first.
- **Defense in depth**: ignore any background-task chunk whose `toolCallId`
  this session's own turn loop never dispatched (cross-tenant/cross-session
  guard — relies on `chatStream.ts` already setting `MASTRA_THREAD_ID_KEY`/
  `MASTRA_RESOURCE_ID_KEY` on the request context, unchanged).

### 4. Money-safety fixes

- **Abort-signal wiring**: both tools' `execute()` pass
  `execContext.abortSignal` into the gateway `fetch()` call's
  `AbortSignal.timeout(...)` — combined via `AbortSignal.any([...])` so
  either the tool's own gateway-level timeout or the manager's
  task-level timeout can cancel the request. When the manager's
  `timeoutMs` fires, this now actually stops the in-flight call instead of
  letting it run to completion invisibly. Video (which charges before the
  call): guard the charge step to no-op if the abort signal is already
  aborted by the time that step runs. Image (charges after success):
  no change needed — an aborted call never reaches the charge step.
- **Neutralize `_background` override**: strip/ignore any `_background`
  field present in a tool call's `inputData` before processing — the LLM
  can inject this field to override `maxRetries`/`timeoutMs`/`enabled`
  server-side config isn't supposed to be re-negotiable by the model.
- **PM2-restart refund/delivery gap**: a periodic reconciliation sweep
  (reusing this repo's existing `WatchdogFunction` pattern —
  EventBridge-scheduled, already exists for stalled agent tasks — or a
  lightweight equivalent inside the orchestrator process if the watchdog
  Lambda can't reach Mastra's in-process task manager) scans for
  `generation_completions` rows with `status = 'failed'` and no matching
  `:refund` entry in `credit_ledger` for their `chargeKey`, and refunds
  them. This is the backstop for the case `onFailed`'s in-memory closure
  can't cover: the process that registered it is gone.

## Testing

- **Deterministic integration tests** (not the mocked `fakeStream` harness
  alone, which can't reproduce real chunk timing — every bug this redesign
  fixes came from timing the mocks couldn't show): use
  `@mastra/core/test-utils/llm-mock`'s `MastraLanguageModelV2Mock` and
  `InMemoryStore` from `@mastra/core/storage` with a real
  `BackgroundTaskManager` and a fake background tool with a controllable
  artificial delay, driving `chatStream.ts`'s actual turn loop against real
  chunk sequences. Required scenarios:
  1. acknowledgement → `finish` → (delay) → `background-task-completed` →
     continuation → `finish` — confirms the attachment appears and only
     one `done`/save cycle fires.
  2. An approval card raised inside a continuation turn — confirms
     `part.runId` targets the right run.
  3. A second generation completing while an approval card for a different
     call is still pending — confirms the completed one isn't lost
     (exercises the reconciliation read path, §2).
  4. A manager timeout — confirms the gateway call is actually aborted
     (mock `fetch` to observe the abort signal fired) and the charge is
     skipped or refunded correctly for both tools' differing charge
     timing.
  5. Simulated process restart (directly write a `failed`
     `generation_completions` row with no matching refund, run the
     reconciliation sweep) — confirms the refund fires.
- **Tool-level**: unchanged from the original plan's Task 1/2/3/4 coverage
  (chargeKey determinism, refund backstop wiring) plus new coverage for the
  abort-signal path and the `_background` override neutralization.
- **Director prompt**: confirm the reverted/reworded instruction text, and
  that `directorAgent.test.ts`/`sources.test.ts` (and the previously-missed
  `subagents/__tests__/hooks.test.ts`, which the original implementation's
  Task 7 pass found by running the full suite, not by grep — a reminder to
  run the full suite rather than trust a targeted `find` for this kind of
  change) all pass.
- **Live verification gate, mandatory before merge**: one real run against
  the dev environment, checked against `mastra_span_events` in Mastra
  Studio (per this repo's own standing lesson: check real traces before
  reasoning about timing-sensitive agent behavior) — specifically
  confirming scenario 1 and 2 above actually happen in production-shaped
  conditions, not just in the mocked integration test. The original
  implementation never did this and every Critical bug the final review
  found came from timing assumptions a live trace would have caught
  immediately.

## What's still deliberately not solved

- **Full parallel approved generation** (Director issuing N calls in one
  step, all approval-gated, all resolved independently) — blocked on
  `chatStream.ts`'s one-pending-approval-per-step limit, a separate,
  larger redesign. This spec's real-world benefit is bounded by that until
  it's solved.
- **Retry safety** (`maxRetries > 0`) — still off; a retried `execute()`'s
  upload side-effect is still not idempotent. Unchanged from the original
  spec's known limits.
- **Olmo-path parallelism** — explicitly out of scope (see Scope section).

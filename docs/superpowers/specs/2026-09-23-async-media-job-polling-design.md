# Async media job polling — design

Date: 2026-09-23
Status: v2 — rewritten after Opus review found v1 duplicated a native Mastra
feature already half-wired in this repo; pending user review

> **Superseded** by `2026-09-23-batch-media-generation-design.md`. Kept as history; do not implement.

## Revision note (v2)

An Opus review of v1 (hand-built `media_jobs` table + detached async
function + CAS-guarded stale sweep) found it not ready: it never touched
`chatStream.ts` (so a completed generation would never reach the chat — the
same silent-drop bug fixed live on 2026-09-17), got `generateImage.ts`'s
charge timing wrong (charges after success, not before, unlike video),
claimed "every caller benefits automatically" when Director's own prompt
forbids parallel generation calls, and — the structural finding — never
checked whether Mastra already ships this. It does:
`apps/agent-orchestrator/src/mastra/backgroundTasks.ts` already registers
the background-task manager (`enabled: true, mode: 'full'`) specifically
because "video generation above all must not block the turn" (its own
comment), but no tool has opted into it yet. This is exactly the failure
mode CLAUDE.md's Mastra section warns about — checked and confirmed before
writing this revision, not assumed. v2 replaces the hand-built job
table/sweep/CAS machinery with the native `background: {enabled}` tool
config; what's still genuinely new work is the `chatStream.ts` attachment
plumbing (v1 never solved this either), credit refund wiring, and updating
Director's prompt.

## Problem

`generateVideo.ts` and `generateImage.ts` are fully synchronous: `execute()`
blocks on a `fetch` to the inference gateway (up to 270s/90s) before
returning. Skills that need several clips per turn (short-drama-stitch,
animation-character, and future skill 6) serialize N generations one-by-one
inside a single agent turn instead of running them concurrently — that is
the confirmed primary driver (not the gateway timeout ceiling, which stays
unaddressed here).

Confirmed independent of the casting/asset-picker tool layer (item 2 of the
same gap list): casting tools are pure DB reads with no generation or job
concept. Build order between the two is a free choice.

## Scope

Both `generateVideo` and `generateImage` opt into background dispatch.
Tools keep their existing names/ids and signatures — no duplicate `start_*`
tools. No `save_image_artifact` — both kinds still auto-attach to the
conversation on completion, matching today's behavior; a
review-before-save flow has no real caller today.

## Architecture

Mastra's background-task manager is already enabled (`backgroundTasks.ts`,
`mode: 'full'`, single PM2 process acting as both producer and worker — no
new service). What's missing is opting the two tools in and wiring the
completion path into `chatStream.ts`:

```ts
export const generateVideo = createTool({
  id: 'generate-video',
  // ...unchanged...
  background: { enabled: true, timeoutMs: 280_000, maxRetries: 0 },
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    // ...unchanged through the charge...
    // gateway call, upload, return — all unchanged. Mastra runs this whole
    // function as the background task body; execute() does not itself need
    // to return early or manage a job row. The manager handles the "return
    // an ack immediately, run to completion later" split.
  },
})
```

`timeoutMs: 280_000` for video (just above the gateway's own 270s ceiling,
so a legitimately-slow-but-succeeding call isn't killed by the task
manager before the gateway would have returned). `maxRetries: 0` — a retry
would re-run `execute()` from the top, which would charge credits a second
time; retries are out of scope until `execute()`'s charge step is made
retry-safe (it already is, via `chargeKey` idempotency, but the *upload*
side-effect on a retried success is not — deferred, not solved here).

**Approval ordering — verified, not assumed.** `requireApproval` still gates
entry into `execute()` synchronously inside the live SSE `turnLoop`
(`chatStream.ts:563-618`) before Mastra ever considers background dispatch.
`sendEvent`/`sessionId` are both present at that point — same live
connection as today — so `shouldRequireApproval`'s fail-open branch (for a
caller missing SSE context) stays unreachable for these two tools. This was
checked against the real `chatStream.ts` control flow, not inferred from
the native-background-tasks doc, which doesn't itself describe how
approval interacts with background dispatch.

## `chatStream.ts` integration (the gap v1 never solved)

1. Turn loop switches from `agent.stream(...)` to
   `agent.stream({ ..., untilIdle: true })`. This keeps the SSE connection
   open and re-enters the agentic loop when a background task completes,
   per Mastra's documented behavior — the stream closes after its idle
   window (default 5 min) with nothing running.
2. A new case in the turn loop's chunk switch handles
   `background-task-completed` for `generate-video`/`generate-image`: it
   feeds `payload.result` through the same `attachmentFromCanvasToolResult`
   path already used for synchronous tool-results (chatStream.ts:153-169) —
   one new branch into an existing function, not a new pipeline.
3. The delegate-unwrap path (chatStream.ts:703-711, for Director's own
   tool-results surfaced through `subAgentToolResults`) needs the same
   chunk type added to what it scans, or a background-completed generation
   issued by a delegate never reaches the top-level attachment logic.
4. `background-task-failed` maps to the same refusal-surfacing the
   synchronous path already does — no new UI state needed if the failure
   payload shape matches `{ refused, refusalReason }`.
5. **Jobs outliving the turn.** If `untilIdle`'s idle window closes before
   a task finishes, the result is not lost — Mastra persists it. The next
   user turn (or a new SSE connection for the same conversation) fetches
   `mastra.backgroundTaskManager.listTasks({ agentId, status: 'completed' })`
   at turn start and attaches anything not yet surfaced, the same way an
   unread message would be picked up — no new "orphaned job" concept.

## Credits

Refund moves from an inline `if (charged) await refundVideoCharge(...)` at
each failure `return` to the tool's `background.onFailed` hook, since
`execute()` no longer returns synchronously to the caller that used to
receive that failure. All six of video's current refund sites (gateway
throw, `genResult.refused`, missing base64, `NO_SESSION_CONTEXT`,
`STORAGE_FAILED`, plus none new) map onto this one hook — `onFailed`
receives whatever `execute()` threw or returned, so the refund logic itself
is unchanged, only its trigger point moves.

**Image keeps its real charge timing** — charges *after* a successful
gateway response, not before (`generateImage.ts:131` today). Its
`background.onFailed` hook therefore only needs to cover the one failure
mode that can happen *after* the charge: `STORAGE_FAILED`. A gateway
failure or refusal happens pre-charge and needs no refund, same as today —
v1 wrongly assumed this tool shared video's charge-before-call ordering;
v2 does not repeat that.

## Director

`directorAgent.ts:83`'s "issue generation calls strictly one at a time …
never issue two generation calls in the same step" instruction is removed.
Background dispatch is cheap to issue serially within one step even under
`toolCallConcurrency = 1` (forced whenever any active tool carries a
truthy `requireApproval`, confirmed against `@mastra/core`'s
`effectiveToolSetRequiresSequentialExecution` — this governs the
per-step *dispatch* loop, not background execution, which runs
concurrently in the manager regardless of dispatch order) — the dispatch
call itself returns fast; the generation runs after.

`maxSteps: 8` on the delegate (`subagents/sources.ts:28`) needs raising —
a multi-clip skill now issues N `generate-video` dispatches, then a
`wait`/poll step (or relies on `untilIdle`'s re-entry), which no longer
fits 8 steps for larger N. The actual number depends on the largest planned
clip count across skills 2-7 — not decided in this spec; needs a number
from whoever specs skill 6/7's clip counts, or a conservative upper bound
(e.g. 20) if that's not yet known.

## What's deliberately not built

- No `media_jobs` table, no CAS, no stale-job sweep — Mastra's task
  persistence already survives process restarts; re-implementing that
  guarantee by hand was v1's core mistake.
- No `check_media_job`/`wait_for_media_jobs` tools — `untilIdle` plus the
  `chatStream.ts` completion handler covers the "the agent needs to know
  when a generation finishes" need without a poll-shaped tool. If a future
  skill genuinely needs the agent to *synchronously block and check* mid-
  turn (not just react when the SSE stream re-enters), that's a distinct,
  narrower need — revisit then rather than building it speculatively now.

## Testing

- Tool-level: `background.onFailed` refund wiring, for both video's six
  sites and image's one (mock the gateway/upload failure, assert the
  refund fires with the right `chargeKey`/`rateId`/`rateVersion`).
- `chatStream.ts`: a test that a `background-task-completed` chunk for
  `generate-video` results in the same attachment shape as today's
  synchronous return (reuse `attachmentFromCanvasToolResult`'s existing
  test fixtures where possible), and the same through the delegate-unwrap
  path.
- Director: update the existing test/fixture (if any) that asserts serial
  generation-call behavior, since that constraint is being removed.
- No live-gateway test changes — the gateway contract is untouched.

## Known limits (not solved here)

- Gateway timeout ceiling (270s/90s) unchanged.
- Retry (`maxRetries > 0`) is deliberately left at 0 — making a retried
  `execute()` charge- and upload-safe is future work, not this spec.
- `maxSteps` bump is a placeholder number pending real clip-count data from
  later skills in the sequence.

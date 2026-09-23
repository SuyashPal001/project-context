# Batch media generation tools — design

Date: 2026-09-23
Status: v1 — supersedes both `2026-09-23-async-media-job-polling-design.md`
and `2026-09-23-async-media-job-polling-v2-design.md`. Those approaches
(Mastra native background tasks) were abandoned after three review passes.

## Why the background-task approach was abandoned

The 7-task implementation of native background tasks (commits
9c2a782c..a5e1f45b) was rejected at final review, and the redesign (v2 spec)
was rejected by a second Opus review. Reasons that matter for this design:

- Olmo, the default agent every skill runs through, auto-promotes a whole
  Director delegation to a background task when Director has a background
  tool, and Mastra forces the tools inside the delegation back to
  synchronous. The Olmo → Director path gets no parallelism from background
  tasks. Fixing that means opting Olmo out, which leaves the path everyone
  uses unimproved.
- The direct-Director path needs a rewrite of chatStream's turn loop
  (`untilIdle`, several `finish` chunks per turn, stale approval runIds,
  lost completions during pending approvals), a new completion-log table,
  and a restart-refund sweep. Three review passes each found new real
  bugs in that machinery.
- The user's multi-clip skills are mostly "shared anchor": every clip
  depends on a cast sheet or approved still generated once up front, so the
  clips themselves are independent of each other. That shape needs
  parallel execution inside one call, not background dispatch.

## Goal

Let Director generate several independent videos or images in one tool call,
at the wall-clock cost of the slowest one, on every path (Olmo → Director
included), without touching the approval flow's one-card-per-call model.

## Non-goals

- Chained generation (clip N needs clip N-1's output). Stays sequential
  single calls. Nothing can parallelize it.
- Background/async execution, `untilIdle`, job tables, polling.
- Solving the "chatStream resumes one pending approval per step" limit.
  A batch is one call, so one approval.
- Rewriting skills' DB-seeded instructions. Director's prompt carries the
  guidance; skill text that says "generate each beat" may need a follow-up
  edit and is tracked separately.

## Design

### New tools

`generate-videos` and `generate-images` (ids), registered under the
underscored keys `generate_videos` / `generate_images` on both Director
agents in `directorAgent.ts` (the standalone `directorAgent` and the
Olmo-facing `directorAgentDelegate`), mirroring how
`generate_video`/`generate_image` are registered today. Only Director
registers generation tools.

Input: `{ items: Item[] }` with `items.min(1).max(MAX_BATCH_ITEMS)`. `Item`
is exactly the existing single tool's input schema (export it from
`generateVideo.ts` / `generateImage.ts`; do not duplicate it).
`MAX_BATCH_ITEMS = 4`, a named constant. The gateway/Vertex quota is not
verified; 4 is a conservative starting value and the one number to revisit
after the first live run.

Output: `{ results: ItemResult[], succeeded: number, failed: number }`
where `ItemResult = { index: number } & (the single tool's output shape)`.
A per-item failure never fails the whole call.

### Shared per-item function (no duplicated logic)

The body of `generateVideo`'s `execute` moves into
`generateVideoItem(inputData, execContext, itemIndex)` and the body of
`generateImage`'s into `generateImageItem(...)`, each in the same file,
exported. The single tools become `execute: (i, ctx) => xItem(i, ctx, 0)`.
The batch tools run:

```ts
const settled = await Promise.allSettled(
  items.map((item, i) => xItem(item, execContext, i)))
```

A rejected promise maps to `{ index, refused: true, refusalReason:
'GENERATION_FAILED' }`. The wrapper cannot refund a charge it does not know
about, so every post-charge failure must already refund inside the item
function. This was audited against the real code: `uploadGeneratedFile`
catches everything and returns `null`; `refundVideoCharge` and
`refundImageCharge` swallow their own errors; `res.json()` sits inside the
existing try; and a non-`InsufficientCreditsError` `spendCredits` failure
means the charge did not commit. No item-function change is needed for
this.

### Credit keys

chargeKey keeps its shape and uses the item index in the attempt slot:

- video: `video:${conversationId ?? sessionId}:${toolCallId}:${index}`
- image: `image:${conversationId ?? sessionId}:${toolCallId}:${index}`

The single tools pass index 0, so their keys are byte-identical to today's
(video) and to Task 1's (image). Each item charges and refunds
independently, so `spendCredits`/refund idempotency works per item.
Charge ordering is unchanged and must not be unified: video charges before
the gateway call, image charges after a successful response.

Partial credit exhaustion is allowed: an item whose charge throws
`InsufficientCreditsError` returns `{ insufficientCredits: true }` while
its siblings proceed.

### Approval

One `requireApproval` per batch tool, using the same `shouldRequireApproval`
with the same resourceType/subject as the single tool. One card per call.

Price display: `generation_confirm_request` gains an optional `count`
(the batch tool's `items.length`; absent for single tools).
`GENERATION_APPROVAL_METADATA` gains entries for the four new tool-name
forms with a `buildCount(args)` returning `items.length`. On the web side,
`ApproveCost` already accepts `params.count`; `MessageThread` passes
`params={{ count }}` from the request, and the request type gains `count`.
Video and image are both priced per item (`costMicro(schema, { count: 1 })`
per item), so a batch of N is `count: N`. The save route that persists the
confirm request must accept the new field (locate its validator in the
plan).

### Attachments

`attachmentFromCanvasToolResult` handles one file per result. Add
`attachmentsFromToolResult(normalizedToolName, result)` returning
`AttachmentPayload[]`: for `generate-videos`/`generate-images` it maps
`result.results` through the existing single-file function; for everything
else it wraps the existing function's result. Both call sites in the
turn loop (the `tool-result` case and the delegate `subAgentToolResults`
unwrap) switch to it. The existing function stays exported and unchanged.
The new tool names are added to the allow-list. The plan must also check
`useChatStream.ts` for any place that reads `fileId` off a `tool_done`
result for live display, since a batch result is nested under `results`.

### Director and Olmo prompts

Director's prompt keeps its rule that dependent generation calls are issued
one at a time, and adds: independent clips or stills that depend only on an
already-approved anchor go in one `generate_videos` / `generate_images`
call. `maxSteps` stays at 8.

Olmo's own prompt must change too. Its `UGC_CHARACTER_CONTRACT` currently
tells it that N beats means N separate approvals and to delegate each beat's
still and each approved still individually. Left alone, Director would only
ever receive one item per delegation on the Olmo path, so nothing would be
batched. The contract's steps 2, 4 and 6 change so Olmo delegates whole
stages (all beats' stills in one delegation, then all approved stills in one
delegation) and tells the user about one confirmation card per batch of up to
4. A phrase in Olmo's `DELEGATION_CONTRACT` about finding a `fileId` in
`subAgentToolResults` is clarified for batch results, and Director's own
"every render triggers its own confirmation" and "check the tool result for a
fileId" lines are reworded for batches.

## What happens to the existing branch

Revert, in reverse order, the background-task work: `cbc0bd58` (hooks
test maxSteps), `5d0f72d7` (Director prompt + maxSteps), `579eefa1`
(chatStream `untilIdle` + `tool-error`), `bc7b94fc` (image background
opt-in), `8c84ec76` (video background opt-in), `cd458fa0` (refund
backstop helper, unused now). Keep `f521fba9` (deterministic image
chargeKey, which the per-item keys build on) and `a5e1f45b` (its test's
type fix). Expect a textual conflict in `generateImage.test.ts` between the
Task 4 revert and `a5e1f45b`; resolve by keeping the Task 1 test with the
cast fix and dropping the background tests. The two v1/v2 spec files stay in
the repo as history, with a one-line superseded banner added to each.

## Testing

- Parallelism: with a fake gateway that delays each call by T, a batch of N
  completes in roughly T, not N×T (assert against elapsed time with
  generous bounds, or against overlapping in-flight counts).
- Keys and money: each item charges under `…:${index}`; a failed item
  refunds only itself; an invalid item (dialogue gate, identity anchor,
  missing source image) is refused without being charged; one item hitting
  `InsufficientCreditsError` does not stop the others.
- Schema: `items` empty or over `MAX_BATCH_ITEMS` is rejected.
- Single tools unchanged: existing `generateVideo`/`generateImage` tests
  pass untouched, including chargeKey `…:0`.
- chatStream: a batch `tool-result` yields one attachment per succeeded
  item; the delegate-unwrap path does the same; failed items produce none.
  The approval event carries `count` for batch tools and omits it for
  single tools.
- Web: `ApproveCost` receives `count` from the request.
- Live check before merge (this repo's standing rule for timing-sensitive
  agent behavior): one real run through Olmo → Director generating a batch
  of 2-3 clips, verified against `mastra_span_events` for a single approval
  card, overlapping gateway calls, and all attachments landing.

## Known limits

Beyond the list below, the implementation plan's "Known limits" section
records further limits found by its review (whole-batch failure on one bad
item's input, the gateway's video circuit breaker with no 429 backoff,
memory with 4 inline videos, and web-card display of partial failures).

- The turn blocks until the slowest item finishes (up to the 270s video
  gateway timeout), same as today's single call. No mid-turn interaction.
- Approval is all-or-nothing for the batch.
- `MAX_BATCH_ITEMS = 4` is unverified against real gateway quota.
- Skill text seeded in the DB may still say "generate each beat", which
  Director's prompt overrides only partly; a follow-up edit to the skills
  is out of scope here.

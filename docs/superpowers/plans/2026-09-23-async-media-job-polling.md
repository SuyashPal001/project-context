# Async Media Job Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `generate-video`/`generate-image` run as Mastra native background tasks so Director can issue several clip generations in one turn instead of blocking on each one serially.

**Architecture:** Opt both tools into Mastra's already-registered background-task manager via `background: {enabled, timeoutMs, maxRetries: 0}`. `execute()` bodies are unchanged — Mastra runs them as the background task body verbatim, so the existing inline charge/refund/upload logic keeps working exactly as it does synchronously today. Mastra auto-transforms a completed background task into a normal `tool-result` chunk on the agent's `fullStream` (confirmed against `@mastra/core@1.64.0`'s compiled source, `agent-DsRUDsS_.js:26709`), so `chatStream.ts`'s existing `attachmentFromCanvasToolResult` path needs no changes for the success case. A failed/timed-out background task becomes a `tool-error` chunk instead — a case `chatStream.ts`'s turn-loop switch does not yet have, so one is added. `background.onFailed` is wired as a backstop refund for the one failure mode the inline logic can't cover: the manager killing a task before `execute()`'s own try/catch ever runs (timeout exceeded, uncaught throw).

**Tech Stack:** TypeScript, Mastra (`@mastra/core@1.64.0`), Vitest, Zod, Hono/SSE (`apps/agent-orchestrator`).

**Spec:** `docs/superpowers/specs/2026-09-23-async-media-job-polling-design.md`

## Global Constraints

- No new database table, queue, or Lambda — the background-task manager (`apps/agent-orchestrator/src/mastra/backgroundTasks.ts`, `enabled: true, mode: 'full'`) is already registered on the Mastra instance; this plan only opts tools into it.
- `maxRetries: 0` on both tools — a retry would re-run `execute()` from the top and charge credits a second time. Retry-safety is explicitly out of scope (spec's Known Limits).
- `generateImage.ts`'s charge-after-success ordering (charges only once `imageBase64` is confirmed present) must not change — it is not the same as `generateVideo.ts`'s charge-before-call ordering, and no task in this plan may quietly unify them.
- Every new/changed function gets a test before being considered done (TDD: write the failing test, watch it fail, implement, watch it pass, commit).

---

## File Structure

- Modify `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts` — add `background` config.
- Modify `apps/agent-orchestrator/src/mastra/tools/generateImage.ts` — add `background` config; make `chargeKey` deterministic (prerequisite for the refund backstop, see Task 2).
- Create `apps/agent-orchestrator/src/mastra/tools/backgroundTaskRefund.ts` — shared `onFailed` backstop refund helper, used by both tools.
- Create `apps/agent-orchestrator/src/mastra/tools/backgroundTaskRefund.test.ts`.
- Modify `apps/agent-orchestrator/src/routes/chatStream.ts` — add `untilIdle: true` to the `stream()` call; add a `tool-error` case to the turn-loop switch.
- Modify `apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts` — add the `tool-error` coverage.
- Modify `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` — remove the "issue generation calls strictly one at a time" instruction.
- Modify `apps/agent-orchestrator/src/mastra/subagents/sources.ts` — raise `director`'s `maxSteps`.
- Modify `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`, `generateImage.test.ts` — cover the new `background` config and `onFailed` wiring.

---

### Task 1: Make `generateImage`'s chargeKey deterministic

`generateImage.ts:132` today builds `chargeKey = \`image:${sessionId}:${randomUUID()}\`` — a random UUID per call, which cannot be reconstructed later from anything a background task's `onFailed` hook receives (it only gets `toolCallId`, `threadId`, `resourceId`, `args` — no access to a value generated inside `execute()`'s own closure). `generateVideo.ts` already avoids this: its `chargeKey` is built from `jobId = \`${conversationId ?? sessionId}:${toolCallId}\``, fully deterministic from values `onFailed` *can* recover. This task makes `generateImage.ts` match that pattern, which Task 2's refund backstop depends on.

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`

**Interfaces:**
- Produces: `generateImage.ts` now extracts `toolCallId` from `execContext.agent.toolCallId` (mirroring `generateVideo.ts:100`'s documented gotcha — reading it from anywhere else silently returns `'unknown'`, making the key constant per conversation) and builds `chargeKey = \`image:${conversationId ?? sessionId}:${toolCallId}\`` instead of `\`image:${sessionId}:${randomUUID()}\``.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts` (after the existing "calls the gateway..." test):

```ts
  it('builds a deterministic chargeKey from conversationId and toolCallId, not a random uuid', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

    const execCtx = { ...baseCtx(), agent: { toolCallId: 'tc-1' } } as never
    await generateImage.execute!({ prompt: 'a red bicycle' } as never, execCtx)

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ key: 'image:c1:tc-1:0' }))
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts -t "deterministic chargeKey"`
Expected: FAIL — actual `key` is `image:c1:<random-uuid>`, not `image:c1:tc-1:0`.

- [ ] **Step 3: Write minimal implementation**

In `generateImage.ts`, remove the `randomUUID` import if it becomes unused, add a `toolCallId` extraction next to the existing `sessionId` line, and change the chargeKey construction:

```ts
    // toolCallId lives on execContext.agent.toolCallId, not execContext.toolCallId
    // and not requestContext — same gotcha generateVideo.ts documents. Reading
    // the wrong location silently returns 'unknown' every time, which would
    // make chargeKey constant per conversation instead of per call.
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
```

```ts
    // Success — charge now, before the (best-effort) upload. Deterministic
    // (conversationId + toolCallId + a hardcoded attempt suffix, matching
    // generateVideo.ts's `video:${jobId}:${attempt}` chargeKey shape exactly,
    // attempt included) rather than a random uuid — a background-task
    // onFailed backstop needs to reconstruct this key from BackgroundTask
    // fields alone, which a randomUUID() generated inside execute()'s own
    // closure can never be, and matching video's shape means one shared
    // construction works for both kinds in backgroundTaskRefund.ts.
    const chargeKey = `image:${conversationId ?? sessionId}:${toolCallId}:0`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts`
Expected: PASS (all tests in the file, not just the new one — confirms the chargeKey change didn't break the existing charge/refund assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts
git commit -m "fix(agent-orchestrator): make generateImage chargeKey deterministic"
```

---

### Task 2: Shared background-task refund backstop

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/backgroundTaskRefund.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/backgroundTaskRefund.test.ts`

**Interfaces:**
- Consumes: `refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)` from `./videoCredits.js`; `refundImageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)` from `./imageCredits.js` — both already exist, unchanged, both read the actual refund amount back from `credit_ledger` by `chargeKey` rather than trusting a passed-in amount.
- Produces: `refundStaleBackgroundTask(task: BackgroundTask, kind: 'video' | 'image'): Promise<void>`, exported for Task 3 to wire into both tools' `background.onFailed`.

- [ ] **Step 1: Write the failing test**

```ts
// backgroundTaskRefund.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { refundVideoCharge } = vi.hoisted(() => ({ refundVideoCharge: vi.fn() }))
vi.mock('./videoCredits.js', () => ({ refundVideoCharge }))
const { refundImageCharge } = vi.hoisted(() => ({ refundImageCharge: vi.fn() }))
vi.mock('./imageCredits.js', () => ({ refundImageCharge }))

import { refundStaleBackgroundTask } from './backgroundTaskRefund.js'
import type { BackgroundTask } from '@mastra/core/background-tasks'

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 't1', status: 'failed', toolName: 'generate-video', toolCallId: 'tc-1',
    args: {}, agentId: 'director', threadId: 'conv-1', resourceId: 'tenant-1',
    runId: 'r1', retryCount: 0, maxRetries: 0, timeoutMs: 280_000, createdAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => vi.resetAllMocks())

describe('refundStaleBackgroundTask', () => {
  it('refunds a failed video task using a chargeKey built from threadId, toolCallId, and the hardcoded attempt suffix', async () => {
    await refundStaleBackgroundTask(task(), 'video')
    expect(refundVideoCharge).toHaveBeenCalledWith('tenant-1', undefined, 'video:conv-1:tc-1:0', null, null)
  })

  it('refunds a failed image task the same way, via refundImageCharge', async () => {
    await refundStaleBackgroundTask(task({ toolName: 'generate-image' }), 'image')
    expect(refundImageCharge).toHaveBeenCalledWith('tenant-1', undefined, 'image:conv-1:tc-1:0', null, null)
  })

  it('does nothing and logs when resourceId is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await refundStaleBackgroundTask(task({ resourceId: undefined }), 'video')
    expect(refundVideoCharge).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/backgroundTaskRefund.test.ts`
Expected: FAIL with "Cannot find module './backgroundTaskRefund.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// backgroundTaskRefund.ts
import type { BackgroundTask } from '@mastra/core/background-tasks'
import { refundVideoCharge } from './videoCredits.js'
import { refundImageCharge } from './imageCredits.js'

// Backstop for the rare case where the background-task manager itself
// fails a task (its own timeoutMs exceeded, or an uncaught throw inside
// execute() that never reached that function's own try/catch) — NOT the
// primary refund path. execute()'s existing inline refund-on-catch logic
// (unchanged; it runs as the background task body verbatim) still handles
// every ordinary generation failure exactly as it does synchronously
// today. This only fires when that logic never got the chance to run.
//
// task.resourceId is this codebase's tenantId and task.threadId is its
// conversationId — chatStream.ts's stream() call sets
// `memory: { thread: conversationId || crypto.randomUUID(), resource: tenantId }`,
// and Mastra threads both straight onto the BackgroundTask record (confirmed
// against @mastra/core's BackgroundTask type, not assumed). generateVideo.ts's
// real chargeKey is `video:${jobId}:${attempt}` = `video:${conversationId}:${toolCallId}:0`
// (attempt hardcoded 0 today) — generateImage.ts (post-Task-1) matches that
// exact 3-segment shape. This must stay byte-for-byte identical to what
// execute() actually charged under, or the refund's ledger lookup by
// chargeKey silently finds nothing and no-ops.
//
// rateId/rateVersion are not recoverable here (they were resolved from the
// live rate at charge time, inside execute(), and nothing on BackgroundTask
// carries them) — passed as null. This does not affect refund correctness:
// refundVideoCharge/refundImageCharge compute the refunded amount by
// reading the original debit back from credit_ledger by chargeKey, not
// from rateId/rateVersion — those two are only bookkeeping metadata on the
// refund's own ledger row. actorId is left undefined for the same reason
// (the custom per-request agentId lives in execContext.requestContext, not
// on BackgroundTask, which has its own unrelated `agentId` — the Mastra
// Agent's id, e.g. 'director') — spendCredits already treats undefined
// actorId as a real SQL NULL, so this is safe, just less attributable than
// the primary refund path.
export async function refundStaleBackgroundTask(task: BackgroundTask, kind: 'video' | 'image'): Promise<void> {
  const tenantId = task.resourceId
  if (!tenantId) {
    console.error(`[media-jobs] refundStaleBackgroundTask: task ${task.id} (${task.toolName}) has no resourceId — cannot refund`)
    return
  }
  const chargeKey = `${kind}:${task.threadId}:${task.toolCallId}:0`
  if (kind === 'video') {
    await refundVideoCharge(tenantId, undefined, chargeKey, null, null)
  } else {
    await refundImageCharge(tenantId, undefined, chargeKey, null, null)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/backgroundTaskRefund.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/backgroundTaskRefund.ts apps/agent-orchestrator/src/mastra/tools/backgroundTaskRefund.test.ts
git commit -m "feat(agent-orchestrator): add background-task refund backstop helper"
```

---

### Task 3: Opt `generateVideo` into background dispatch

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`

**Interfaces:**
- Consumes: `refundStaleBackgroundTask` from `./backgroundTaskRefund.js` (Task 2).
- Produces: `generateVideo`'s `createTool(...)` config now includes `background: { enabled: true, timeoutMs: 280_000, maxRetries: 0, onFailed: (task) => refundStaleBackgroundTask(task, 'video') }`. No change to `execute()`'s signature, inputs, outputs, or internal logic.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`:

```ts
  it('is registered for background dispatch with a timeout above the gateway ceiling and no retries', () => {
    expect(generateVideo.background).toEqual(expect.objectContaining({
      enabled: true,
      timeoutMs: 280_000,
      maxRetries: 0,
    }))
  })

  it('wires onFailed to the shared refund backstop for kind "video"', async () => {
    const { refundStaleBackgroundTask } = await import('./backgroundTaskRefund.js')
    const task = { id: 't1', resourceId: 'tenant-1', threadId: 'conv-1', toolCallId: 'tc-1' } as never
    await generateVideo.background!.onFailed!(task)
    expect(vi.mocked(refundStaleBackgroundTask)).toHaveBeenCalledWith(task, 'video')
  })
```

Add the mock near the top of the file, alongside the other `vi.mock` calls:

```ts
const { refundStaleBackgroundTask } = vi.hoisted(() => ({ refundStaleBackgroundTask: vi.fn() }))
vi.mock('./backgroundTaskRefund.js', () => ({ refundStaleBackgroundTask }))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts -t "background dispatch"`
Expected: FAIL — `generateVideo.background` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `generateVideo.ts`, add the import and the `background` field to `createTool`:

```ts
import { refundStaleBackgroundTask } from './backgroundTaskRefund.js'
```

```ts
export const generateVideo = createTool({
  id: 'generate-video',
  description: '...', // unchanged
  inputSchema,
  outputSchema,
  // 280s: strictly above the gateway's own 270s ceiling (see the existing
  // AbortSignal.timeout(270_000) comment below), so a call that's genuinely
  // still in flight inside the gateway's own timeout isn't killed early by
  // the manager. maxRetries: 0 — a retry would re-run execute() from the
  // top and charge credits a second time; chargeKey idempotency covers the
  // charge itself but not a second upload, so retries stay off until that's
  // solved (see spec's Known Limits).
  background: {
    enabled: true,
    timeoutMs: 280_000,
    maxRetries: 0,
    onFailed: (task) => refundStaleBackgroundTask(task, 'video'),
  },
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    // ...unchanged...
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts`
Expected: PASS (full file — confirms nothing in the existing charge/refund/refusal tests broke).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts
git commit -m "feat(agent-orchestrator): run generate-video as a background task"
```

---

### Task 4: Opt `generateImage` into background dispatch

Same shape as Task 3, for the image tool. Depends on Task 1 (deterministic chargeKey) and Task 2 (refund backstop).

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`

**Interfaces:**
- Consumes: `refundStaleBackgroundTask` from `./backgroundTaskRefund.js` (Task 2).
- Produces: `generateImage`'s `createTool(...)` config now includes `background: { enabled: true, timeoutMs: 100_000, maxRetries: 0, onFailed: (task) => refundStaleBackgroundTask(task, 'image') }`.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts` (with the same `vi.mock('./backgroundTaskRefund.js', ...)` hoisted mock added as in Task 3):

```ts
  it('is registered for background dispatch with a timeout above the gateway ceiling and no retries', () => {
    expect(generateImage.background).toEqual(expect.objectContaining({
      enabled: true,
      timeoutMs: 100_000,
      maxRetries: 0,
    }))
  })

  it('wires onFailed to the shared refund backstop for kind "image"', async () => {
    const { refundStaleBackgroundTask } = await import('./backgroundTaskRefund.js')
    const task = { id: 't1', resourceId: 'tenant-1', threadId: 'conv-1', toolCallId: 'tc-1' } as never
    await generateImage.background!.onFailed!(task)
    expect(vi.mocked(refundStaleBackgroundTask)).toHaveBeenCalledWith(task, 'image')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts -t "background dispatch"`
Expected: FAIL — `generateImage.background` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { refundStaleBackgroundTask } from './backgroundTaskRefund.js'
```

```ts
export const generateImage = createTool({
  id: 'generate-image',
  description: '...', // unchanged
  inputSchema: z.object({ /* unchanged */ }),
  outputSchema,
  // 100s: strictly above the gateway's own 90s ceiling
  // (AbortSignal.timeout(90_000) below), same reasoning as generateVideo.ts.
  background: {
    enabled: true,
    timeoutMs: 100_000,
    maxRetries: 0,
    onFailed: (task) => refundStaleBackgroundTask(task, 'image'),
  },
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'image_generation', subject: IMAGE_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    // ...unchanged...
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts
git commit -m "feat(agent-orchestrator): run generate-image as a background task"
```

---

### Task 5: Handle `tool-error` chunks in `chatStream.ts` and enable `untilIdle`

A background task the manager itself fails (timeout, uncaught throw — not a graceful `{refused:true}` return, which still arrives as a normal `tool-result`) is transformed by Mastra into a `tool-error` chunk on `fullStream`. The turn-loop switch in `chatStream.ts` has no case for it today, so it would fall through unhandled. `untilIdle: true` is also needed on the `stream()` call — without it, a background task dispatched mid-turn never gets the chance to re-enter the agentic loop and produce its `tool-result`/`tool-error` chunk before the SSE connection closes.

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts`
- Test: `apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts` — this file already sets up every mock `chatStream.ts` needs (registry, persistence, guardrails, credits, memory, model) and exposes the exact `fakeStream(chunks, runId)` / `streamMock` / `runChatStream(baseOpts({ sendEvent }))` harness this test needs, via its own `tool-result`-chunk test two cases above (`'unwraps a fileId from a delegate wrapper's subAgentToolResults into the done event's attachments'`) — reuse that harness rather than building a new one.

**Interfaces:**
- Consumes: nothing new — reuses `sendEvent`, `onToolCallEnd`, `toolCallNames` already in scope in the turn loop.
- Produces: no new exported functions; `tool-error` chunks now surface as a `tool_done` SSE event with `result: { refused: true, refusalReason: 'BACKGROUND_TASK_FAILED' }`, deliberately matching the exact shape every other refusal already uses so the frontend needs no new contract (confirmed no existing `tool_error` client-side handling exists — `useChatStream.ts` only listens for `tool_done`).

- [ ] **Step 1: Write the failing test**

Add to `chatStream.tool-approval.test.ts`, in the same `describe` block as the `subAgentToolResults` test read above:

```ts
  it('surfaces a tool-error chunk as a refused tool_done event, not an unhandled chunk', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        { type: 'tool-call', payload: { toolCallId: 'tc-1', toolName: 'generate-video' } },
        { type: 'tool-error', payload: { toolCallId: 'tc-1', toolName: 'generate-video', error: { message: 'background task timed out' } } },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-tool-error-1',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('tool_done', expect.objectContaining({
      toolCallId: 'tc-1',
      toolName: 'generate-video',
      result: { refused: true, refusalReason: 'BACKGROUND_TASK_FAILED' },
    }))
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/chatStream.tool-approval.test.ts -t "tool-error"`
Expected: FAIL — no `tool_done` event is emitted for the `tc-1` toolCallId (the chunk is silently dropped by the switch's lack of a matching case).

- [ ] **Step 3: Write minimal implementation**

Add `untilIdle: true` to the existing `stream()` call:

```ts
      let currentStream: any = await (activeAgent as any).stream(mastraMessage, {
        memory: {
          thread: conversationId || crypto.randomUUID(),
          resource: tenantId,
          ...(memoryOptions ? { options: memoryOptions } : {}),
        },
        requestContext,
        providerOptions: { 'inference-gateway': { thinkingBudget } },
        untilIdle: true,
        ...olmoOptions,
        ...(skillInvocationPrepareStep ? { prepareStep: skillInvocationPrepareStep } : {}),
      })
```

Add a new case to the turn-loop switch, right after the existing `case 'tool-result':` block (before `case 'finish':`):

```ts
        case 'tool-error': {
          const p = part.payload ?? part
          const toolCallId = (p.toolCallId ?? '') as string
          const rawToolName = (p.toolName ?? '') as string
          const resolvedToolName = rawToolName || toolCallNames.get(toolCallId) || ''
          toolCallNames.delete(toolCallId)
          const errorMessage = (p.error?.message ?? 'unknown error') as string
          // A background task the manager itself failed (timeout exceeded,
          // uncaught throw) — not a graceful {refused:true} return, which
          // still arrives as a normal tool-result. Surfaced with the same
          // shape every other generation refusal already uses so the
          // frontend needs no new event contract.
          console.error(`[sse:${sessionId}] tool-error toolName=${resolvedToolName} toolCallId=${toolCallId}: ${errorMessage}`)
          sendEvent('tool_done', {
            toolCallId, toolName: resolvedToolName, conversationId,
            result: { refused: true, refusalReason: 'BACKGROUND_TASK_FAILED' },
          })
          onToolCallEnd()
          break
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/chatStream.tool-approval.test.ts`
Expected: PASS (full file — confirms `untilIdle: true` didn't change any existing approval/attachment assertion's behavior).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts
git commit -m "feat(agent-orchestrator): surface background-task failures and enable untilIdle"
```

---

### Task 6: Update Director's prompt and `maxSteps`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts:83`
- Modify: `apps/agent-orchestrator/src/mastra/subagents/sources.ts:28` (director spec's `maxSteps`)
- Test: locate via `find apps/agent-orchestrator -iname "directorAgent*.test.ts" -o -iname "sources*.test.ts"`; if a prompt-content test exists asserting the old serial-call line, update it — otherwise this task has no test of its own beyond the existing suite staying green (a prompt string and a config constant have no independent behavior to unit test).

**Interfaces:**
- No new exports — text/constant changes only.

- [ ] **Step 1: Confirm current behavior via existing tests**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/directorAgent.test.ts src/mastra/subagents/sources.test.ts` (adjust filenames to whatever actually exists — `find` first).
Expected: PASS (establishes the baseline before editing).

- [ ] **Step 2: Update the prompt**

In `directorAgent.ts`, replace the line:

```
- Issue generation calls strictly one at a time: call generate_image or generate_video for one beat and wait for that call's result before issuing the next generate_image/generate_video call. Never issue two generation calls in the same step.
```

with:

```
- generate_image and generate_video now run as background tasks — issuing several in the same step is expected and encouraged when a skill needs multiple beats generated (e.g. several clips for a multi-beat storyboard). Each call's result (or refusal) arrives as a normal tool result once that specific generation finishes; do not assume they finish in the order you issued them.
```

- [ ] **Step 3: Raise `maxSteps`**

In `sources.ts`, change the `director` spec's `maxSteps: 8` to `maxSteps: 20` — headroom for issuing several parallel generation calls plus their follow-up QA steps (`analyze_image`/`analyze_audio`) in one delegation, without yet having exact per-skill clip counts to size this precisely (flagged in the spec's Known Limits as a placeholder pending later skills' real numbers).

```ts
  defineSubAgent({
    id: 'director',
    build: () => directorAgentDelegate as unknown as Agent,
    description: 'Generates and edits images, and generates short video clips, from a text description. Not for music or speech, and not for written copy.',
    tags: ['image', 'video'],
    maxSteps: 20,
    estimatedCredits: 20_000,
  }),
```

- [ ] **Step 4: Run the full existing test suite for both files**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/directorAgent.test.ts src/mastra/subagents/sources.test.ts`
Expected: PASS — if a test asserts the exact old prompt string or `maxSteps: 8`, update that assertion to match the new text/value as part of this step, not as a separate task.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/subagents/sources.ts
git commit -m "feat(agent-orchestrator): let Director issue parallel generation calls"
```

---

### Task 7: Full-suite verification

**Files:** none changed — this task only runs verification.

- [ ] **Step 1: Run the full agent-orchestrator test suite**

Run: `cd apps/agent-orchestrator && npx vitest run`
Expected: PASS, zero failures, zero skipped tests introduced by this plan.

- [ ] **Step 2: Type-check**

Run: `pnpm --filter agent-orchestrator type-check` (or the repo's equivalent — confirm the exact script name in `apps/agent-orchestrator/package.json` before running; use `pnpm type-check` from the repo root if no per-package script exists).
Expected: no new type errors.

- [ ] **Step 3: Confirm no test file silently swallowed an unhandled rejection**

Run: `cd apps/agent-orchestrator && npx vitest run --reporter=verbose 2>&1 | grep -i "unhandled"`
Expected: no output. A `background.onFailed` hook is fire-and-forget from Mastra's side (`void | Promise<void>`) — an unhandled rejection inside `refundStaleBackgroundTask` would otherwise fail silently in production the same way it would in a test run.

No commit for this task — it's a verification gate, not a change.

---

## Known limits carried forward from the spec

- Retry (`maxRetries > 0`) stays off — a retried `execute()` is not charge/upload-safe yet.
- `maxSteps: 20` is a placeholder pending real per-skill clip-count data (spec's Known Limits).
- A background task still running when `untilIdle`'s idle window (default 5 min) closes is not actively re-fetched on the next turn in this plan — Mastra persists the task and it will still complete and be retrievable via `listTasks`, but nothing in this plan wires a "check for anything I missed" step at the start of the next turn. This was flagged as real remaining work in the spec and is out of scope here; revisit if a multi-clip skill's generation regularly outlives 5 minutes of idle time.

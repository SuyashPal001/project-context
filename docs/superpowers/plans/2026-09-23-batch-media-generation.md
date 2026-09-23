# Batch Media Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `generate_videos` / `generate_images` tools that generate up to 4 independent items in parallel inside one synchronous tool call, with one approval card priced for the whole batch, working through both direct Director and Olmo → Director.

**Architecture:** Extract the body of `generateVideo`/`generateImage` into exported per-item functions that take an item index (used in the chargeKey). The single tools call them with index 0 (behaviour and keys unchanged). New batch tools run `Promise.allSettled` over the per-item function. The approval card, the SSE confirm event, the persisted confirm request, and the web card gain an optional `count`. `chatStream.ts` fans a batch result out into one attachment per succeeded item. The abandoned native-background-task work is reverted first.

**Tech Stack:** TypeScript, Mastra (`@mastra/core@1.64.0`), Vitest, Zod, Hono (`apps/agent-orchestrator`, `products/agent-platform/packages/api`), Next.js/React (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-09-23-batch-media-generation-design.md`

## Global Constraints

- No background tasks, `untilIdle`, job tables, or polling anywhere. Batch execution is one synchronous `execute()`.
- `MAX_BATCH_ITEMS = 4`, a named exported constant. The per-item item schema is the single tool's existing input schema, exported, not duplicated.
- chargeKey shape stays `${kind}:${conversationId ?? sessionId}:${toolCallId}:${index}` with `kind` `video` or `image`. The single tools pass index 0, so their keys are unchanged.
- Video charges BEFORE the gateway call; image charges AFTER a successful gateway response. Do not unify these.
- A per-item failure never fails the batch call; the batch returns `{ results, succeeded, failed }`.
- One approval card per batch call. The card's `count` is `items.length` for batch tools and absent for single tools.
- Director's rule that dependent generation calls are issued one at a time stays. Batches are for independent items only.
- Every new or changed function gets a test before it is considered done (TDD: failing test, watch it fail, implement, watch it pass, commit).
- New spec/plan `.md` files are gitignored by a blanket `*.md` rule; use `git add -f` for anything under `docs/superpowers/`.
- `tsc --noEmit` in `apps/agent-orchestrator` includes test files (`src/**`). Tests must type-check, not just pass. Mastra tool accessors are loosely typed: reach `requireApproval` and `inputSchema` through the casts shown in the plan's test code, not with bare `!`.
- The upload helper `uploadGeneratedFile` catches every error and returns `null` (`persistence.ts`), so the item functions get no try/catch around it. A failed upload already surfaces as `STORAGE_FAILED` with a refund.
- The `attempt` slot in the video chargeKey is reserved by `generateVideo.ts`'s existing comment for a future retry counter. This plan uses that slot for the item index. If a retry counter is ever added, the key needs a different shape (for example an extra `:r<attempt>` suffix) so item 1 / attempt 0 cannot collide with item 0 / attempt 1.

## File Structure

- Revert the six background-task commits (Task 1).
- Create `apps/agent-orchestrator/src/mastra/tools/batchRunner.ts` — `MAX_BATCH_ITEMS`, `MediaExecContext`, `runBatch`.
- Create `apps/agent-orchestrator/src/mastra/tools/batchRunner.test.ts`.
- Modify `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts` — export schemas/model, extract `generateVideoItem`.
- Modify `apps/agent-orchestrator/src/mastra/tools/generateImage.ts` — same for image.
- Create `apps/agent-orchestrator/src/mastra/tools/generateVideos.ts` and `generateImages.ts` plus tests `generateVideos.test.ts`, `generateImages.test.ts`.
- Modify `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts` — `buildCount` and four new metadata entries; new test `generationApproval.batch.test.ts`.
- Modify `apps/agent-orchestrator/src/routes/chatStream.ts` — count on the confirm event/persist, `attachmentsFromToolResult`, allow-lists.
- Modify `apps/agent-orchestrator/src/persistence.ts` — `count` on `GenerationConfirmRequestPayload`.
- Modify `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` — register tools, add and reword prompt text.
- Modify `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` — hoist `UGC_CHARACTER_CONTRACT` to an exported module constant and rewrite its steps 2, 4, 6 so Olmo delegates whole stages, plus one clause in `DELEGATION_CONTRACT`; new test `agents/__tests__/ugcCharacterContract.test.ts`.
- Modify `docs/media-generation/README.md` — resolve the open question about batch size and partial failure.
- Modify `products/agent-platform/packages/api/routes/messages.ts` — accept `count`; extend `__tests__/messages.generation-confirm.test.ts`.
- Modify `apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts` (mock entry for the batch tool) and `apps/agent-orchestrator/src/mastra/tools/generationApproval.test.ts` (exact key list).
- Modify web: `components/platform/chat/types.ts`, `hooks/useChat.ts`, `app/[tenant]/dashboard/chat/useChatStream.ts` (+ its test), `components/platform/chat/MessageThread.tsx`, `components/platform/chat/ToolCallCard.tsx` (+ new test), `components/platform/chat/ThinkingIndicator.tsx`; extend `components/platform/credits/ApproveCost.test.tsx`.

---

### Task 1: Revert the background-task work

The branch currently contains an abandoned implementation. Undo it, keeping the deterministic image chargeKey (`f521fba9`) and its test's type fix (`a5e1f45b`).

**Files:** whatever the reverted commits touched (`generateVideo.ts`, `generateImage.ts`, their tests, `backgroundTaskRefund.ts` + test, `chatStream.ts` + test, `directorAgent.ts`, `sources.ts`, `subagents/__tests__/hooks.test.ts`).

**Interfaces:** Produces a tree where `generateVideo`/`generateImage` have no `background` field, `chatStream.ts` has no `untilIdle`/`tool-error` case, Director's prompt has its original one-at-a-time bullet, and director `maxSteps` is 8.

- [ ] **Step 1: Confirm a clean tree and the commit list**

Run: `git status --short` — expected: no output (untracked scratch under `.superpowers/` is git-ignored).
Run: `git log --oneline -14` — expected to include, newest first among the ones to revert: `cbc0bd58`, `5d0f72d7`, `579eefa1`, `bc7b94fc`, `8c84ec76`, `cd458fa0`; and to keep: `a5e1f45b`, `f521fba9`.

- [ ] **Step 2: Revert without committing, newest first**

Run: `git revert --no-commit cbc0bd58 5d0f72d7 579eefa1 bc7b94fc 8c84ec76 cd458fa0`

Git is expected to auto-merge `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts` with no conflict (a trial run of this exact revert applied cleanly). If it does report a conflict there, resolve so the file equals `f521fba9`'s version plus `a5e1f45b`'s cast fix: keep the "builds a deterministic chargeKey…" test with `a5e1f45b`'s cast, and drop the two background tests and the `backgroundTaskRefund.js` mock. Then `git add` the resolved files.

- [ ] **Step 3: Verify the resulting tree**

Run: `git diff f521fba9 --stat -- apps products packages`
Expected: exactly one file listed, `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`, and its diff (`git diff f521fba9 -- apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`) contains only the cast fix from `a5e1f45b`.

Run: `grep -rn "background\|untilIdle\|refundStaleBackgroundTask" apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/routes/chatStream.ts`
Expected: no matches. (`generateImage.ts` is excluded on purpose: `f521fba9` left a comment there mentioning a "background-task onFailed backstop … backgroundTaskRefund.ts". That file no longer exists after the revert, so the comment is stale; Task 3 rewrites it.)

- [ ] **Step 4: Run tests and type-check**

Run: `cd apps/agent-orchestrator && npx vitest run` — expected: PASS, zero failures.
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "revert: remove native background-task opt-in, superseded by batch tools

Reverts cbc0bd58, 5d0f72d7, 579eefa1, bc7b94fc, 8c84ec76, cd458fa0.
Keeps the deterministic generateImage chargeKey (f521fba9) and its test
type fix (a5e1f45b), which the per-item batch keys build on."
```

- [ ] **Step 6: Mark the two abandoned specs as superseded**

Insert this line directly under the `Status:` line (the first block after the title) of both `docs/superpowers/specs/2026-09-23-async-media-job-polling-design.md` and `docs/superpowers/specs/2026-09-23-async-media-job-polling-v2-design.md`:

```
> **Superseded** by `2026-09-23-batch-media-generation-design.md`. Kept as history; do not implement.
```

Then:

```bash
git add -f docs/superpowers/specs/2026-09-23-async-media-job-polling-design.md docs/superpowers/specs/2026-09-23-async-media-job-polling-v2-design.md
git commit -m "docs: mark background-task specs as superseded by batch generation"
```

---

### Task 2: Extract `generateVideoItem`

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/batchRunner.ts` (only the `MediaExecContext` type and `MAX_BATCH_ITEMS` for now; `runBatch` arrives in Task 4)
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`

**Interfaces:**
- Produces from `batchRunner.ts`: `export const MAX_BATCH_ITEMS = 4` and `export type MediaExecContext = { requestContext?: { get: (key: string) => unknown }; agent?: { toolCallId?: string } }`.
- Produces from `generateVideo.ts`: `export const VIDEO_MODEL`, `export const videoOutputSchema`, `export const videoItemSchema`, `export type VideoItemInput = z.infer<typeof videoItemSchema>`, `export async function generateVideoItem(inputData: VideoItemInput, execContext: MediaExecContext | undefined, itemIndex: number)` returning the same object shapes the tool's `execute` returns today. `generateVideo` remains exported and behaves identically (index 0).

- [ ] **Step 1: Create the shared types file**

```ts
// apps/agent-orchestrator/src/mastra/tools/batchRunner.ts
export const MAX_BATCH_ITEMS = 4

// The slice of Mastra's tool execution context the media item functions read.
// Structural on purpose so tests can pass a bare { requestContext } object.
export type MediaExecContext = {
  requestContext?: { get: (key: string) => unknown }
  agent?: { toolCallId?: string }
}
```

- [ ] **Step 2: Write the failing tests**

Add to `generateVideo.test.ts`. Extend the existing import line to `import { generateVideo, generateVideoItem } from './generateVideo.js'`, then add inside `describe('generateVideo tool', ...)`:

```ts
  it('generateVideoItem charges under a chargeKey ending in the item index', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })
    const execCtx = { ...(baseCtx() as unknown as { requestContext: unknown }), agent: { toolCallId: 'tc-9' } }

    await generateVideoItem(
      { mode: 'text_to_video', prompt: 'a car driving', aspectRatio: '16:9', durationSeconds: 8 },
      execCtx as never,
      2,
    )

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ key: 'video:c1:tc-9:2' }))
  })

  it('the single generateVideo tool still charges under index 0', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })
    const execCtx = { ...(baseCtx() as unknown as { requestContext: unknown }), agent: { toolCallId: 'tc-9' } }

    await generateVideo.execute!(
      { mode: 'text_to_video', prompt: 'a car driving', aspectRatio: '16:9', durationSeconds: 8 } as never,
      execCtx as never,
    )

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ key: 'video:c1:tc-9:0' }))
  })
```

- [ ] **Step 3: Run tests to verify the expected state**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts -t "generateVideoItem|single generateVideo tool"`
Expected: the `generateVideoItem` test FAILS (`generateVideoItem` is undefined because the named export does not exist yet). The single-tool `…:0` test already PASSES; it is there to guard the refactor, not to drive it.

- [ ] **Step 4: Implement the extraction**

In `generateVideo.ts`:

1. Add `import type { MediaExecContext } from './batchRunner.js'`.
2. `const VIDEO_MODEL = …` becomes `export const VIDEO_MODEL = …`.
3. `const outputSchema = z.object({` becomes `export const videoOutputSchema = z.object({`.
4. `const inputSchema = z.object({` becomes `export const videoItemSchema = z.object({` (keep both `.refine(...)` calls exactly as they are).
5. Immediately after the schemas add `export type VideoItemInput = z.infer<typeof videoItemSchema>`.
6. Move the entire body of `execute` (everything between `execute: async (inputData, execContext) => {` and its closing `},`) into a new exported function placed above `generateVideo`:

```ts
export async function generateVideoItem(
  inputData: VideoItemInput,
  execContext: MediaExecContext | undefined,
  itemIndex: number,
) {
  // ...the moved body, with these three edits only...
}
```

Edits inside the moved body:
   - The destructure `const { mode, … } = inputData as z.infer<typeof inputSchema>` becomes `const { mode, … } = inputData`.
   - `const attempt = 0` becomes `const attempt = itemIndex`, and the comment above it gets two added sentences: `In a batch call the item index occupies this slot so each item has its own key; the single tool passes 0. If a retry counter is ever added, this key needs a different shape (e.g. a :r<attempt> suffix) so item 1 / attempt 0 cannot collide with item 0 / attempt 1.`
   - Nothing else in the body changes. In particular do NOT add a try/catch around `uploadGeneratedFile`: it never throws (it catches everything and returns `null`), and every other post-charge failure path already refunds inline (`refundVideoCharge` swallows its own errors, `res.json()` is inside the existing try, and a non-`InsufficientCreditsError` `spendCredits` failure means the charge did not commit).

7. Replace the `createTool` call's fields so it reads:

```ts
export const generateVideo = createTool({
  id: 'generate-video',
  description: '…unchanged…',
  inputSchema: videoItemSchema,
  outputSchema: videoOutputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) =>
    generateVideoItem(inputData as VideoItemInput, execContext as unknown as MediaExecContext, 0),
})
```

- [ ] **Step 5: Run the full file and type-check**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts` — expected: PASS (every existing test plus the two new ones).
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors. If `execContext as unknown as MediaExecContext` is rejected or unnecessary, keep whichever cast compiles; do not change `MediaExecContext`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/batchRunner.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts
git commit -m "refactor(agent-orchestrator): extract generateVideoItem with per-item chargeKey index"
```

---

### Task 3: Extract `generateImageItem`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`

**Interfaces:**
- Consumes: `MediaExecContext` from `./batchRunner.js` (Task 2).
- Produces: `export const IMAGE_MODEL`, `export const imageOutputSchema`, `export const imageItemSchema`, `export type ImageItemInput = z.infer<typeof imageItemSchema>`, `export async function generateImageItem(inputData: ImageItemInput, execContext: MediaExecContext | undefined, itemIndex: number)`. `generateImage` unchanged in behaviour (index 0, chargeKey `image:${conversationId}:${toolCallId}:0`).

- [ ] **Step 1: Write the failing tests**

Extend the import to `import { generateImage, generateImageItem } from './generateImage.js'` and add inside the existing `describe`:

```ts
  it('generateImageItem charges under a chargeKey ending in the item index', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })
    const execCtx = { ...(baseCtx() as unknown as { requestContext: unknown }), agent: { toolCallId: 'tc-7' } }

    await generateImageItem({ prompt: 'a red bicycle' }, execCtx as never, 3)

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ key: 'image:c1:tc-7:3' }))
  })
```

The existing test "builds a deterministic chargeKey…" (`image:c1:tc-1:0`, added by the kept commit `f521fba9`) already covers the single tool's index 0, so no second single-tool test is needed here.

- [ ] **Step 2: Run tests to verify the expected state**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts -t "generateImageItem"`
Expected: FAIL — `generateImageItem` is not exported (undefined).

- [ ] **Step 3: Implement the extraction**

In `generateImage.ts`:

1. Add `import type { MediaExecContext } from './batchRunner.js'`.
2. `const IMAGE_MODEL` becomes `export const IMAGE_MODEL`. `const outputSchema` becomes `export const imageOutputSchema`.
3. Lift the inline `inputSchema: z.object({ … })` from `createTool` into `export const imageItemSchema = z.object({ … })` (same fields, same `.describe` strings), plus `export type ImageItemInput = z.infer<typeof imageItemSchema>`.
4. Move the `execute` body into `export async function generateImageItem(inputData: ImageItemInput, execContext: MediaExecContext | undefined, itemIndex: number)`. Edits inside:
   - The destructure of `inputData` drops its inline `as { … }` cast (the parameter is already typed).
   - The chargeKey line becomes `const chargeKey = \`image:${conversationId ?? sessionId}:${toolCallId}:${itemIndex}\``. Replace the whole comment block above it (the one `f521fba9` wrote, which refers to a "background-task onFailed backstop" and `backgroundTaskRefund.ts`, both gone after Task 1) with: `// Deterministic (conversationId + toolCallId + item index) rather than a random uuid, so the key is stable per call and has the same shape as generateVideo.ts's video:\${jobId}:\${attempt}. The item index occupies the last slot; the single tool passes 0.`
   - Nothing else in the body changes. Do NOT add a try/catch around `uploadGeneratedFile` (it never throws; it returns `null`, which the existing `if (!attachment)` refund branch already handles).
5. `createTool` becomes:

```ts
export const generateImage = createTool({
  id: 'generate-image',
  description: '…unchanged…',
  inputSchema: imageItemSchema,
  outputSchema: imageOutputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'image_generation', subject: IMAGE_MODEL }, ctx),
  execute: async (inputData, execContext) =>
    generateImageItem(inputData as ImageItemInput, execContext as unknown as MediaExecContext, 0),
})
```

The charge-after-success ordering (charge only after the `imageBase64` check) must stay exactly where it is.

- [ ] **Step 4: Run tests and type-check**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts` — expected: PASS (all existing tests, including the `image:c1:tc-1:0` one, plus the new one).
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts
git commit -m "refactor(agent-orchestrator): extract generateImageItem with per-item chargeKey index"
```

---

### Task 4: `runBatch` and the two batch tools

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/batchRunner.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/batchRunner.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/generateVideos.ts`, `generateVideos.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/generateImages.ts`, `generateImages.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3's exports (`generateVideoItem`, `videoItemSchema`, `videoOutputSchema`, `VIDEO_MODEL`, `VideoItemInput`, and the image equivalents), `MediaExecContext`, `MAX_BATCH_ITEMS`.
- Produces: `runBatch<TItem>(items: TItem[], runItem: (item: TItem, index: number) => Promise<Record<string, unknown>>): Promise<BatchResult>` with `BatchResult = { results: Array<Record<string, unknown> & { index: number }>; succeeded: number; failed: number }`; tools `generateVideos` (id `generate-videos`) and `generateImages` (id `generate-images`).

- [ ] **Step 1: Write the failing `runBatch` tests**

```ts
// batchRunner.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runBatch } from './batchRunner.js'

describe('runBatch', () => {
  it('runs items concurrently, not one after another', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const out = await runBatch([0, 1, 2], async (_item, index) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight -= 1
      return { fileId: `f${index}` }
    })
    // All three were in flight at once. This is the overlap proof; there is
    // deliberately no wall-clock bound, which would be flaky on shared CI.
    expect(maxInFlight).toBe(3)
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2])
    expect(out).toMatchObject({ succeeded: 3, failed: 0 })
  })

  it('turns a thrown item into a GENERATION_FAILED refusal without failing its siblings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await runBatch(['a', 'b', 'c'], async (_item, index) => {
      if (index === 1) throw new Error('boom')
      return { fileId: `f${index}` }
    })
    expect(out.results[1]).toEqual({ index: 1, refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(out.results[0]).toEqual({ index: 0, fileId: 'f0' })
    expect(out.results[2]).toEqual({ index: 2, fileId: 'f2' })
    expect(out).toMatchObject({ succeeded: 2, failed: 1 })
    errorSpy.mockRestore()
  })

  it('counts refusals and insufficient-credit results as failed, not succeeded', async () => {
    const out = await runBatch([0, 1, 2], async (_item, index) => {
      if (index === 0) return { fileId: 'f0' }
      if (index === 1) return { refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' }
      return { insufficientCredits: true }
    })
    expect(out).toMatchObject({ succeeded: 1, failed: 2 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/batchRunner.test.ts`
Expected: FAIL — `runBatch` is not exported.

- [ ] **Step 3: Implement `runBatch`**

Append to `batchRunner.ts`:

```ts
export type BatchResult = {
  results: Array<Record<string, unknown> & { index: number }>
  succeeded: number
  failed: number
}

export async function runBatch<TItem>(
  items: TItem[],
  runItem: (item: TItem, index: number) => Promise<Record<string, unknown>>,
): Promise<BatchResult> {
  const settled = await Promise.allSettled(items.map((item, index) => runItem(item, index)))
  // Annotated on purpose: without it, spreading a Record<string, unknown> loses
  // the index signature and `r.fileId` below fails to type-check (TS2339).
  const results: BatchResult['results'] = settled.map((s, index) => {
    if (s.status === 'fulfilled') return { index, ...s.value }
    console.error(`[batch] item ${index} threw:`, (s.reason as Error)?.message ?? String(s.reason))
    return { index, refused: true, refusalReason: 'GENERATION_FAILED' }
  })
  const succeeded = results.filter((r) => typeof r.fileId === 'string').length
  return { results, succeeded, failed: results.length - succeeded }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/batchRunner.test.ts` — expected: PASS.

- [ ] **Step 5: Write the failing `generateVideos` tests**

```ts
// generateVideos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(),
  resolveRate: vi.fn(),
  isUnlimited: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))

const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))

import { generateVideos } from './generateVideos.js'
import { uploadGeneratedFile } from '../../persistence.js'

function batchCtx() {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'tc-b' } } as never
}
const item = (prompt: string) => ({ mode: 'text_to_video' as const, prompt, aspectRatio: '16:9' as const, durationSeconds: 8 })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 100_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('generateVideos tool', () => {
  it('generates every item, charging each under its own index-suffixed key', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ fileId: 'f0', name: 'a.mp4', type: 'video/mp4', size: 3 })
      .mockResolvedValueOnce({ fileId: 'f1', name: 'b.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideos.execute!({ items: [item('one'), item('two')] } as never, batchCtx()) as { results: Array<{ index: number; fileId?: string }>; succeeded: number; failed: number }

    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.results.map((r) => r.index)).toEqual([0, 1])
    expect(result.results.map((r) => r.fileId).sort()).toEqual(['f0', 'f1'])
    const keys = spendCredits.mock.calls.map((c) => c[0].key).sort()
    expect(keys).toEqual(['video:c1:tc-b:0', 'video:c1:tc-b:1'])
  })

  it('refuses an invalid item without charging it while its sibling still generates', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'b.mp4', type: 'video/mp4', size: 3 })
    const bad = { ...item('missing the tag'), identityAnchor: { terseTag: 'TAG-X', styleLock: 'LOCK-Y' } }

    const result = await generateVideos.execute!({ items: [bad, item('fine')] } as never, batchCtx()) as { results: Array<Record<string, unknown>>; succeeded: number; failed: number }

    expect(result.results[0]).toMatchObject({ index: 0, refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' })
    expect(result.results[1]).toMatchObject({ index: 1, fileId: 'f1' })
    expect(result).toMatchObject({ succeeded: 1, failed: 1 })
    expect(spendCredits).toHaveBeenCalledTimes(1)
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ key: 'video:c1:tc-b:1' }))
  })

  it('refunds only the failed item when one gateway call fails', async () => {
    let call = 0
    global.fetch = vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })
    }) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f-ok', name: 'b.mp4', type: 'video/mp4', size: 3 })
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateVideos.execute!({ items: [item('one'), item('two')] } as never, batchCtx()) as { succeeded: number; failed: number }

    expect(result).toMatchObject({ succeeded: 1, failed: 1 })
    const refunds = spendCredits.mock.calls.filter((c) => c[0].kind === 'refund')
    expect(refunds).toHaveLength(1)
  })

  it('rejects an empty batch and a batch over MAX_BATCH_ITEMS', () => {
    const schema = generateVideos.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ items: [] }).success).toBe(false)
    expect(schema.safeParse({ items: [item('1'), item('2'), item('3'), item('4'), item('5')] }).success).toBe(false)
    expect(schema.safeParse({ items: [item('1'), item('2'), item('3'), item('4')] }).success).toBe(true)
  })

  it('requireApproval delegates to shouldRequireApproval with video_generation and the video model', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctx = { requestContext: {} }
    const requireApproval = generateVideos.requireApproval as unknown as (input: unknown, ctx: unknown) => Promise<boolean>
    const needs = await requireApproval({ items: [item('x')] }, ctx)
    expect(needs).toBe(true)
    expect(shouldRequireApproval).toHaveBeenCalledWith({ resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash' }, ctx)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideos.test.ts`
Expected: FAIL — `./generateVideos.js` does not exist.

- [ ] **Step 7: Implement `generateVideos.ts`**

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  generateVideoItem, videoItemSchema, videoOutputSchema, VIDEO_MODEL, type VideoItemInput,
} from './generateVideo.js'
import { shouldRequireApproval } from './generationApproval.js'
import { MAX_BATCH_ITEMS, runBatch, type MediaExecContext } from './batchRunner.js'

export const generateVideos = createTool({
  id: 'generate-videos',
  description: `Generates up to ${MAX_BATCH_ITEMS} short video clips in parallel in ONE call, one item per clip, each with the same fields as generate_video. Use only for clips that are independent of each other (each depends at most on an anchor that already exists). Costs one approval card for the whole batch. Returns a per-item results list; a failed item is refunded and reported without failing the others.`,
  inputSchema: z.object({ items: z.array(videoItemSchema).min(1).max(MAX_BATCH_ITEMS) }),
  outputSchema: z.object({
    results: z.array(videoOutputSchema.extend({ index: z.number() })),
    succeeded: z.number(),
    failed: z.number(),
  }),
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { items } = inputData as { items: VideoItemInput[] }
    return runBatch(items, (item, index) =>
      generateVideoItem(item, execContext as unknown as MediaExecContext, index))
  },
})
```

- [ ] **Step 8: Write and run the `generateImages` tests, then implement it**

`generateImages.test.ts` uses the same mock header as `generateVideos.test.ts`, with `getPool` unchanged, and:

```ts
import { generateImages } from './generateImages.js'
```

Batch context and item helper:

```ts
const imgItem = (prompt: string) => ({ prompt })
```

Tests (write all four, run, watch fail, then implement):

```ts
describe('generateImages tool', () => {
  it('generates every item, charging each under its own index-suffixed key', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ fileId: 'i0', name: 'a.png', type: 'image/png', size: 3 })
      .mockResolvedValueOnce({ fileId: 'i1', name: 'b.png', type: 'image/png', size: 3 })

    const result = await generateImages.execute!({ items: [imgItem('one'), imgItem('two')] } as never, batchCtx()) as { succeeded: number; results: Array<{ fileId?: string }> }

    expect(result.succeeded).toBe(2)
    expect(result.results.map((r) => r.fileId).sort()).toEqual(['i0', 'i1'])
    expect(spendCredits.mock.calls.map((c) => c[0].key).sort()).toEqual(['image:c1:tc-b:0', 'image:c1:tc-b:1'])
  })

  it('does not charge an item whose gateway call is refused (image charges only after success)', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'POLICY' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateImages.execute!({ items: [imgItem('one')] } as never, batchCtx()) as { failed: number; results: Array<Record<string, unknown>> }

    expect(result.failed).toBe(1)
    expect(result.results[0]).toMatchObject({ index: 0, refused: true, refusalReason: 'POLICY' })
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('rejects an empty batch and a batch over MAX_BATCH_ITEMS', () => {
    const schema = generateImages.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ items: [] }).success).toBe(false)
    expect(schema.safeParse({ items: [1, 2, 3, 4, 5].map((n) => imgItem(String(n))) }).success).toBe(false)
    expect(schema.safeParse({ items: [1, 2, 3, 4].map((n) => imgItem(String(n))) }).success).toBe(true)
  })

  it('requireApproval delegates to shouldRequireApproval with image_generation and the image model', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctx = { requestContext: {} }
    const requireApproval = generateImages.requireApproval as unknown as (input: unknown, ctx: unknown) => Promise<boolean>
    expect(await requireApproval({ items: [imgItem('x')] }, ctx)).toBe(true)
    expect(shouldRequireApproval).toHaveBeenCalledWith({ resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview' }, ctx)
  })
})
```

Implementation:

```ts
// generateImages.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  generateImageItem, imageItemSchema, imageOutputSchema, IMAGE_MODEL, type ImageItemInput,
} from './generateImage.js'
import { shouldRequireApproval } from './generationApproval.js'
import { MAX_BATCH_ITEMS, runBatch, type MediaExecContext } from './batchRunner.js'

export const generateImages = createTool({
  id: 'generate-images',
  description: `Generates up to ${MAX_BATCH_ITEMS} images in parallel in ONE call, one item per image, each with the same fields as generate_image. Use only for images that are independent of each other (each depends at most on an anchor that already exists, such as a cast sheet). Costs one approval card for the whole batch. Returns a per-item results list; a failed item is reported without failing the others.`,
  inputSchema: z.object({ items: z.array(imageItemSchema).min(1).max(MAX_BATCH_ITEMS) }),
  outputSchema: z.object({
    results: z.array(imageOutputSchema.extend({ index: z.number() })),
    succeeded: z.number(),
    failed: z.number(),
  }),
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'image_generation', subject: IMAGE_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { items } = inputData as { items: ImageItemInput[] }
    return runBatch(items, (item, index) =>
      generateImageItem(item, execContext as unknown as MediaExecContext, index))
  },
})
```

- [ ] **Step 9: Run all new and touched tool tests plus type-check**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/` — expected: PASS.
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors (test files are included in this type-check; the casts in the plan's test code are what make them compile). If `videoOutputSchema.extend` fails to type-check because the schema is wrapped, use `z.object({ ...videoOutputSchema.shape, index: z.number() })` instead (same for image).

- [ ] **Step 10: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/batchRunner.ts apps/agent-orchestrator/src/mastra/tools/batchRunner.test.ts apps/agent-orchestrator/src/mastra/tools/generateVideos.ts apps/agent-orchestrator/src/mastra/tools/generateVideos.test.ts apps/agent-orchestrator/src/mastra/tools/generateImages.ts apps/agent-orchestrator/src/mastra/tools/generateImages.test.ts
git commit -m "feat(agent-orchestrator): add generate-videos and generate-images batch tools"
```

---

### Task 5: Approval card `count` (orchestrator and API)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/generationApproval.batch.test.ts`
- Modify: `apps/agent-orchestrator/src/persistence.ts` (`GenerationConfirmRequestPayload`)
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts` (approval branch, around line 564)
- Test: `apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts`
- Modify: `products/agent-platform/packages/api/routes/messages.ts`
- Test: `products/agent-platform/packages/api/__tests__/messages.generation-confirm.test.ts`

**Interfaces:**
- Produces: `GENERATION_APPROVAL_METADATA` entries carry an optional `buildCount?: (args: Record<string, unknown>) => number | undefined`; four new keys `generate-videos`, `generate_videos`, `generate-images`, `generate_images`. The `generation_confirm_request` SSE event and the persisted request gain optional `count?: number`. `messages.ts` exports `generationConfirmRequestSchema`.

- [ ] **Step 1: Write the failing metadata test**

```ts
// generationApproval.batch.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@serverless-saas/credits', () => ({ isUnlimited: vi.fn(), resolveRate: vi.fn() }))

import { GENERATION_APPROVAL_METADATA } from './generationApproval.js'

describe('batch generation approval metadata', () => {
  it.each(['generate-videos', 'generate_videos'])('%s prices as video generation with count = item count', (name) => {
    const meta = GENERATION_APPROVAL_METADATA[name]
    expect(meta).toMatchObject({ resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash', label: 'Generate videos' })
    expect(meta.buildCount!({ items: [{}, {}, {}] })).toBe(3)
  })

  it.each(['generate-images', 'generate_images'])('%s prices as image generation with count = item count', (name) => {
    const meta = GENERATION_APPROVAL_METADATA[name]
    expect(meta).toMatchObject({ resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview', label: 'Generate images' })
    expect(meta.buildCount!({ items: [{}, {}] })).toBe(2)
  })

  it('returns no count when items is missing or not an array', () => {
    expect(GENERATION_APPROVAL_METADATA['generate_videos'].buildCount!({})).toBeUndefined()
    expect(GENERATION_APPROVAL_METADATA['generate_videos'].buildCount!({ items: 'x' })).toBeUndefined()
  })

  it('leaves single-item tools without a count', () => {
    expect(GENERATION_APPROVAL_METADATA['generate_video'].buildCount).toBeUndefined()
    expect(GENERATION_APPROVAL_METADATA['generate_image'].buildCount).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generationApproval.batch.test.ts`
Expected: FAIL — `GENERATION_APPROVAL_METADATA['generate-videos']` is undefined.

- [ ] **Step 3: Implement the metadata**

In `generationApproval.ts`, add `buildCount?: (args: Record<string, unknown>) => number | undefined` to the value type of `GENERATION_APPROVAL_METADATA`, then add above it:

```ts
const itemCount = (args: Record<string, unknown>): number | undefined =>
  Array.isArray(args.items) ? args.items.length : undefined
const videoBatchGen = { ...videoGen, label: 'Generate videos', buildCount: itemCount }
const imageBatchGen = { ...imageGen, label: 'Generate images', buildCount: itemCount }
```

and inside the record add:

```ts
  'generate-videos': videoBatchGen,
  'generate_videos': videoBatchGen,
  'generate-images': imageBatchGen,
  'generate_images': imageBatchGen,
```

Also update the exact-key assertion in `generationApproval.test.ts` (`describe('GENERATION_APPROVAL_METADATA')` → `it('has an entry for every gated tool id')`): add `'generate-images', 'generate_images', 'generate-videos', 'generate_videos',` to the expected array (the test sorts both sides, so position does not matter). Without this the existing test fails on the four new keys.

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generationApproval.batch.test.ts src/mastra/tools/generationApproval.test.ts` — expected: PASS.

- [ ] **Step 4: Write the failing chatStream tests**

`chatStream.tool-approval.test.ts` replaces the whole `../mastra/tools/generationApproval.js` module with a mock whose `GENERATION_APPROVAL_METADATA` has only a `'generate-image'` entry (around lines 44-49). Without a batch entry, `generate_videos` takes chatStream's unmapped-tool auto-approve path and the new test would time out waiting for the event. First add the entry to that mock:

```ts
vi.mock('../mastra/tools/generationApproval.js', () => ({
  GENERATION_APPROVAL_METADATA: {
    'generate-image': { resourceType: 'image_generation', subject: 'model-x', label: 'Generate image' },
    'generate_videos': {
      resourceType: 'video_generation', subject: 'model-v', label: 'Generate videos',
      buildCount: (args: Record<string, unknown>) => (Array.isArray(args.items) ? args.items.length : undefined),
    },
  },
  detectSkillPii: () => '',
}))
```

Then add the two tests below.

Add to the first `describe('runChatStream — tool-call-approval round trip', …)` block in `chatStream.tool-approval.test.ts`:

```ts
  it('includes the item count on generation_confirm_request for a batch tool', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate_videos', toolCallId: 'tc-b1', args: { items: [{}, {}, {}] } } }],
      'run-b1',
    ))
    approveToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-b1',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({
        confirmationId: 'tc-b1', resourceType: 'video_generation', count: 3,
      }))
    )
    pendingToolApprovals.get('tc-b1')?.resolve({ confirmed: true })
    await runPromise
  })

  it('omits count on generation_confirm_request for a single-item tool', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-s1', args: { prompt: 'a cat' } } }],
      'run-s1',
    ))
    approveToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-s1',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-s1' }))
    )
    const payload = sendEvent.mock.calls.find((c) => c[0] === 'generation_confirm_request')![1]
    expect(payload).not.toHaveProperty('count')
    pendingToolApprovals.get('tc-s1')?.resolve({ confirmed: true })
    await runPromise
  })
```

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/chatStream.tool-approval.test.ts -t "item count|omits count"`
Expected: the batch test FAILS (the mocked metadata entry now maps the tool, so the event is sent, but chatStream does not add `count` yet); the single-item test passes already and guards against regressions.

- [ ] **Step 5: Implement in `chatStream.ts` and `persistence.ts`**

In `persistence.ts`, add `count?: number` to `GenerationConfirmRequestPayload` (next to `preview?`).

In `chatStream.ts`'s `tool-call-approval` case, after `const preview = meta.buildPreview?.(args)` add `const count = meta.buildCount?.(args)`, then add `...(count ? { count } : {}),` to BOTH the `sendEvent('generation_confirm_request', { … })` object and the object passed to `saveGenerationConfirmRequest`.

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/chatStream.tool-approval.test.ts` — expected: PASS.

- [ ] **Step 6: Write the failing API schema test**

Add to `products/agent-platform/packages/api/__tests__/messages.generation-confirm.test.ts` (a new top-level `describe`, using the file's existing mocks):

```ts
describe('generationConfirmRequestSchema', () => {
  const base = { id: 'x', resourceType: 'video_generation', subject: 's', label: 'Generate videos', status: 'pending' as const }

  it('keeps an integer count between 1 and 20', async () => {
    const { generationConfirmRequestSchema } = await import('../routes/messages')
    expect(generationConfirmRequestSchema.parse({ ...base, count: 3 }).count).toBe(3)
  })

  it('rejects zero, fractional, and oversized counts', async () => {
    const { generationConfirmRequestSchema } = await import('../routes/messages')
    for (const count of [0, 1.5, 21]) {
      expect(generationConfirmRequestSchema.safeParse({ ...base, count }).success).toBe(false)
    }
  })

  it('still accepts a request with no count', async () => {
    const { generationConfirmRequestSchema } = await import('../routes/messages')
    expect(generationConfirmRequestSchema.parse(base)).not.toHaveProperty('count')
  })
})
```

Run: `pnpm --filter <api package name from products/agent-platform/packages/api/package.json> exec vitest run __tests__/messages.generation-confirm.test.ts` (read the package's `name` and its `test` script first and use its own command).
Expected: FAIL — `generationConfirmRequestSchema` is not exported.

- [ ] **Step 7: Implement the API schema**

In `routes/messages.ts`, lift the inline `z.object({ id, resourceType, subject, label, preview, status, decisionAt, declineReason })` (the value of `generationConfirmRequest`, currently just above `uploadRequest`) into `export const generationConfirmRequestSchema = z.object({ …same fields…, count: z.number().int().min(1).max(20).optional() })` defined at module top level (add the comment `// Upper bound is deliberately looser than the orchestrator's MAX_BATCH_ITEMS (4) so raising that limit needs no API change.` above the `count` line), and use `generationConfirmRequest: generationConfirmRequestSchema.nullish(),` in the save schema. Do not touch the PATCH route's separate status-only schema.

Run the same API test command — expected: PASS.

- [ ] **Step 8: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check` and the API package's type-check — expected: no errors.

```bash
git add apps/agent-orchestrator/src/mastra/tools/generationApproval.ts apps/agent-orchestrator/src/mastra/tools/generationApproval.test.ts apps/agent-orchestrator/src/mastra/tools/generationApproval.batch.test.ts apps/agent-orchestrator/src/persistence.ts apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts products/agent-platform/packages/api/routes/messages.ts products/agent-platform/packages/api/__tests__/messages.generation-confirm.test.ts
git commit -m "feat: carry an item count on the generation approval card for batch tools"
```

---

### Task 6: Fan a batch result out into attachments

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts` (lines ~153-169, ~271, ~677, ~692, ~709)
- Test: `apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts`

**Interfaces:**
- Consumes: existing `attachmentFromCanvasToolResult(normalizedToolName, result)`.
- Produces: `export function attachmentsFromToolResult(normalizedToolName: string, result: Record<string, unknown>): AttachmentPayload[]`. For `generate-videos`/`generate-images` it maps `result.results` (each entry treated as a `generate-video`/`generate-image` result respectively); for every other name it returns `[attachmentFromCanvasToolResult(...)]` filtered for null. `attachmentFromCanvasToolResult` stays exported and unchanged apart from nothing.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('runChatStream — delegate-produced attachments', …)` block:

```ts
  it('turns a batch tool-result into one attachment per succeeded item and none for failed items', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-batch-1',
            toolName: 'generate-videos',
            result: {
              results: [
                { index: 0, fileId: 'v-0', name: 'a.mp4', fileType: 'video/mp4', size: 10, creditsUsedMicro: '100000', model: 'google/gemini-omni-1.1-flash' },
                { index: 1, refused: true, refusalReason: 'GENERATION_FAILED' },
                { index: 2, fileId: 'v-2', name: 'c.mp4', fileType: 'video/mp4', size: 12 },
              ],
              succeeded: 2,
              failed: 1,
            },
          },
        },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-batch-1',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({
      attachments: [
        expect.objectContaining({ fileId: 'v-0', name: 'a.mp4', type: 'video/mp4', generation: { creditsUsedMicro: '100000', model: 'google/gemini-omni-1.1-flash' } }),
        expect.objectContaining({ fileId: 'v-2', name: 'c.mp4', type: 'video/mp4' }),
      ],
    }))
  })

  it('unwraps a batch result nested in a delegate wrapper (Olmo -> Director)', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-director-b',
            toolName: 'agent-director',
            result: {
              text: 'Generated two stills.',
              subAgentToolResults: [
                { toolName: 'generate_images', result: { results: [
                  { index: 0, fileId: 'i-0', name: 'a.png', fileType: 'image/png', size: 5 },
                  { index: 1, fileId: 'i-1', name: 'b.png', fileType: 'image/png', size: 6 },
                ], succeeded: 2, failed: 0 } },
              ],
            },
          },
        },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-director-b',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({
      attachments: [
        expect.objectContaining({ fileId: 'i-0' }),
        expect.objectContaining({ fileId: 'i-1' }),
      ],
    }))
  })
```

Also add a pure unit test at the top level of the same file (import `attachmentsFromToolResult` alongside `runChatStream`):

```ts
describe('attachmentsFromToolResult', () => {
  it('wraps a single-file result and returns [] for an unknown tool or a fileId-less result', () => {
    expect(attachmentsFromToolResult('generate-video', { fileId: 'f', name: 'n', fileType: 'video/mp4', size: 1 })).toHaveLength(1)
    expect(attachmentsFromToolResult('retrieve-template', { fileId: 'f' })).toEqual([])
    expect(attachmentsFromToolResult('generate-video', { refused: true })).toEqual([])
  })

  it('returns [] for a batch result with no results array', () => {
    expect(attachmentsFromToolResult('generate-videos', {})).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/chatStream.tool-approval.test.ts -t "batch|attachmentsFromToolResult"`
Expected: FAIL — `attachmentsFromToolResult` is not exported and the batch results yield no attachments.

- [ ] **Step 3: Implement**

Below `attachmentFromCanvasToolResult` in `chatStream.ts` add:

```ts
const BATCH_TOOL_ITEM_NAME: Record<string, string> = {
  'generate-videos': 'generate-video',
  'generate-images': 'generate-image',
}

/**
 * One tool-result to zero or more attachments. Batch tools return
 * { results: [...] } with one single-tool-shaped entry per item; each
 * succeeded entry becomes its own attachment, failed entries none.
 */
export function attachmentsFromToolResult(
  normalizedToolName: string,
  result: Record<string, unknown>,
): AttachmentPayload[] {
  const itemName = BATCH_TOOL_ITEM_NAME[normalizedToolName]
  if (itemName) {
    if (!Array.isArray(result.results)) return []
    return (result.results as Array<Record<string, unknown>>)
      .map((entry) => attachmentFromCanvasToolResult(itemName, entry))
      .filter((a): a is AttachmentPayload => a !== null)
  }
  const single = attachmentFromCanvasToolResult(normalizedToolName, result)
  return single ? [single] : []
}
```

Then:
- In the `tool-result` case replace
  `const canvasAttachment = attachmentFromCanvasToolResult(normName, result)` / `if (canvasAttachment) pendingAttachments.push(canvasAttachment)`
  with `pendingAttachments.push(...attachmentsFromToolResult(normName, result))`.
- In the `subAgentToolResults` loop replace the `innerAttachment` two lines with `pendingAttachments.push(...attachmentsFromToolResult(innerName, innerResult))`.
- Add `'generate-videos'` and `'generate-images'` to the `SAVE_TOOL_NAMES` set (line ~271) and to the exclusion array in the `if (SAVE_TOOL_NAMES.has(normName) && ![…].includes(normName))` condition (line ~677), so they are treated like the other generation tools there (no artifact ref).

- [ ] **Step 4: Run tests and type-check**

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/chatStream.tool-approval.test.ts` — expected: PASS.
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts
git commit -m "feat(agent-orchestrator): attach every succeeded item of a batch generation result"
```

---

### Task 7: Register the tools and teach Director and Olmo to batch

Registering the tools is not enough. Olmo's own `UGC_CHARACTER_CONTRACT` (in `platformAgent.ts`) currently tells it that N beats means N separate approvals and to delegate "each beat's still" and "each approved still" individually, so on the Olmo → Director path Director would only ever receive one item per delegation and have nothing to batch. Both prompts change here.

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (imports; both `tools:` objects at ~lines 113 and 132; prompt lines ~33, ~82 and the one-at-a-time bullet at ~83)
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (hoist and rewrite `UGC_CHARACTER_CONTRACT` at ~line 372; one phrase in `DELEGATION_CONTRACT` at ~line 346)
- Modify: `docs/media-generation/README.md` (open question near line 189)
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/agents/__tests__/ugcCharacterContract.test.ts`

**Interfaces:**
- Consumes: `generateVideos`, `generateImages` from Task 4.
- Produces: both `directorAgent` and `directorAgentDelegate` expose `generate_videos` and `generate_images`; `platformAgent.ts` exports `UGC_CHARACTER_CONTRACT` as a module-level string constant (like the already-exported `SKILL_CREATION_CONTRACT`).

- [ ] **Step 1: Write the failing tests**

Add to `directorAgent.test.ts`:

```ts
describe('directorAgent batch generation tools', () => {
  it('registers generate_videos and generate_images on both Director agents', async () => {
    for (const agent of [directorAgent, directorAgentDelegate]) {
      const tools = await agent.listTools()
      expect(Object.keys(tools)).toEqual(expect.arrayContaining(['generate_videos', 'generate_images']))
    }
  })

  it('tells Director to batch independent items and to keep dependent calls sequential', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Custom persona override text.')
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('generate_videos')
    expect(text).toContain('in ONE call')
    expect(text).toContain('Issue generation calls strictly one at a time')
    expect(text).toContain('priced for the whole batch')
    expect(text).toContain('each entry of the results list')
  })
})
```

Create `ugcCharacterContract.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { UGC_CHARACTER_CONTRACT } from '../platformAgent.js'

describe('UGC_CHARACTER_CONTRACT', () => {
  it('tells Olmo to delegate whole stages in one delegation, not one beat at a time', () => {
    expect(UGC_CHARACTER_CONTRACT).toContain('ALL beats')
    expect(UGC_CHARACTER_CONTRACT).toContain('in ONE delegation')
  })

  it('no longer tells Olmo that every beat needs its own separate approval', () => {
    expect(UGC_CHARACTER_CONTRACT).not.toContain('there is no single approval that covers the whole board today')
  })

  it('still requires the cast sheet first and board approval before any video', () => {
    expect(UGC_CHARACTER_CONTRACT).toContain('generate the cast sheet')
    expect(UGC_CHARACTER_CONTRACT).toContain('approve the set as a whole')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/directorAgent.test.ts src/mastra/agents/__tests__/ugcCharacterContract.test.ts`
Expected: FAIL — the tools are not registered, the Director prompt has no batch text, and `UGC_CHARACTER_CONTRACT` is not exported.

- [ ] **Step 3: Implement the Director changes**

In `directorAgent.ts`:

1. Add `import { generateVideos } from '../tools/generateVideos.js'` and `import { generateImages } from '../tools/generateImages.js'` next to the existing tool imports.
2. In BOTH `tools: { … }` objects add `generate_videos: generateVideos, generate_images: generateImages,` (underscore keys, matching the convention in the comment above them).
3. Line ~33 (`- Before claiming an image is ready, check the tool result for a fileId field. …`): append the sentence ` For a batch call (generate_images or generate_videos) check each entry of the results list instead: only an entry with its own fileId produced media.`
4. Line ~82: replace `- Every still and every video render triggers its own separate cost confirmation — this is expected, do not treat repeated approval cards as an error.` with `- Every single-item still or video render triggers its own cost confirmation, and every batch call triggers one confirmation priced for the whole batch — this is expected, do not treat repeated approval cards as an error.`
5. Directly after the existing bullet that begins `- Issue generation calls strictly one at a time:` (which stays untouched), add:

```
- When several stills or clips are independent — each one depends only on an anchor that is already approved (the cast sheet, or an approved still) and none needs another new output from the same batch — issue them in ONE call: generate_images with items: [...] or generate_videos with items: [...], at most 4 items per call. Each item takes the same fields as the matching single tool. One cost-confirmation card covers the whole batch. Anything that needs another new generation's output first (for example an animate_frame clip whose startImageFileId is a still you have not generated yet) must wait for that result and go in a later call. A batch counts as one generation call for the one-at-a-time rule above. The returned results list has one entry per item: for any entry that is refused, apply the same refusal handling as for the single tool. Do not retry refused items automatically; tell the requester which items failed and why, and only re-issue them in a new call if asked, since a retry needs a fresh approval card.
```

- [ ] **Step 4: Implement the Olmo changes**

In `platformAgent.ts`:

1. `UGC_CHARACTER_CONTRACT` is currently a `const` declared inside the function that builds Olmo's instructions. It contains no `${…}` interpolation. Cut the whole declaration (`const UGC_CHARACTER_CONTRACT = \`…\``) and paste it at module top level as `export const UGC_CHARACTER_CONTRACT = \`…\``, next to the already-exported `SKILL_CREATION_CONTRACT`. Leave the existing use (`… + UGC_CHARACTER_CONTRACT + …`) untouched. If it turns out to interpolate a variable after all, stop and report instead of hoisting.
2. In the hoisted text replace steps 2, 4 and 6 (steps 1, 3, 5 and 7 stay word for word):

   Step 2 becomes:
   `2. Tell the user plainly, before delegating: stills are generated in batches of up to 4 and each batch is one cost confirmation card priced for the whole batch; video clips work the same way. A board of N beats therefore needs about N/4 confirmations for stills and about N/4 for video, and credits are still charged per item.`

   Step 4 becomes:
   `4. Delegate to agent-director to generate the stills for ALL beats in ONE delegation, each with its per-beat mode as usual. Director batches up to 4 per call and splits a larger board itself. Do not delegate one beat per message.`

   Step 6 becomes:
   `6. Delegate to agent-director to render ALL approved stills into video clips in ONE delegation. Director batches up to 4 clips per call. Do not delegate one clip per message.`
3. In `DELEGATION_CONTRACT` (~line 346) replace the phrase `a subAgentToolResults entry with an actual fileId` with `a subAgentToolResults entry with an actual fileId (for a batch generate_videos or generate_images entry, one or more items inside its results list, each with its own fileId)`.

- [ ] **Step 5: Update the media-generation README**

In `docs/media-generation/README.md`, replace the open-question bullet

```
- How many images a single call may produce, and what is charged when a batch
  partially fails.
```

with

```
- (Resolved 2026-09-23) Batch size and partial failure: `generate_videos` and
  `generate_images` take up to 4 independent items per call, with one approval
  card priced per item, and each item is charged and refunded independently
  under its own key. See
  `docs/superpowers/specs/2026-09-23-batch-media-generation-design.md`.
```

- [ ] **Step 6: Run tests and the whole suite**

Run: `cd apps/agent-orchestrator && npx vitest run` — expected: PASS.
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/agents/platformAgent.ts apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts apps/agent-orchestrator/src/mastra/agents/__tests__/ugcCharacterContract.test.ts docs/media-generation/README.md
git commit -m "feat(agent-orchestrator): register batch generation tools and teach Director and Olmo to batch"
```

---

### Task 8: Web — price the approval card for the batch and recognise the batch tools

**Files:**
- Modify: `apps/web/components/platform/chat/types.ts` (`GenerationConfirmRequest`)
- Modify: `apps/web/hooks/useChat.ts` (callback type at line ~29, SSE case at ~362)
- Modify: `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts` (`onGenerationConfirmRequired`, ~line 460)
- Modify: `apps/web/components/platform/chat/MessageThread.tsx` (the `ApproveCost` usage, ~line 440)
- Modify: `apps/web/components/platform/chat/ToolCallCard.tsx` (`isImageGenTool`, `isVideoGenTool`, `mediaGenFailureReason`)
- Modify: `apps/web/components/platform/chat/ThinkingIndicator.tsx` (~line 136)
- Test: `apps/web/components/platform/credits/ApproveCost.test.tsx`, `apps/web/app/[tenant]/dashboard/chat/useChatStream.test.tsx`
- Create: `apps/web/components/platform/chat/ToolCallCard.batch.test.ts`

**Interfaces:**
- Consumes: the `count` field on the `generation_confirm_request` SSE payload (Task 5) and the batch result shape `{ results: [{ index, fileId?, refused?, … }], succeeded, failed }` (Task 4).
- Produces: `GenerationConfirmRequest.count?: number`; a 6th positional argument `count?: number` on `onGenerationConfirmRequired`; `ApproveCost` receives `params={{ count }}`; `ToolCallCard.tsx` exports `mediaGenFailureReason`.

- [ ] **Step 1: Write the failing tests**

(a) Add to `ApproveCost.test.tsx` inside `describe('ApproveCost', …)`. This one passes already, because `ApproveCost` supports `params.count` today; it locks that contract:

```tsx
    it('requests the estimate for the batch size when params.count is given', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '6000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        render(
            <ApproveCost
                label="Generate videos"
                resourceType="video_generation"
                subject="google/gemini-omni-1.1-flash"
                params={{ count: 3 }}
                onApprove={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        await screen.findByTestId('approve-cost');
        expect(apiGetMock.mock.calls[0][0]).toContain('count=3');
    });
```

(b) In `useChatStream.test.tsx`, make the mocked `useChat` remember the options it was given. Change the hoisted mock object and the mock factory to:

```tsx
const chatMock = vi.hoisted(() => ({
    sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(),
    cancel: vi.fn(),
    lastOptions: undefined as undefined | { onGenerationConfirmRequired?: (...args: unknown[]) => void },
}));

vi.mock('@/hooks/useChat', () => ({
    useChat: (options: { onGenerationConfirmRequired?: (...args: unknown[]) => void }) => {
        chatMock.lastOptions = options;
        return {
            sendMessage: chatMock.sendMessage,
            sendApproval: vi.fn(),
            sendGenerationConfirm: vi.fn(),
            sendClarificationAnswer: vi.fn(),
            sendUploadAnswer: vi.fn(),
            cancel: chatMock.cancel,
            isStreaming: false,
            isRetrying: false,
        };
    },
}));
```

then append:

```tsx
describe('useChatStream generation confirm', () => {
    const conversationIdRef = { current: 'conversation-1' };

    function setup() {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        renderHook(() => useChatStream({
            conversationId: 'conversation-1',
            conversationIdRef,
            agentId: 'agent-1',
            selectedConversation: undefined,
            messages: [],
            handleCanvasUpdate: vi.fn(),
            openCanvas: vi.fn(),
        }), { wrapper });
        return client;
    }

    const pendingRequest = (client: QueryClient) =>
        client.getQueryData<{ data: Array<{ generationConfirmRequest?: Record<string, unknown> }> }>(['messages', 'conversation-1'])
            ?.data[0]?.generationConfirmRequest;

    it('stores the batch count on the pending request', () => {
        const client = setup();
        act(() => {
            chatMock.lastOptions!.onGenerationConfirmRequired!('conf-1', 'video_generation', 'google/gemini-omni-1.1-flash', 'Generate videos', undefined, 3);
        });
        expect(pendingRequest(client)).toMatchObject({ id: 'conf-1', status: 'pending', count: 3 });
    });

    it('omits count for a single-item request', () => {
        const client = setup();
        act(() => {
            chatMock.lastOptions!.onGenerationConfirmRequired!('conf-2', 'image_generation', 'gemini-3-pro-image-preview', 'Generate image');
        });
        expect(pendingRequest(client)).not.toHaveProperty('count');
    });
});
```

(c) Create `ToolCallCard.batch.test.ts`:

```ts
/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { mediaGenFailureReason } from './ToolCallCard';

describe('mediaGenFailureReason for batch tools', () => {
    it('reports no failure when at least one item produced a file', () => {
        expect(mediaGenFailureReason('generate_videos', {
            results: [{ index: 0, fileId: 'f' }, { index: 1, refused: true }],
        })).toBeNull();
    });

    it('reports a failure when no item produced a file', () => {
        expect(mediaGenFailureReason('generate_videos', { results: [{ index: 0, refused: true }] })).toBe('Video generation failed');
        expect(mediaGenFailureReason('generate_images', { results: [{ index: 0, insufficientCredits: true }] })).toBe('Image generation failed');
    });

    it('still handles a single-item result', () => {
        expect(mediaGenFailureReason('generate_video', { fileId: 'f' })).toBeNull();
        expect(mediaGenFailureReason('generate_video', { refused: true })).toBe('Video generation failed');
    });
});
```

- [ ] **Step 2: Run to see the expected state**

Run: `cd apps/web && npx vitest run components/platform/credits/ApproveCost.test.tsx "app/[tenant]/dashboard/chat/useChatStream.test.tsx" components/platform/chat/ToolCallCard.batch.test.ts`
Expected: the ApproveCost test PASSES (already supported). "stores the batch count" FAILS (the handler ignores a 6th argument). `ToolCallCard.batch.test.ts` FAILS (`mediaGenFailureReason` is not exported, so calling it throws). "omits count" passes and guards against regressions.

- [ ] **Step 3: Implement**

In `types.ts` add to `GenerationConfirmRequest`:

```ts
    /** Number of items in a batch generation. Absent for single-item tools. */
    count?: number;
```

In `useChat.ts` change the callback type to `(confirmationId: string, resourceType: string, subject: string, label: string, preview?: string, count?: number) => void` and in the `'generation_confirm_request'` case add a sixth argument `typeof payload.count === 'number' ? payload.count : undefined`.

In `useChatStream.ts` change `onGenerationConfirmRequired` to `(confirmationId: string, resourceType: string, subject: string, label: string, preview?: string, count?: number) => {` and the constructed request to `generationConfirmRequest: { id: confirmationId, resourceType, subject, label, status: 'pending', ...(preview ? { preview } : {}), ...(count ? { count } : {}) },`.

In `MessageThread.tsx` add to the `<ApproveCost … />` props: `params={pendingGenerationConfirm.request.count ? { count: pendingGenerationConfirm.request.count } : undefined}`.

In `ToolCallCard.tsx`:
- `isImageGenTool` also returns true for `'generate_images'` and `'generate-images'`; `isVideoGenTool` also for `'generate_videos'` and `'generate-videos'`.
- Change `function mediaGenFailureReason(` to `export function mediaGenFailureReason(`.
- At the top of its body, right after `if (!result) return null;`, add:

```ts
  if (Array.isArray(result.results)) {
    const entries = result.results as Array<Record<string, unknown>>;
    if (entries.some((entry) => typeof entry.fileId === 'string')) return null;
    return isVideoGenTool(toolName) ? 'Video generation failed' : 'Image generation failed';
  }
```

A batch result has no top-level `fileId`, so without this branch a fully successful batch would be shown as a failed generation.

In `ThinkingIndicator.tsx` (~line 136) extend the `isImageGen` condition with `|| tc.toolName === 'generate_images' || tc.toolName === 'generate-images'`.

- [ ] **Step 4: Type-check and run web tests**

Run: `cd apps/web && pnpm type-check` — expected: no errors.
Run: `cd apps/web && npx vitest run components/platform "app/[tenant]/dashboard/chat"` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/chat/types.ts apps/web/hooks/useChat.ts "apps/web/app/[tenant]/dashboard/chat/useChatStream.ts" "apps/web/app/[tenant]/dashboard/chat/useChatStream.test.tsx" apps/web/components/platform/chat/MessageThread.tsx apps/web/components/platform/chat/ToolCallCard.tsx apps/web/components/platform/chat/ToolCallCard.batch.test.ts apps/web/components/platform/chat/ThinkingIndicator.tsx apps/web/components/platform/credits/ApproveCost.test.tsx
git commit -m "feat(web): price the approval card for the batch and recognise the batch tools"
```

---

### Task 9: Full verification and live check

**Files:** none changed unless a step below finds a defect.

- [ ] **Step 1: Full test suites and type-checks**

Run: `cd apps/agent-orchestrator && npx vitest run` — expected: PASS, zero failures.
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors.
Run: `cd apps/web && npx vitest run && pnpm type-check` — expected: PASS, no errors.
Run the API package's own test and type-check scripts (read its `package.json`) — expected: PASS.
Run: `git grep -n -e "untilIdle" -e "refundStaleBackgroundTask" -e "background:" -- apps/agent-orchestrator/src/mastra/tools apps/agent-orchestrator/src/routes` — expected: no matches.

- [ ] **Step 2: Confirm single-tool behaviour is unchanged**

Run: `git diff f521fba9 HEAD --stat -- apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`
Expected: only additions (new tests) plus the earlier `a5e1f45b` cast fix; no existing assertion was edited or removed.

- [ ] **Step 3: Live verification (mandatory before merge, needs a human and a running dev stack)**

Deploy-independent checklist for a person to run, then record the outcome in the PR description:
1. Start the dev stack (orchestrator on 3001, web) with a billed test tenant that requires approval.
2. Through Olmo → Director, ask for a cast sheet, approve it, then ask for 3 clips that depend only on that sheet. Confirm: one approval card priced for 3 clips, the three gateway calls overlapping in time, and three attachments landing in one reply.
3. In Mastra Studio open the run's `mastra_span_events` and confirm a single `generate_videos` tool call whose child spans overlap.
4. Force one item to fail (an `identityAnchor` whose tag is missing from the prompt) and confirm the card total is unchanged, the failed item is reported, and the credit ledger shows a debit+refund only for the items that were charged and failed.
5. Confirm the card reloads with the same count after a page refresh (the count is persisted with the request).
6. Record the observed maximum concurrent gateway calls, whether Vertex returned any 429 with 4 items (and whether the gateway's video circuit breaker opened), and the orchestrator and gateway memory peak. If there were 429s or memory looks tight, lower `MAX_BATCH_ITEMS` in `batchRunner.ts` and re-run its tests.
7. Confirm Olmo delegates whole stages: for a multi-beat UGC ad it should send all beats' stills to Director in one delegation and Director should issue `generate_images` batches, not one call per beat. If Olmo still delegates one beat at a time, the Task 7 prompt edits did not take effect; check the assembled instructions in the span trace.

No commit for this task unless Step 3 finds a defect.

---

## Known limits carried from the spec

- The turn blocks until the slowest item finishes (up to the 270s video gateway timeout).
- Approval is all-or-nothing for the batch.
- `MAX_BATCH_ITEMS = 4` is unverified against real gateway quota; Task 9 Step 3 checks it.
- Skill text seeded in the DB may still say "generate each beat"; Director's prompt overrides it only partly. Editing the skills is out of scope.

Found by the plan review, accepted rather than fixed here:

- One item that fails input validation (for example `animate_frame` without `startImageFileId`) fails the whole batch, because Mastra validates tool input after the user has approved the card. Nothing is charged in that case.
- The gateway's video circuit breaker (`geminiVideoBreaker`, `apps/inference-gateway/src/circuit-breaker.ts`) opens after 3 failures for 60 seconds, and there is no 429 backoff anywhere. A 4-item batch that draws rate-limit errors can trip it, and a retry during the open window fails and costs another approval card. Director's prompt therefore says not to retry refused items automatically.
- Up to 4 inline base64 videos are held in memory in the gateway and in the orchestrator at once, and no PM2 `max_memory_restart` is configured. Probably fine, untested; Task 9 Step 3 should note memory while it runs.
- Image items that share reference images each download them separately (up to 25MB each).
- An image item that hits `InsufficientCreditsError` has already been generated at vendor cost, and that result is discarded. Batches make this more likely; the approval card's balance check against the full batch price mitigates it.
- The web tool card shows a batch as one card with singular loading text, and reports a failure only when every item failed. Partial failures are reported through the assistant's reply and the per-item results, not the card.
- The `attempt` slot of the video chargeKey now carries the item index, so a future retry counter needs a different key shape (see Global Constraints).

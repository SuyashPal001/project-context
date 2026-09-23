# Batch Media Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `generate_videos` / `generate_images` tools that generate up to 4 independent items in parallel inside one synchronous tool call, with one approval card priced for the whole batch, working through both direct Director and Olmo → Director.

**Architecture:** Extract the body of `generateVideo`/`generateImage` into exported per-item functions that take an item index (used in the chargeKey). The single tools call them with index 0 (behaviour and keys unchanged). New batch tools run `Promise.allSettled` over the per-item function. The approval card, the SSE confirm event, the persisted confirm request, and the web card gain an optional `count`. `chatStream.ts` fans a batch result out into one attachment per succeeded item. The abandoned native-background-task work is reverted first.

**Tech Stack:** TypeScript, Mastra (`@mastra/core@1.64.0`), Vitest, Zod, Hono (`apps/agent-orchestrator`, `products/agent-platform/packages/api`), Next.js/React (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-09-23-batch-media-generation-design.md`

**Spec correction:** the spec says the new tools register on "the director and producer delegates". Only `directorAgent.ts` registers generation tools, on two agents: the standalone `directorAgent` and the Olmo-facing `directorAgentDelegate`. Register on those two. There is no producer registration to touch.

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
- Modify `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` — register tools, add prompt bullet.
- Modify `products/agent-platform/packages/api/routes/messages.ts` — accept `count`; extend `__tests__/messages.generation-confirm.test.ts`.
- Modify web: `components/platform/chat/types.ts`, `hooks/useChat.ts`, `app/[tenant]/dashboard/chat/useChatStream.ts`, `components/platform/chat/MessageThread.tsx`; extend `components/platform/credits/ApproveCost.test.tsx`.

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

If git reports a conflict (expected in `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`, where `a5e1f45b`'s cast fix sits next to the tests `bc7b94fc` appended): resolve so the file equals `f521fba9`'s version plus `a5e1f45b`'s fix — that is, keep the "builds a deterministic chargeKey…" test with the `{ ...(baseCtx() as { requestContext: RequestContext }) ... }` style cast from `a5e1f45b`, and drop the two background tests and the `backgroundTaskRefund.js` mock. Then `git add` the file and run `git revert --continue` only if git is mid-sequence; with `--no-commit` just `git add` the resolved files.

- [ ] **Step 3: Verify the resulting tree**

Run: `git diff f521fba9 --stat -- apps products packages`
Expected: exactly one file listed, `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`, and its diff (`git diff f521fba9 -- apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts`) contains only the cast fix from `a5e1f45b`.

Run: `grep -rn "background\|untilIdle\|refundStaleBackgroundTask" apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/routes/chatStream.ts`
Expected: no matches.

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

  it('refunds when the post-charge upload throws instead of returning null', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('s3 down'))
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateVideoItem(
      { mode: 'text_to_video', prompt: 'anything', aspectRatio: '16:9', durationSeconds: 8 },
      baseCtx(),
      0,
    )

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund' }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED', jobId: expect.any(String) })
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts -t "generateVideoItem|single generateVideo tool|upload throws"`
Expected: FAIL — `generateVideoItem` is not exported (import error), so all three fail.

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
   - `const attempt = 0` becomes `const attempt = itemIndex`, and the comment above it gets one added sentence: `In a batch call the item index occupies this slot so each item has its own key; the single tool passes 0.`
   - Replace the unguarded upload call
     ```ts
     const attachment = await uploadGeneratedFile(idToken, {
       conversationId, title: 'Generated Video', content: buffer,
       contentType: genResult.mimeType, extension,
     })
     ```
     with
     ```ts
     let attachment: Awaited<ReturnType<typeof uploadGeneratedFile>> = null
     try {
       attachment = await uploadGeneratedFile(idToken, {
         conversationId, title: 'Generated Video', content: buffer,
         contentType: genResult.mimeType, extension,
       })
     } catch (err) {
       console.error(`[session:${sessionId}] generateVideo: upload threw:`, (err as Error).message)
     }
     ```
     A throw here used to escape after the charge and leak it; a batch cannot refund a charge it never saw, so the refund must happen in the item function. The existing `if (!attachment) { … refund … STORAGE_FAILED }` branch below now covers it.

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

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts` — expected: PASS (every existing test plus the three new ones).
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

  it('refunds when the post-charge upload throws instead of returning null', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('s3 down'))
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateImageItem({ prompt: 'a red bicycle' }, baseCtx(), 0)

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund' }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED' })
  })
```

If `getPool` is not already a hoisted mock in this test file, mirror how the existing "refunds with the original grants' shortest expiry when the post-charge upload fails" test in the same file sets up the pool, and copy that setup instead of the two `getPool` lines above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts -t "generateImageItem|upload throws"`
Expected: FAIL — `generateImageItem` is not exported.

- [ ] **Step 3: Implement the extraction**

In `generateImage.ts`:

1. Add `import type { MediaExecContext } from './batchRunner.js'`.
2. `const IMAGE_MODEL` becomes `export const IMAGE_MODEL`. `const outputSchema` becomes `export const imageOutputSchema`.
3. Lift the inline `inputSchema: z.object({ … })` from `createTool` into `export const imageItemSchema = z.object({ … })` (same fields, same `.describe` strings), plus `export type ImageItemInput = z.infer<typeof imageItemSchema>`.
4. Move the `execute` body into `export async function generateImageItem(inputData: ImageItemInput, execContext: MediaExecContext | undefined, itemIndex: number)`. Edits inside:
   - The destructure of `inputData` drops its inline `as { … }` cast (the parameter is already typed).
   - The chargeKey line becomes `const chargeKey = \`image:${conversationId ?? sessionId}:${toolCallId}:${itemIndex}\`` and its comment gets `The item index occupies the attempt slot; the single tool passes 0.`
   - Replace
     ```ts
     const attachment = conversationId && idToken
       ? await uploadGeneratedFile(idToken, { … })
       : null
     ```
     with
     ```ts
     let attachment: Awaited<ReturnType<typeof uploadGeneratedFile>> = null
     if (conversationId && idToken) {
       try {
         attachment = await uploadGeneratedFile(idToken, {
           conversationId, title: 'Generated Image', content: buffer,
           contentType: genResult.mimeType, extension,
         })
       } catch (err) {
         console.error(`[session:${sessionId}] generateImage: upload threw:`, (err as Error).message)
       }
     }
     ```
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

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts` — expected: PASS (all existing tests, including the `image:c1:tc-1:0` one, plus the two new).
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
    const started = Date.now()
    const out = await runBatch([0, 1, 2], async (_item, index) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 60))
      inFlight -= 1
      return { fileId: `f${index}` }
    })
    expect(maxInFlight).toBe(3)
    expect(Date.now() - started).toBeLessThan(150) // three serial waits would be 180ms+
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
  const results = settled.map((s, index) => {
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
    const schema = generateVideos.inputSchema!
    expect(schema.safeParse({ items: [] }).success).toBe(false)
    expect(schema.safeParse({ items: [item('1'), item('2'), item('3'), item('4'), item('5')] }).success).toBe(false)
    expect(schema.safeParse({ items: [item('1'), item('2'), item('3'), item('4')] }).success).toBe(true)
  })

  it('requireApproval delegates to shouldRequireApproval with video_generation and the video model', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctx = { requestContext: {} }
    const needs = await generateVideos.requireApproval!({ items: [item('x')] } as never, ctx as never)
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
    const schema = generateImages.inputSchema!
    expect(schema.safeParse({ items: [] }).success).toBe(false)
    expect(schema.safeParse({ items: [1, 2, 3, 4, 5].map((n) => imgItem(String(n))) }).success).toBe(false)
    expect(schema.safeParse({ items: [1, 2, 3, 4].map((n) => imgItem(String(n))) }).success).toBe(true)
  })

  it('requireApproval delegates to shouldRequireApproval with image_generation and the image model', async () => {
    shouldRequireApproval.mockResolvedValue(true)
    const ctx = { requestContext: {} }
    expect(await generateImages.requireApproval!({ items: [imgItem('x')] } as never, ctx as never)).toBe(true)
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
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors. If `videoOutputSchema.extend` fails to type-check because the schema is wrapped, use `z.object({ ...videoOutputSchema.shape, index: z.number() })` instead (same for image).

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

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generationApproval.batch.test.ts src/mastra/tools/generationApproval.test.ts` — expected: PASS.

- [ ] **Step 4: Write the failing chatStream tests**

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
Expected: the batch test FAILS (no `count` in the event; note the unmapped-tool fallback would also have auto-approved before the metadata step, so this confirms the metadata is now consulted); the single-item test passes already and guards against regressions.

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

In `routes/messages.ts`, lift the inline `z.object({ id, resourceType, subject, label, preview, status, decisionAt, declineReason })` (the value of `generationConfirmRequest`, currently just above `uploadRequest`) into `export const generationConfirmRequestSchema = z.object({ …same fields…, count: z.number().int().min(1).max(20).optional() })` defined at module top level, and use `generationConfirmRequest: generationConfirmRequestSchema.nullish(),` in the save schema. Do not touch the PATCH route's separate status-only schema.

Run the same API test command — expected: PASS.

- [ ] **Step 8: Type-check and commit**

Run: `pnpm --filter agent-orchestrator type-check` and the API package's type-check — expected: no errors.

```bash
git add apps/agent-orchestrator/src/mastra/tools/generationApproval.ts apps/agent-orchestrator/src/mastra/tools/generationApproval.batch.test.ts apps/agent-orchestrator/src/persistence.ts apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/chatStream.tool-approval.test.ts products/agent-platform/packages/api/routes/messages.ts products/agent-platform/packages/api/__tests__/messages.generation-confirm.test.ts
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

### Task 7: Register the tools and update Director's prompt

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (imports; both `tools:` objects at ~lines 113 and 132; the one-at-a-time bullet's neighbourhood at ~line 83)
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts`

**Interfaces:**
- Consumes: `generateVideos`, `generateImages` from Task 4.
- Produces: both `directorAgent` and `directorAgentDelegate` expose `generate_videos` and `generate_images`; Director's instructions contain the batch guidance.

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
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: FAIL — the tools are not registered and the prompt has no batch text.

- [ ] **Step 3: Implement**

In `directorAgent.ts`: add `import { generateVideos } from '../tools/generateVideos.js'` and `import { generateImages } from '../tools/generateImages.js'` next to the existing tool imports. In BOTH `tools: { … }` objects add `generate_videos: generateVideos, generate_images: generateImages,` (keys with underscores, matching the existing convention noted in the comment above them). Then, directly after the existing bullet that begins `- Issue generation calls strictly one at a time:` (which must remain untouched), add this bullet:

```
- When several stills or clips are independent — each one depends only on an anchor that is already approved (the cast sheet, or an approved still) and none needs another new output from the same batch — issue them in ONE call: generate_images with items: [...] or generate_videos with items: [...], at most 4 items per call. Each item takes the same fields as the matching single tool. One cost-confirmation card covers the whole batch. Anything that needs another new generation's output first (for example an animate_frame clip whose startImageFileId is a still you have not generated yet) must wait for that result and go in a later call. A batch counts as one generation call for the one-at-a-time rule above. The returned results list has one entry per item: for any entry that is refused, apply the same refusal handling as for the single tool, and retry only those items in a new batch call.
```

- [ ] **Step 4: Run tests and the whole suite**

Run: `cd apps/agent-orchestrator && npx vitest run` — expected: PASS.
Run: `pnpm --filter agent-orchestrator type-check` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts
git commit -m "feat(agent-orchestrator): register batch generation tools and teach Director to batch"
```

---

### Task 8: Web — pass the count to the approval card

**Files:**
- Modify: `apps/web/components/platform/chat/types.ts` (`GenerationConfirmRequest`)
- Modify: `apps/web/hooks/useChat.ts` (callback type at line ~29, SSE case at ~362)
- Modify: `apps/web/app/[tenant]/dashboard/chat/useChatStream.ts` (`onGenerationConfirmRequired`, ~line 460)
- Modify: `apps/web/components/platform/chat/MessageThread.tsx` (the `ApproveCost` usage, ~line 440)
- Test: `apps/web/components/platform/credits/ApproveCost.test.tsx`

**Interfaces:**
- Consumes: the `count` field on the `generation_confirm_request` SSE payload (Task 5).
- Produces: `GenerationConfirmRequest.count?: number`; the 6th positional callback argument `count?: number` on `onGenerationConfirmRequired`; `ApproveCost` receives `params={{ count }}`.

- [ ] **Step 1: Write the failing test**

Add to `ApproveCost.test.tsx` inside `describe('ApproveCost', …)`:

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

Run: `cd apps/web && npx vitest run components/platform/credits/ApproveCost.test.tsx`
Expected: PASS already, because `ApproveCost` supports `params.count` today. This test locks that contract; the failing part of this task is the type-check in Step 2.

- [ ] **Step 2: Add the field and watch the type-check catch missing wiring**

In `types.ts` add to `GenerationConfirmRequest`:

```ts
    /** Number of items in a batch generation. Absent for single-item tools. */
    count?: number;
```

In `useChat.ts` change the callback type to `(confirmationId: string, resourceType: string, subject: string, label: string, preview?: string, count?: number) => void` and in the `'generation_confirm_request'` case add a sixth argument `typeof payload.count === 'number' ? payload.count : undefined`.

In `useChatStream.ts` change `onGenerationConfirmRequired` to `(confirmationId: string, resourceType: string, subject: string, label: string, preview?: string, count?: number) => {` and the constructed request to `generationConfirmRequest: { id: confirmationId, resourceType, subject, label, status: 'pending', ...(preview ? { preview } : {}), ...(count ? { count } : {}) },`.

In `MessageThread.tsx` add to the `<ApproveCost … />` props: `params={pendingGenerationConfirm.request.count ? { count: pendingGenerationConfirm.request.count } : undefined}`.

- [ ] **Step 3: Type-check and run web tests**

Run: `cd apps/web && pnpm type-check` — expected: no errors.
Run: `cd apps/web && npx vitest run components/platform` — expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/platform/chat/types.ts apps/web/hooks/useChat.ts "apps/web/app/[tenant]/dashboard/chat/useChatStream.ts" apps/web/components/platform/chat/MessageThread.tsx apps/web/components/platform/credits/ApproveCost.test.tsx
git commit -m "feat(web): price the generation approval card for the batch size"
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
6. Record the observed maximum concurrent gateway calls and whether Vertex returned any 429 with 4 items; if it did, lower `MAX_BATCH_ITEMS` in `batchRunner.ts` and re-run its tests.

No commit for this task unless Step 3 finds a defect.

---

## Known limits carried from the spec

- The turn blocks until the slowest item finishes (up to the 270s video gateway timeout).
- Approval is all-or-nothing for the batch.
- `MAX_BATCH_ITEMS = 4` is unverified against real gateway quota; Task 9 Step 3 checks it.
- Skill text seeded in the DB may still say "generate each beat"; Director's prompt overrides it only partly. Editing the skills is out of scope.

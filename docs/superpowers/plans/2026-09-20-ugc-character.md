# ugc-character (skill 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `ugc-character` skill — build a UGC-style ad from scratch (no template to clone), casting a presenter from a product photo, generating a consistent multi-beat storyboard, and rendering each approved beat as a video clip.

**Architecture:** Same Olmo-carries-conversation / Director-executes-generation split as skill 1. Phase 0 adds real multi-reference support to `generate_image`, a new `analyze_image` tool, and tool-code identity-anchor enforcement (mirroring `generateVideo.ts`'s dialogue gate). Phase 1 is prose added to `directorAgent.ts`/`platformAgent.ts` plus the working-memory template's existing `Casting Choice`/`Locked Reference Artifact IDs` fields — no new schema, no new agent.

**Tech Stack:** Mastra agents (`@mastra/core`), Hono inference gateway, Zod tool schemas, Postgres credit ledger (`@serverless-saas/credits`).

**Spec:** `docs/superpowers/specs/2026-09-20-ugc-character-design.md` (third revision — read its "Revision note (round 3)" before starting; this plan does not re-litigate what that review already fixed).

## Global Constraints

- **No new database schema.** Cast-sheet identity is carried in Olmo's existing working-memory fields (`Casting Choice`, `Locked Reference Artifact IDs`) — do not add a `creative_characters` table or similar for v1.
- **`generate_video`'s three modes stay mutually exclusive** (`text_to_video` / `animate_frame` / `composite_references`) — do not weaken the existing `.refine()` guards.
- **Any string a prompt "must" contain verbatim gets a tool-code check, never a prose-only instruction** — this is the identity-anchor pattern (mirrors `generateVideo.ts`'s `extractQuotedSpans`/`approvedDialogue`).
- **Never write a realism-modifier or frame-prompt phrase inside quotation marks** — the dialogue gate refuses any quoted span that isn't the exact `approvedDialogue` line, and most beats in this skill have none.
- **No silent paid retries.** Any regeneration (a wordmark fix, a rejected board still) requires a fresh user-visible approval, per `COST_CONFIRMATION_CONTRACT` — never auto-retry a charged call.
- **Board-level cost approval is NOT batched in v1.** Each `generate_image`/`generate_video` call independently triggers its own approval card. Do not build or assume an `allowMode`-based batching mechanism — it is not operable by Olmo (server-only, human-UI-only write path) and must not appear anywhere in this implementation.
- **Real per-tenant credit rates must exist for `image_generation`/`gemini-3-pro-image-preview` before any live test** — `resolveRate` returning null means the charge silently no-ops (same class of gap skill 1's Task 6 fixed for video).

---

## Phase 0: prerequisite tool work (multi-reference `generate_image`, `analyze_image`, identity-anchor enforcement)

**Phase 0 must be fully merged and Task 5's live checkpoint must pass before any Phase 1 task starts.** This is a hard gate, not a suggestion — same discipline as skill 1's Phase 0/Phase 0.5 split.

### Task 1: Add multi-source-image support to the image gateway

**Files:**
- Modify: `apps/inference-gateway/src/images.ts:25-59`
- Modify: `apps/inference-gateway/src/images.test.ts` — **this file already exists (158 lines, 8 tests covering `classifyGeminiImageResponse` and the no-Ollama-fallback invariant). APPEND a new `describe` block to it — do not overwrite the file, or the existing fallback-invariant regression suite is silently deleted.**

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `ImageGenerationRequest.sourceImages?: Array<{ base64: string; mimeType: string }>` — Task 2 sends this field. `sourceImageBase64`/`sourceMimeType` (the existing single-image fields `edit_image` already sends) stay unchanged and unremoved — `buildGeminiImageRequest` must accept either or both without error.

**Ground truth:** `buildGeminiImageRequest` today pushes **exactly one** optional inline image part (`if (req.sourceImageBase64 && req.sourceMimeType) parts.push(...)`) — this is not already multi-image capable despite `parts` being an array type; it has never pushed more than one image. This task adds real support for N images, it is not wiring up an existing capability. The existing file imports from `'./images'` (no extension) — match that, do not introduce a `.js`-suffixed import in the same file.

- [ ] **Step 1: Append the failing test to the existing file**

```ts
// apps/inference-gateway/src/images.test.ts — ADD this describe block at the
// end of the existing file. Add `buildGeminiImageRequest` to the existing
// `import { classifyGeminiImageResponse, generateImage } from './images'` line
// at the top (Step 3 exports it) rather than adding a second import statement.

describe('buildGeminiImageRequest', () => {
  it('includes one inline image part per entry in sourceImages, in order', () => {
    const req = {
      model: 'gemini-3-pro-image-preview',
      prompt: 'a cast sheet',
      sourceImages: [
        { base64: 'AAAA', mimeType: 'image/png' },
        { base64: 'BBBB', mimeType: 'image/jpeg' },
      ],
    }
    const body = buildGeminiImageRequest(req)
    const parts = body.contents[0].parts
    expect(parts[0]).toEqual({ text: 'a cast sheet' })
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } })
    expect(parts[2]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } })
    expect(parts).toHaveLength(3)
  })

  it('still supports the single sourceImageBase64/sourceMimeType shape edit_image sends', () => {
    const req = {
      model: 'gemini-3-pro-image-preview',
      prompt: 'edit this',
      sourceImageBase64: 'CCCC',
      sourceMimeType: 'image/png',
    }
    const body = buildGeminiImageRequest(req)
    expect(body.contents[0].parts).toEqual([
      { text: 'edit this' },
      { inlineData: { mimeType: 'image/png', data: 'CCCC' } },
    ])
  })

  it('with no source image at all, sends only the text part', () => {
    const req = { model: 'gemini-3-pro-image-preview', prompt: 'a plain image' }
    const body = buildGeminiImageRequest(req)
    expect(body.contents[0].parts).toEqual([{ text: 'a plain image' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/images.test.ts`
Expected: FAIL — `buildGeminiImageRequest` is not exported, and `sourceImages` isn't a recognized field.

- [ ] **Step 3: Extend the request type and export the builder**

```ts
// apps/inference-gateway/src/images.ts
export interface ImageGenerationRequest {
  model: string
  prompt: string
  sourceImageBase64?: string
  sourceMimeType?: string
  // New: N identity/style-anchor reference images, pushed as additional
  // inline parts after any single sourceImageBase64. Capped at 3 by the
  // caller (generateImage.ts's Zod schema) — this gateway function itself
  // does not re-enforce a cap, it just forwards whatever array it's given.
  sourceImages?: Array<{ base64: string; mimeType: string }>
}
```

```ts
// buildGeminiImageRequest — was module-private, now exported for the test above
export function buildGeminiImageRequest(req: ImageGenerationRequest) {
  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }]
  if (req.sourceImageBase64 && req.sourceMimeType) {
    parts.push({ inlineData: { mimeType: req.sourceMimeType, data: req.sourceImageBase64 } })
  }
  for (const img of req.sourceImages ?? []) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } })
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
    safetySettings: SAFETY_SETTINGS,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/images.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/inference-gateway/src/images.ts apps/inference-gateway/src/images.test.ts
git commit -m "feat(gateway): support N reference images in image generation requests"
```

**Aggregate payload size, addressed in Task 2, not here:** the gateway's HTTP body-read cap (`apps/inference-gateway/src/index.ts:180`) is 40MB total, sized for one base64-inflated image. Three references at `generateImage.ts`'s existing 20MB-decoded-per-file cap could inflate to ~80MB combined and 413 after the user already approved cost. Task 2 adds an aggregate cap across all resolved references, not just a per-file one.

---

### Task 2: `generate_image` gains `referenceFileIds` and identity-anchor enforcement

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateImage.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/imageCredits.ts:16-18` — **required, or this task doesn't compile.** `refundImageCharge`'s `agentId` parameter is currently typed `string`, not `string | undefined`. Step 3 below fixes `generateImage.ts`'s `agentId ?? ''` bug (matching `generateVideo.ts`'s existing fix for the same class of bug), which means `generateImage.ts` will call `refundImageCharge(tenantId, agentId, ...)` with `agentId: string | undefined`. Widen the signature: `agentId: string | undefined` — this is backward compatible, `editImage.ts` (which still passes `agentId ?? ''`) keeps working unchanged.
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts` — **this file already exists (181 lines, 10 tests covering charge/refund/insufficient-credits/approval, including multi-grant refund-expiry logic). APPEND new tests to it using the exact existing mock pattern below — do not overwrite the file.**

**Interfaces:**
- Consumes: Task 1's `ImageGenerationRequest.sourceImages`.
- Produces: `generateImage`'s new input shape —
  ```ts
  {
    prompt: string
    referenceFileIds?: string[]      // 1-3 entries, each an existing files.id uuid
    identityAnchor?: { terseTag: string; styleLock: string }
  }
  ```
  Task 3 (video) and Phase 1's Director instructions both reference `identityAnchor`'s exact shape — keep the field names `terseTag`/`styleLock` identical in both tools.

**`resolveSourceImage` — confirmed, no extraction needed.** It lives at `apps/agent-orchestrator/src/media.ts` (imported as `'../../media.js'`, matching this codebase's ESM-with-`.js`-extension-on-`.ts`-files convention — same as `editImage.ts:6`), signature `(idToken: string, fileId: string, mimeType: string, sessionId: string) => Promise<{ base64: string; mimeType: string } | null>`. The `mimeType` argument is only a hint threaded into an internal attachment-type field; the **returned** `mimeType` comes from the real downloaded data URL. No edit-specific side effects — safe to call once per `referenceFileId` as-is, passing `'image/png'` as the hint each time.

- [ ] **Step 1: Append the failing tests to the existing file, matching its real mock pattern exactly**

```ts
// apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts — ADD to the
// existing file. It already defines `vi.hoisted` mocks for spendCredits/
// resolveRate/isUnlimited/getPool, mocks '../../usage.js' and
// './generationApproval.js', and a `ctx(values)`/`baseCtx()` helper using a
// real `RequestContext` — reuse all of that, do not redefine it.
// Add one more hoisted mock alongside the existing ones:
const { resolveSourceImage } = vi.hoisted(() => ({ resolveSourceImage: vi.fn() }))
vi.mock('../../media.js', () => ({ resolveSourceImage }))

// Then, inside (or alongside) the existing `describe('generateImage tool', ...)` block:
it('refuses before any charge when the prompt is missing the identityAnchor terseTag', async () => {
  const result = await generateImage.execute!(
    {
      prompt: 'A woman making coffee, wearing a cardigan.', // missing the exact terseTag string
      identityAnchor: { terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light' },
    } as never,
    baseCtx(),
  )
  expect(result).toEqual({ refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' })
  expect(spendCredits).not.toHaveBeenCalled()
})

it('refuses before any charge when the prompt is missing the identityAnchor styleLock', async () => {
  const result = await generateImage.execute!(
    {
      prompt: 'the woman in the yellow cardigan making coffee', // missing styleLock text
      identityAnchor: { terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light, 35mm lens' },
    } as never,
    baseCtx(),
  )
  expect(result).toEqual({ refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' })
})

it('resolves referenceFileIds and sends them as sourceImages when both identityAnchor strings are present', async () => {
  resolveSourceImage.mockResolvedValue({ base64: 'AAAA', mimeType: 'image/png' })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'ZZZZ', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
  global.fetch = fetchMock
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 10 })

  const result = await generateImage.execute!(
    {
      prompt: 'the woman in the yellow cardigan making coffee, warm morning light, 35mm lens',
      referenceFileIds: ['11111111-1111-1111-1111-111111111111'],
      identityAnchor: { terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light, 35mm lens' },
    } as never,
    baseCtx(),
  )
  expect(resolveSourceImage).toHaveBeenCalledWith('tok', '11111111-1111-1111-1111-111111111111', 'image/png', 'c1')
  const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
  expect(sentBody.sourceImages).toEqual([{ base64: 'AAAA', mimeType: 'image/png' }])
  expect((result as { fileId?: string }).fileId).toBe('f1')
})

// Regression test mirroring generateVideo.test.ts's existing "actorId:
// undefined" test (~line 330) for the identical class of bug: agentId must
// stay undefined, not '', or spendCredits' actorId hits Postgres as
// ''::uuid and throws before any charge. This guards Step 3's agentId fix
// below from being silently reverted later.
it('passes agentId as undefined (not empty string) to spendCredits when requestContext has no agentId set', async () => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ imageBase64: 'QUJD', mimeType: 'image/png' }), { status: 200 })) as unknown as typeof fetch
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 })

  await generateImage.execute!(
    { prompt: 'a red bicycle' } as never,
    ctx({ tenantId: 't1', conversationId: 'c1', idToken: 'tok' }), // no agentId key set
  )

  expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ actorId: undefined }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts`
Expected: FAIL, but note the real pre-fix reason precisely — `beforeEach` calls `vi.resetAllMocks()` (line 41 of the existing file), which strips any implementation off a `vi.fn()` left over from a prior test, including `global.fetch`. So on the two `IDENTITY_ANCHOR_MISSING` tests, `fetch()` resolves to `undefined` (never stubbed for those two), `res.ok` throws inside the tool's own try/catch, and the pre-fix result is `{ refused: true, refusalReason: 'GENERATION_FAILED' }` — a red test, but NOT because the tool "proceeded to a charged success"; it fails a different way that happens to also be a refusal shape. The third test (`referenceFileIds` → `sourceImages`) fails because the field is never read or sent. The new `agentId: undefined` regression test currently fails because `generateImage.ts:36` still has `?? ''`.

- [ ] **Step 3: Extend the schema, resolve references, enforce the anchor**

```ts
// apps/agent-orchestrator/src/mastra/tools/generateImage.ts — replace the existing inputSchema and add the check
import { resolveSourceImage } from '../../media.js'

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024 // matches editImage.ts's existing per-file cap
// Aggregate cap across ALL resolved references in one call. The gateway's
// HTTP body-read limit (apps/inference-gateway/src/index.ts:180) is 40MB
// total, sized for one base64-inflated image — three references at the
// per-file cap above could inflate to ~80MB combined and 413 after the user
// already approved cost. 25MB decoded total leaves headroom under the
// gateway's 40MB raw-body cap once JSON/base64 overhead is included.
const MAX_TOTAL_REFERENCE_BYTES = 25 * 1024 * 1024

export const generateImage = createTool({
  id: 'generate-image',
  description: 'Generates a new image from a text prompt using Gemini 3 Pro Image, optionally anchored on 1-3 reference images for identity/style consistency. Use when the user asks Director to create, draw, or generate an image.',
  inputSchema: z.object({
    prompt: z.string().describe('Full description of the image to generate'),
    referenceFileIds: z.array(z.string().uuid()).min(1).max(3).optional()
      .describe('Existing files rows used as identity/style anchors — the model composes a new image informed by all of them.'),
    identityAnchor: z.object({
      terseTag: z.string(),
      styleLock: z.string(),
    }).optional().describe('When set, prompt MUST contain both strings verbatim — enforced in code. Required whenever referenceFileIds includes a cast sheet.'),
  }),
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'image_generation', subject: IMAGE_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { prompt, referenceFileIds, identityAnchor } = inputData as {
      prompt: string
      referenceFileIds?: string[]
      identityAnchor?: { terseTag: string; styleLock: string }
    }

    // Identity-anchor gate — enforced in tool code, not prose, mirroring
    // generateVideo.ts's extractQuotedSpans/approvedDialogue check. Refuses
    // before any charge or gateway call.
    if (identityAnchor && (!prompt.includes(identityAnchor.terseTag) || !prompt.includes(identityAnchor.styleLock))) {
      return { refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' }
    }

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    // Left undefined, not defaulted to '' — matches generateVideo.ts's fix
    // for the same field: spendCredits' actorId param does `?? null`
    // internally, so undefined casts cleanly to ::uuid, but '' hits Postgres
    // as ''::uuid and throws, aborting the whole charge before the gateway
    // is ever called. generateImage.ts's PRE-EXISTING `?? ''` on this same
    // line is a real, separate latent bug — fix it here while this line is
    // already being touched, do not re-copy the `?? ''` default.
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'

    let sourceImages: Array<{ base64: string; mimeType: string }> = []
    if (referenceFileIds?.length) {
      if (!idToken) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
      let totalBytes = 0
      for (const fileId of referenceFileIds) {
        const source = await resolveSourceImage(idToken, fileId, 'image/png', sessionId)
        if (!source) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
        const decodedBytes = Buffer.byteLength(source.base64, 'base64')
        if (decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
          return { refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }
        }
        totalBytes += decodedBytes
        if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
          return { refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }
        }
        sourceImages.push(source)
      }
    }

    let genResult: { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, ...(sourceImages.length ? { sourceImages } : {}) }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateImage gateway call failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    // ... rest of execute (refused check, imageBase64 validation, charge,
    // upload, refund-on-failure) unchanged from the current implementation.
  },
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateImage.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateImage.ts apps/agent-orchestrator/src/mastra/tools/generateImage.test.ts
git commit -m "feat(orchestrator): add referenceFileIds and identityAnchor enforcement to generate_image"
```

---

### Task 3: `generate_video` gains the same `identityAnchor` enforcement

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`

**Interfaces:**
- Consumes: Task 2's `identityAnchor` shape (`{ terseTag: string; styleLock: string }`) — must stay field-identical.
- Produces: `generateVideo`'s input schema gains the same optional `identityAnchor` field; Phase 1's Director instructions for on-camera beat video renders pass it.

- [ ] **Step 1: Write the failing test**

**Match the existing file's real invocation style** (`generateVideo.execute!(input as never, ctx)` with a `RequestContext`-based `ctx()` helper, same shape as `generateImage.test.ts` — verify the exact existing helper in `generateVideo.test.ts` before writing this and reuse it rather than inventing a new context shape):

```ts
// add to apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts, reusing
// that file's own existing ctx()/baseCtx() helper and mock setup
it('refuses with IDENTITY_ANCHOR_MISSING before any charge when identityAnchor strings are absent from the prompt', async () => {
  const result = await generateVideo.execute!(
    {
      mode: 'animate_frame',
      prompt: 'A woman making coffee, handheld feel, slight camera shake.',
      aspectRatio: '9:16',
      durationSeconds: 6,
      startImageFileId: '11111111-1111-1111-1111-111111111111',
      identityAnchor: { terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light' },
    } as never,
    baseCtx(),
  )
  // Cast, matching this file's own existing pattern for a narrowed result
  // shape (e.g. `as { refused?: boolean }` elsewhere in this file) — the
  // tool's inferred return type is a union of object literals, and bare
  // property access on it is a type error under this repo's type-check.
  expect((result as { refused?: boolean }).refused).toBe(true)
  expect((result as { refusalReason?: string }).refusalReason).toBe('IDENTITY_ANCHOR_MISSING')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts -t "IDENTITY_ANCHOR_MISSING"`
Expected: FAIL — field doesn't exist, check never runs.

- [ ] **Step 3: Add the field and the check**

```ts
// generateVideo.ts's inputSchema gains:
identityAnchor: z.object({
  terseTag: z.string(),
  styleLock: z.string(),
}).optional().describe('When set, prompt MUST contain both strings verbatim — enforced in code.'),
```

```ts
// In execute(), immediately after the existing quotedSpans/approvedDialogue
// check (generateVideo.ts:107-110) and before any image resolution or charge:
if (identityAnchor && (!prompt.includes(identityAnchor.terseTag) || !prompt.includes(identityAnchor.styleLock))) {
  return { refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING', jobId }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts`
Expected: PASS, including all pre-existing tests (regression check).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts
git commit -m "feat(orchestrator): add identityAnchor enforcement to generate_video"
```

---

### Task 4: New `analyze_image` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/analyzeImage.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/analyzeImage.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (register on both `directorAgent.tools` and `directorAgentDelegate.tools`)

**Interfaces:**
- Consumes: `fetchPresignedUrl` from `./mediaCache.js` (existing, used by `analyzeVideo.ts`).
- Produces: `analyze_image(fileId, question) → { success: boolean, answer?: string, error?: string }`. Phase 1's Director instructions call this for wordmark verification.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/tools/analyzeImage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))

import { analyzeImageTool } from './analyzeImage.js'
import { fetchPresignedUrl } from './mediaCache.js'

describe('analyzeImageTool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns success:false with no idToken/sessionId', async () => {
    const result = await analyzeImageTool.execute!(
      { fileId: 'f1', question: 'Does this spell ACME correctly?' },
      { requestContext: { get: () => undefined } } as never,
    )
    expect(result).toEqual({ success: false, error: 'no_active_session' })
  })

  it('asks the gateway and returns its answer', async () => {
    vi.mocked(fetchPresignedUrl).mockResolvedValue('https://example.com/img.png')
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: { get: () => 'image/png' } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'Yes, spelled correctly.' } }] }) }) as never

    const result = await analyzeImageTool.execute(
      { fileId: 'f1', question: 'Does this spell ACME correctly?' },
      { requestContext: { get: (k: string) => ({ idToken: 'tok', sessionId: 's1' } as Record<string, string>)[k] } } as never,
    )
    expect(result).toEqual({ success: true, answer: 'Yes, spelled correctly.' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/analyzeImage.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the tool**

```ts
// apps/agent-orchestrator/src/mastra/tools/analyzeImage.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchPresignedUrl } from './mediaCache.js'
import { persistCost } from '../cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const TIMEOUT_MS = 30_000

export const analyzeImageTool = createTool({
  id: 'analyze_image',
  description: 'Ask a specific yes/no or descriptive question about an image already attached to the conversation — e.g. verifying rendered text/wordmarks are spelled correctly.',
  inputSchema: z.object({
    fileId: z.string(),
    question: z.string().describe('The specific question to ask about the image, e.g. "Does this image spell ACME correctly? Answer yes or give the exact text as rendered."'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    answer: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    if (!idToken || !sessionId) return { success: false, error: 'no_active_session' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const presignedUrl = await fetchPresignedUrl(inputData.fileId, idToken, controller.signal)
      const imageRes = await fetch(presignedUrl, { signal: controller.signal })
      if (!imageRes.ok) return { success: false, error: `failed to fetch image: ${imageRes.status}` }
      const mimeType = imageRes.headers.get('content-type') ?? 'image/png'
      const base64 = Buffer.from(await imageRes.arrayBuffer()).toString('base64')

      const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({
          model: 'gemini-2.5-flash',
          temperature: 0.1,
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
              { type: 'text', text: inputData.question },
            ],
          }],
        }),
      })
      if (!response.ok) return { success: false, error: `gateway HTTP ${response.status}` }
      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const answer = result.choices?.[0]?.message?.content
      if (!answer) return { success: false, error: 'no answer returned' }
      // Cost tracking — matches analyzeVideo.ts's persistCost call. Without
      // this, every wordmark check is untracked LLM spend.
      if (tenantId && result.usage) {
        persistCost({
          tenantId,
          agentId: 'analyze-image',
          workflowId: 'media-understanding',
          model: 'gemini-2.5-flash',
          inputTokens: result.usage.prompt_tokens ?? 0,
          outputTokens: result.usage.completion_tokens ?? 0,
        })
      }
      return { success: true, answer }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('abort')) return { success: false, error: 'analysis timed out' }
      return { success: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  },
})
```

**Note:** matches `analyzeVideo.ts`'s pattern where possible. `extractVideoFrames` (in `media.ts`) already returns each frame pre-formatted as a `data:image/jpeg;base64,...` string, which is why `analyzeVideo.ts` passes `{ url: f.base64 }` directly with no extra wrapping — confirmed by reading `media.ts` directly. This tool works from raw fetched bytes instead (no frame extraction involved), so it constructs the same `data:${mimeType};base64,...` format itself before sending — consistent with the confirmed real format, not a guess.

- [ ] **Step 4: Register on Director's tool maps**

```ts
// directorAgent.ts — add the import
import { analyzeImageTool } from '../tools/analyzeImage.js'

// both directorAgent and directorAgentDelegate's tools: maps gain:
tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo, retrieve_template: retrieveTemplate, analyze_video: analyzeVideoTool, analyze_audio: analyzeAudioTool, analyze_image: analyzeImageTool },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/analyzeImage.test.ts`
Expected: PASS, both cases.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/analyzeImage.ts apps/agent-orchestrator/src/mastra/tools/analyzeImage.test.ts apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): add analyze_image tool, register on Director"
```

---

### Task 5: Phase 0 checkpoint — verify multi-reference `generate_image` live, against the real Gemini API

**This is not a code task. It is a go/no-go gate, same discipline as skill 1's Task 8.** Do not start Phase 1 until this passes.

**Files:**
- Read: project memory `project_delegate_network_migration` and `project_ugc_character_spec_status` for how skill 1's equivalent checkpoint was run and documented.

**Why this needs a live check, not just unit tests:** Tasks 1-2's unit tests mock the gateway response and only prove the *request* is shaped correctly. They do not prove Gemini's real API actually uses a second/third inline image as an identity anchor the way the design assumes, rather than ignoring extra images or erroring on them — this is exactly the class of assumption two prior rounds of review in this same skill caught wrong (the single-vs-multi-reference question itself).

- [ ] **Step 0:** Confirm a real `image_generation` credit rate exists for `gemini-3-pro-image-preview` on the test tenant (`packages/foundation/database/seeds/credit-rates.ts:20` seeds this — confirm the target dev tenant actually has it applied, not just that the seed script defines it). If `resolveRate` returns null, `generateImage.ts` logs `UNBILLED IMAGE GENERATION` and proceeds anyway — a live test could appear to pass while every generation is silently unbilled. Check this before Step 1, not after a confusing result.
- [ ] **Step 1:** In a local/dev environment with `GEMINI_API_KEY` set and the gateway running, call `POST /v1/images/generations` directly (not through the orchestrator) with a real `prompt` and two real `sourceImages` (e.g. a person photo and a product photo, both base64-encoded).
- [ ] **Step 2:** Inspect the returned image. Confirm it visibly incorporates identifiable elements from *both* source images (not just the first, not a generic image ignoring both).
- [ ] **Step 3:** Record the outcome — which model version, whether both images were used, any observed quality difference vs. a single-reference call — in `project_ugc_character_spec_status` project memory.
- [ ] **Step 4a: If both references are used correctly** — proceed to Phase 1.
- [ ] **Step 4b: If only the first reference has any visible effect** (same failure shape as `generate_video`'s known single-reference limitation) — this is a real, separate finding: report it back rather than proceeding, since Phase 1's cast-sheet-plus-product-photo design (spec step 2) assumes real multi-reference composition. Do not silently redesign Phase 1 around a single-reference constraint inside this plan — that decision needs to go back through spec review, per this skill's own established pattern of not quietly downgrading a requirement.

---

## Phase 1: the `ugc-character` skill

**Do not start until Task 5 resolves to 4a.**

### Task 6: Add the `UGC_CHARACTER_SECTION` to Director's instructions

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`
- Test: none new (prompt text) — verify manually per Step 3 below, same as skill 1's Task 12.

**Interfaces:**
- Consumes: Task 2's `generate_image` shape (`referenceFileIds`, `identityAnchor`), Task 3's `generate_video` `identityAnchor` field, Task 4's `analyze_image`.
- Produces: none consumed by later tasks — this is the terminal prose layer.

- [ ] **Step 1: Add a scoping fix to the existing `TEMPLATE_CLONING_SECTION` disclaimer, then append the new section — both following the exact pattern the file already uses** (appended after `base`, never merged into `defaultInstructions`, so a tenant's custom `agentSystemPrompt` override doesn't silently drop it).

**First, fix two real contradictions Task 2 introduces.**

`directorAgent.ts:37` currently reads (as part of the existing refusal-handling bullet list): *`"SOURCE_IMAGE_UNAVAILABLE" or "SOURCE_IMAGE_TOO_LARGE": tell the user the source image for the edit couldn't be used, and why.`* — framed as edit-only. After Task 2, `generate_image` can also return both codes for a reference/product image, not just `edit_image` for an edit source. Amend:

```ts
// directorAgent.ts:37 — amend in place
- "SOURCE_IMAGE_UNAVAILABLE" or "SOURCE_IMAGE_TOO_LARGE": tell the user the source or reference image couldn't be used, and why — this applies whether it came from an edit_image call or a generate_image call with referenceFileIds.
```

`directorAgent.ts:61` currently reads: *"only the first entry is used today — do not add a second image expecting it to take effect"*, referring to `generate_video`'s `referenceFileIds`. That line stays true for video, but after Task 2, `generate_image`'s `referenceFileIds` (a different tool, different array) DOES use every entry. Left as-is, this line sits one section above `UGC_CHARACTER_SECTION`'s own instruction to pass multiple references to `generate_image`, and a reader (or the model) has no way to tell the two arrays apart. Amend the existing line:

```ts
// directorAgent.ts:61 — amend in place
- If the template profile is human_demo, human_voiceover, or mixed, or no product still exists yet: call generate_video with mode: "composite_references" and referenceFileIds set to an array containing the product photo's fileId (only the first entry is used today for generate_video specifically — do not add a second image expecting it to take effect on a video call. generate_image's own referenceFileIds, used for UGC character work below, is a separate field on a separate tool and does use every entry).
```

```ts
// directorAgent.ts, alongside TEMPLATE_CLONING_SECTION
const UGC_CHARACTER_SECTION = `\n\n## UGC character generation — cast sheet, storyboard, and per-beat rendering
When Olmo delegates a UGC-style ad build with no template to clone:
- Cast sheet: call generate_image with referenceFileIds set to the product photo's fileId (one entry), producing one image showing the presenter in 3 emotional states, product views, and a scale line-up. Do not pass identityAnchor on this call — the terse tag and style-lock text don't exist yet.
- After the cast sheet succeeds, Olmo will give you a terseTag and styleLock string to use on every later call this conversation — always pass both as identityAnchor on every subsequent generate_image/generate_video call for an on-camera beat. Never reword either string; pass them exactly as given.
- If a generate_image or generate_video call returns refusalReason "IDENTITY_ANCHOR_MISSING": this means your own prompt text didn't contain the terseTag or styleLock string exactly as given — no credits were charged, but the retry still triggers a fresh cost-confirmation card for the user, same as any other call. Re-read the exact strings Olmo gave you and include both verbatim in the prompt before retrying; do not guess at a rewording.
- If a generate_image or edit_image call returns refusalReason "SOURCE_IMAGE_UNAVAILABLE" or "SOURCE_IMAGE_TOO_LARGE" for a reference/product image (not just an edit source): tell Olmo the reference image(s) couldn't be used or were too large — do not retry with the same references.
- Per-beat mode table:
  - On-camera beat still: generate_image with referenceFileIds set to the cast sheet's fileId and identityAnchor set.
  - On-camera beat video: generate_video with mode "animate_frame", startImageFileId set to that beat's approved still, and identityAnchor set.
  - B-roll beat (hands/product only, no presenter): generate_image with no referenceFileIds (or edit_image on the real product photo), and no identityAnchor. generate_video for this beat also uses mode "animate_frame" off that still — never mode "composite_references" with the cast sheet on a b-roll beat.
- Every still and every video render triggers its own separate cost confirmation — this is expected, do not treat repeated approval cards as an error.
- Frame prompts for stills should describe a frozen mid-moment (e.g. "about to speak to camera," "mid-pour") and end with a plain, UNQUOTED sentence describing paused-frame quality — never wrap this in quotation marks, since generate_video's dialogue gate refuses any quoted span that isn't an approved spoken line, and most beats here have none.
- Realism modifiers for on-camera beats (handheld feel, slight camera shake, candid, natural skin texture, imperfect framing) must also be written as plain UNQUOTED sentences, same reason.
- Wordmark handling: spell the brand name letter-by-letter in the still's prompt. After generating, call analyze_image on the result with a question like "Does this image spell {brand} correctly? Answer yes or give the exact text as rendered." If the answer indicates a mismatch, tell Olmo plainly rather than silently retrying — a fresh paid regeneration always needs a new user-visible approval, per the existing rule against retrying a failed result without fresh confirmation.
- Post-generation QA for any on-camera beat with spoken dialogue: same as template cloning — call analyze_audio (mode "deep") on the result and compare to approvedDialogue, flagging any meaningful mismatch rather than presenting it as matching.`
```

- [ ] **Step 2: Append it to `base`, same as the existing pattern**

```ts
// directorAgent.ts
const base = (override || defaultInstructions) + TEMPLATE_CLONING_SECTION + UGC_CHARACTER_SECTION
```

- [ ] **Step 3: Manual verification** — drive a real conversation through the deployed/local orchestrator: request a UGC-style ad with a product photo, confirm Director calls `generate_image` with `referenceFileIds` for the cast sheet, then correctly reuses `identityAnchor` on subsequent on-camera calls, and calls `analyze_image` at least once for wordmark checking if the brief includes brand text.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): add UGC_CHARACTER_SECTION to Director's instructions"
```

---

### Task 7: Add the Olmo-side conversational contract for ugc-character (intake, cast-sheet handoff, board review, honest N-cards framing)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`

**Interfaces:**
- Consumes: the working-memory template's existing `Casting Choice`/`Locked Reference Artifact IDs` fields (`memory.ts:150-176`, unchanged by this plan).
- Produces: none — terminal prose layer, same as Task 6.

**Real structure of `platformAgent.ts`'s instructions function, confirmed — the plan's earlier draft guessed wrong.** There is no appendable `const base = ... + X` per contract. Inside the `instructions` async function: `const base = override ?? await fetchPlatformPrompt()` (:307), `const composed = persona ? ... : base` (:313), then a series of `const XXX_CONTRACT = \`...\`` declarations (`CLARIFICATION_CONTRACT`, `COST_CONFIRMATION_CONTRACT`, `TEMPLATE_VIDEO_CONTRACT` at :364, etc.), and exactly one return statement concatenating all of them in a fixed order:

```ts
// platformAgent.ts:376-377 — the real, only, return statement
return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT
  + DELEGATION_CONTRACT + ROUTING_CONTRACT + COST_CONFIRMATION_CONTRACT + TEMPLATE_VIDEO_CONTRACT + THINKING_STYLE_CONTRACT + invokedSkillsInstruction(invokedThisTurn)
```

- [ ] **Step 1: Declare `UGC_CHARACTER_CONTRACT` next to `TEMPLATE_VIDEO_CONTRACT` (:364-371), and add it into the return statement, before `THINKING_STYLE_CONTRACT`:**

```ts
// platformAgent.ts — new const, declared in the same location/style as
// TEMPLATE_VIDEO_CONTRACT just above it
const UGC_CHARACTER_CONTRACT = `\n\n## UGC character ad — intake and board review
When the user wants a UGC-style ad built from scratch (no template to clone):
1. Intake: get a product photo. Three-tier fallback if none exists: (a) ask for a real photo, (b) if none is available, delegate to agent-director to generate one first via generate_image and use that as the product photo, (c) only if the user wants to proceed with no photo at all, continue text-only and tell them plainly that product identity will not be preserved. Never silently pick (c) when a photo could be provided. Ask target vibe/audience, number of beats, and whether they want the same script repeated or distinct variants — ask this BEFORE giving any cost estimate.
2. Tell the user plainly, before delegating: generating N beats means N separate cost confirmations for stills and N more for video — there is no single approval that covers the whole board today.
3. Delegate to agent-director to generate the cast sheet. Once it succeeds, derive a terseTag (10-40 characters, wardrobe-anchored, e.g. "the woman in the yellow cardigan") and a styleLock (a SHORT clause, under 80 characters, e.g. "warm morning light, 35mm lens" — not a full paragraph) from the brief and the cast sheet. Both strings are checked byte-for-byte against every later prompt in code, so keep them short and simple enough to copy-paste identically every time — do not vary punctuation, wording, or length once set. Write the cast sheet's fileId into working memory's Locked Reference Artifact IDs field and set Casting Choice to "generated character". Pass terseTag and styleLock to Director in every later delegation message for this ad, copied exactly, character for character — Director cannot see your working memory, you must restate them each time.
4. Delegate to agent-director to generate each beat's still, per its per-beat mode table.
5. Board review: once all stills exist, present them together and ask the user to approve the set as a whole for continuity — not each one individually. Only board-approved stills proceed to video. If the user rejects a still, regenerating it is a new paid call and needs its own fresh approval, same as any other retry.
6. Delegate to agent-director to render each approved still into a video clip.
7. Deliver each clip separately. Tell the user plainly that these clips are not assembled into one final ad, and that this character exists only in this conversation — it isn't saved to a reusable library.`
```

```ts
// platformAgent.ts:376-377 — amend the existing return statement in place
return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT
  + DELEGATION_CONTRACT + ROUTING_CONTRACT + COST_CONFIRMATION_CONTRACT + TEMPLATE_VIDEO_CONTRACT + UGC_CHARACTER_CONTRACT + THINKING_STYLE_CONTRACT + invokedSkillsInstruction(invokedThisTurn)
```

- [ ] **Step 2: Manual verification** — same live conversation as Task 6's Step 3, confirming Olmo asks variation count before pricing, states the N-cards expectation up front, writes to working memory after the cast sheet, and presents a board-review turn before any video renders.

- [ ] **Step 3: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(orchestrator): add UGC character intake and board-review contract to Olmo"
```

---

### Task 8: End-to-end live verification

**This is a go/no-go checkpoint, not a code task.**

- [ ] **Step 1:** Drive one full real conversation end to end: intake → cast sheet → 2-3 beat stills (on-camera and b-roll) → board review → video renders → delivery.
- [ ] **Step 2:** Confirm via `mastra_span_events` (per [[feedback_mastra_traces_first]] — query the trace store first, not logs) that each `generate_image`/`generate_video` call independently triggered `requireApproval`, and that `identityAnchor` values are byte-identical across every on-camera call in the run.
- [ ] **Step 3:** Confirm a deliberately-wrong wordmark scenario (misspell the brand in the still) is caught by `analyze_image` and surfaced to the user rather than silently retried.
- [ ] **Step 4:** Record the outcome in `project_ugc_character_spec_status` project memory — this closes out skill 2's implementation the same way skill 1's Task 8 closed out its own checkpoint.

## Self-review notes (completed during plan authoring, updated after two rounds of Opus review)

**Round 2 review findings, fixed:** `imageCredits.ts`'s `refundImageCharge` widened to accept `agentId: string | undefined` (Task 2 Files list) — without this the plan's `agentId ?? ''` fix doesn't compile. Task 2's Step 2 failure-reasoning corrected (the real pre-fix failure is `GENERATION_FAILED` from an unstubbed `fetch` after `vi.resetAllMocks()`, not a "charged success"). A genuine Task 2/Task 7 contradiction fixed: `styleLock` is now specified as a short clause (<80 chars), not a full paragraph, since Task 2's gate is an exact byte-for-byte substring check that a full paragraph would fail on any reflow. Added a regression test for the `agentId: undefined` fix (mirroring `generateVideo.test.ts`'s existing equivalent). Fixed missing `!` on `analyzeImageTool.execute` calls and missing type casts on `generateImage`/`generateVideo` test result access, matching this codebase's real test patterns. Corrected "this retry is free" to "no credits charged, but still triggers a fresh approval card." Resolved a soft contradiction between Director's existing edit-only `SOURCE_IMAGE_UNAVAILABLE`/`SOURCE_IMAGE_TOO_LARGE` refusal-handling line and its new applicability to `generate_image`.



- **Spec coverage:** Phase 0's multi-reference `generate_image` (Tasks 1-2), `generate_video`'s parallel `identityAnchor` (Task 3), and `analyze_image` (Task 4) map to the spec's three Phase 0 gaps. The live checkpoint (Task 5) covers the spec's explicit warning that multi-reference support needs verification against the real API, not just unit tests. Phase 1's cast sheet, per-beat mode table, board review, wordmark handling, and honest N-cards framing (Tasks 6-7) map directly to the spec's Phase 1 flow steps 2-4. Post-generation QA (spec step 6) is covered as an added instruction in Task 6 rather than a separate task, since it reuses skill 1's existing unenforced-prompt-instruction pattern verbatim — no new code, consistent with the spec's own honest framing of that step as prompt-only.
- **Placeholder scan:** no TBD/TODO markers; every step has real code or a concretely described manual action, not "add appropriate handling."
- **Type consistency:** `identityAnchor: { terseTag: string; styleLock: string }` is introduced once in Task 2 and used identically (same field names) in Tasks 3, 6, and 7. `referenceFileIds` matches the naming already established by `generate_video`'s existing field (Task 3 does not introduce a differently-named equivalent). `sourceImages: Array<{ base64, mimeType }>` is introduced once in Task 1 and consumed identically in Task 2.
- **Known open item carried forward, not silently resolved:** Task 5's step 4b path (if multi-reference generation turns out not to work against the real API) is deliberately left as "report back, don't redesign inline" — this plan does not pre-decide a single-reference fallback, since the spec's own history shows that kind of unilateral downgrade needs review, not a plan-author's unilateral call.

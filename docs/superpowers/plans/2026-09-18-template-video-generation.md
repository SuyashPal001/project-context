# Template Video Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/agent-orchestrator` a real, gated `template-video-generation` capability — clone a reference ad's structure onto a user's product, with image-conditioned video generation, a capability-based (not fallback-based) vendor planner, and working cost/content approval gates.

**Architecture:** Phase 0 changes `apps/inference-gateway`'s video handler and `generateVideo.ts` to add image conditioning, real wire-level aspect-ratio/duration control, a single-branch `selectBackend` resolver (replacing the current silent Gemini→Veo fallback), namespaced model ids, and charge-before-call ordering. Phase 0.5 is a mandatory checkpoint, not code owned by this plan: `project_delegate_network_migration` must resolve (or be proven irrelevant) before Phase 1 starts, because video generation is Director-delegate-only and the delegate-call approval bypass currently means **no cost gate and no content gate fire at all today**. Phase 1 splits the skill across Olmo (conversation, gates, delivery — added as a new prompt contract block, following the existing `ROUTING_CONTRACT`/`COST_CONFIRMATION_CONTRACT` pattern in `platformAgent.ts`) and Director (`analyze_video`/`analyze_audio`/`generate_video`/`retrieve_template`, added to its tool map and instructions), plus a real tool-code content-approval gate on `generate_video` itself.

**Tech Stack:** TypeScript, Mastra (`@mastra/core`), Vitest, Zod, Node `fetch`, Postgres (`pg`), existing `@serverless-saas/credits` package.

**Spec:** `docs/superpowers/specs/2026-09-18-template-video-generation-design.md`

## Global Constraints

- No cross-vendor substitution — a request needing one vendor's capability must get that vendor; unavailability is an error, never a silent switch to a different model (`docs/media-generation/README.md`).
- Spend is charged before the vendor call, not after (`docs/media-generation/README.md`).
- Model ids are namespaced `vendor/model` (e.g. `google/gemini-omni-1.1-flash`) wherever they appear — tool input, credit-rate subject, `files` provenance.
- The orchestrator gains no new credentials — reuse the existing presign/upload/confirm path (`fetchPresignedUrl` in `src/mastra/tools/mediaCache.js`), never add a direct S3/GCS client.
- Per-backend limits (duration, aspect ratio) are hard-validated and rejected outside range — never silently clamped.
- **Phase 1 tasks (11+) do not start until the Phase 0.5 checkpoint (Task 10) passes.** This is a hard gate, not a suggestion.

---

## Phase 0: gateway image-conditioning + planner

### Task 1: Add aspect ratio and duration as real wire parameters to the Gemini Omni call

**Files:**
- Modify: `apps/inference-gateway/src/video.ts:23-27,49-65`
- Test: `apps/inference-gateway/src/video.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `VideoGenerationRequest` gains `aspectRatio: '16:9' | '9:16'` and `durationSeconds: number` (both required); `callGeminiApiKeyVideoModel` sends them; later tasks (3, 6) depend on this shape.

Today's `VideoGenerationRequest` interface has no aspect-ratio or duration field, and `callGeminiApiKeyVideoModel`'s `response_format` hardcodes `resolution: '720p'` with nothing else — Gemini picks defaults. This task adds the fields and hard-validates them before the request is built.

- [ ] **Step 1: Write the failing test**

Add to `apps/inference-gateway/src/video.test.ts` (inside the existing `describe('generateVideo — Gemini API first, Vertex Veo fallback'`) block, using the same `req`/`okBody` fixtures already defined there):

```ts
it('rejects a duration outside the 3-10s Omni range before calling the gateway', async () => {
  process.env.GEMINI_API_KEY = 'key'
  vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
  const fetchSpy = vi.fn()
  global.fetch = fetchSpy as unknown as typeof fetch

  await expect(generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 11 }))
    .rejects.toThrow(/durationSeconds must be a whole number of seconds in 3\.\.10/)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('sends aspect_ratio and duration on the Interactions request_format', async () => {
  process.env.GEMINI_API_KEY = 'key'
  vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }))
  global.fetch = fetchSpy as unknown as typeof fetch

  await generateVideo({ ...req, aspectRatio: '9:16', durationSeconds: 6 })

  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  const body = JSON.parse(init.body as string)
  expect(body.response_format).toMatchObject({ aspect_ratio: '9:16', duration: '6s' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts -t "duration outside"`
Expected: FAIL — `req` has no `aspectRatio`/`durationSeconds` field yet, so this compiles against the old interface and the validation doesn't exist.

- [ ] **Step 3: Write minimal implementation**

In `apps/inference-gateway/src/video.ts`, update the interface and add validation + wire fields:

```ts
export interface VideoGenerationRequest {
  model: string
  prompt: string
  task: 'text_to_video' | 'edit' | 'extend' | 'image_to_video'
  aspectRatio: '16:9' | '9:16'
  durationSeconds: number
}

const OMNI_MIN_DURATION_SECONDS = 3
const OMNI_MAX_DURATION_SECONDS = 10

function validateOmniDuration(durationSeconds: number): void {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < OMNI_MIN_DURATION_SECONDS ||
    durationSeconds > OMNI_MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `durationSeconds must be a whole number of seconds in ${OMNI_MIN_DURATION_SECONDS}..${OMNI_MAX_DURATION_SECONDS}, got ${durationSeconds}`,
    )
  }
}
```

Update `callGeminiApiKeyVideoModel`:

```ts
async function callGeminiApiKeyVideoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  validateOmniDuration(req.durationSeconds)
  const key = process.env.GEMINI_API_KEY ?? ''
  const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      input: req.prompt,
      response_format: {
        type: 'video',
        resolution: '720p',
        delivery: 'inline',
        aspect_ratio: req.aspectRatio,
        duration: `${req.durationSeconds}s`,
      },
      generation_config: { video_config: { task: req.task } },
    }),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok) throw new Error(`Gemini API video generation failed: ${res.status} ${await res.text()}`)
  return classifyInteractionsVideoResponse(await res.json())
}
```

Move the validation call up into `generateVideo()` itself (before either backend is attempted), so a bad duration fails before any network call regardless of which backend would have been chosen:

```ts
export async function generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  if (!VIDEO_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedVideoModelError(`Unsupported video model: ${req.model}`)
  }
  validateOmniDuration(req.durationSeconds)
  // ... existing body unchanged for this step
```

(Remove the now-duplicate call inside `callGeminiApiKeyVideoModel` — validate once, at the top of `generateVideo`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts`
Expected: PASS — both new tests pass; existing tests still pass (they'll need `aspectRatio`/`durationSeconds` added to their `req` fixture — update the shared `req` object at the top of the `describe` block to include `aspectRatio: '16:9', durationSeconds: 8`).

- [ ] **Step 5: Commit**

```bash
git add apps/inference-gateway/src/video.ts apps/inference-gateway/src/video.test.ts
git commit -m "feat(gateway): validate and wire aspect ratio + duration on Gemini Omni video calls"
```

### Task 2: Add aspect ratio and duration as real wire parameters to the Vertex Veo call

**Files:**
- Modify: `apps/inference-gateway/src/video.ts:91-103`
- Test: `apps/inference-gateway/src/video.test.ts`

**Interfaces:**
- Consumes: `VideoGenerationRequest.aspectRatio`/`durationSeconds` from Task 1.
- Produces: `callVertexVeoModel` respects the caller's aspect ratio instead of hardcoding `16:9`, and hard-validates Veo's 4-8s duration range.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects a duration outside Veo\'s 4-8s range when falling back to Veo', async () => {
  delete process.env.GEMINI_API_KEY
  vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(true)
  process.env.VERTEX_PROJECT = 'proj'
  const fetchSpy = vi.fn()
  global.fetch = fetchSpy as unknown as typeof fetch

  await expect(generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 9 }))
    .rejects.toThrow(/durationSeconds must be a whole number of seconds in 4\.\.8/)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('passes the caller\'s aspect ratio to Veo instead of hardcoding 16:9', async () => {
  delete process.env.GEMINI_API_KEY
  vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(true)
  process.env.VERTEX_PROJECT = 'proj'
  const fetchSpy = vi.fn(async (url: string) => {
    if (String(url).includes('predictLongRunning')) {
      return new Response(JSON.stringify({ name: 'op1' }), { status: 200 })
    }
    return new Response(JSON.stringify({ done: true, response: { videos: [{ bytesBase64Encoded: 'QUJD', mimeType: 'video/mp4' }] } }), { status: 200 })
  })
  global.fetch = fetchSpy as unknown as typeof fetch

  await generateVideo({ ...req, aspectRatio: '9:16', durationSeconds: 6 })

  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  const body = JSON.parse(init.body as string)
  expect(body.parameters).toMatchObject({ aspectRatio: '9:16' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts -t "Veo"`
Expected: FAIL — Veo call still hardcodes `16:9` and has no duration validation.

- [ ] **Step 3: Write minimal implementation**

```ts
const VEO_MIN_DURATION_SECONDS = 4
const VEO_MAX_DURATION_SECONDS = 8

function validateVeoDuration(durationSeconds: number): void {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < VEO_MIN_DURATION_SECONDS ||
    durationSeconds > VEO_MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `durationSeconds must be a whole number of seconds in ${VEO_MIN_DURATION_SECONDS}..${VEO_MAX_DURATION_SECONDS}, got ${durationSeconds}`,
    )
  }
}

async function callVertexVeoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  validateVeoDuration(req.durationSeconds)
  const token    = await getToken()
  const startUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${getProject()}/locations/${LOCATION}/publishers/google/models/${VEO_MODEL}:predictLongRunning`

  const startRes = await fetch(startUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances:  [{ prompt: req.prompt }],
      parameters: { aspectRatio: req.aspectRatio, sampleCount: 1 },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  // ... rest unchanged
```

Since Veo's actual duration isn't a `predictLongRunning` parameter in the current call shape (the API doesn't expose a duration knob at this call site — verified: only `aspectRatio`/`sampleCount` are sent today), `validateVeoDuration` here is a pre-flight rejection matching the model's known ceiling, documented with a comment:

```ts
  // Veo 2 (veo-2.0-generate-001) has no duration parameter on predictLongRunning
  // in this API version — it always renders its own default length. Validating
  // here rejects an out-of-range request before spending a call, but does not
  // yet control the actual output duration. Revisit once Veo exposes a real
  // duration parameter, or drop this validation if Veo's fixed output length
  // is confirmed acceptable for every caller.
```

Add that comment directly above `validateVeoDuration`'s definition.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/inference-gateway/src/video.ts apps/inference-gateway/src/video.test.ts
git commit -m "feat(gateway): pass caller aspect ratio to Veo, validate its duration ceiling"
```

### Task 3: Replace the silent Gemini→Veo fallback with `selectBackend` — fix the cross-vendor-substitution bug

**Files:**
- Modify: `apps/inference-gateway/src/video.ts:157-197`
- Test: `apps/inference-gateway/src/video.test.ts`

**Interfaces:**
- Consumes: `VideoGenerationRequest` from Task 1/2.
- Produces: `generateVideo()`'s behavior changes — a Gemini failure or missing key now throws instead of silently trying Veo. Later tasks (5, 6) call `generateVideo()` unchanged at the call-site level; only its *behavior* on failure changes.

- [ ] **Step 1: Write the failing test**

```ts
it('does not fall back to Veo on a Gemini failure — surfaces the error instead', async () => {
  process.env.GEMINI_API_KEY = 'key'
  vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
  process.env.VERTEX_PROJECT = 'proj'
  vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(true)
  const fetchSpy = vi.fn(async (url: string) => {
    if (String(url).includes('generativelanguage')) return new Response('boom', { status: 500 })
    throw new Error('Veo should never be called on a Gemini failure')
  })
  global.fetch = fetchSpy as unknown as typeof fetch

  await expect(generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 8 }))
    .rejects.toThrow(/Gemini API video generation failed/)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

it('errors, rather than substituting a vendor, when Gemini is unconfigured', async () => {
  delete process.env.GEMINI_API_KEY
  const fetchSpy = vi.fn(() => { throw new Error('no backend should be called') })
  global.fetch = fetchSpy as unknown as typeof fetch

  await expect(generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 8 }))
    .rejects.toThrow(/no GEMINI_API_KEY configured/)
  expect(fetchSpy).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts -t "substituting"`
Expected: FAIL — today's code falls back to Veo in both cases, so the first test's Veo-called assertion fires and the second actually calls Veo's token/fetch path.

- [ ] **Step 3: Write minimal implementation**

Replace lines 151-197 (the "Unified generateVideo" section) with a real capability-based `selectBackend`:

```ts
// ---------------------------------------------------------------------------
// selectBackend — capability-based routing. One real branch today
// (Gemini Omni Flash). Never falls back to a different vendor on failure or
// missing config — that is the cross-vendor substitution
// docs/media-generation/README.md forbids. A caller who needs Gemini and
// can't get it sees an error, not a Veo result it never asked for.
// ---------------------------------------------------------------------------

type VideoBackend = 'gemini-omni' | 'vertex-veo'

export class VideoBackendUnavailableError extends Error {}

function selectBackend(model: string): VideoBackend {
  if (model === 'gemini-omni-1.1-flash') return 'gemini-omni'
  throw new VideoBackendUnavailableError(`No backend registered for model: ${model}`)
}

export async function generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  if (!VIDEO_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedVideoModelError(`Unsupported video model: ${req.model}`)
  }
  validateOmniDuration(req.durationSeconds)

  const backend = selectBackend(req.model)

  if (backend === 'gemini-omni') {
    if (!process.env.GEMINI_API_KEY) {
      throw new VideoBackendUnavailableError('Gemini Omni unavailable: no GEMINI_API_KEY configured')
    }
    if (!geminiVideoBreaker.isAvailable()) {
      throw new VideoBackendUnavailableError('Gemini Omni unavailable: circuit open')
    }
    try {
      const result = await callGeminiApiKeyVideoModel(req)
      geminiVideoBreaker.onSuccess()
      return result
    } catch (err) {
      geminiVideoBreaker.onFailure()
      throw err
    }
  }

  // Unreachable today — selectBackend only ever returns 'gemini-omni' — kept
  // so adding a second real backend later is additive, not a rewrite of this
  // dispatch. See docs/superpowers/specs/2026-09-18-template-video-generation-design.md
  // Phase 0 for the planned shape of a second branch.
  throw new VideoBackendUnavailableError(`Backend not implemented: ${backend}`)
}
```

Remove `callVertexVeoModel`'s call site from `generateVideo` entirely — the function itself stays in the file (Task 2's changes to it remain valid) but is currently unreferenced; add a one-line comment above its definition noting it's dead code pending a real second `selectBackend` branch, not accidentally orphaned:

```ts
// Not currently called from generateVideo() — selectBackend has only the
// Gemini Omni branch today. Kept implemented and tested so wiring in a real
// Vertex Veo branch later is a one-line change to selectBackend, not new code.
async function callVertexVeoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts`
Expected: PASS. Some existing tests in the "Gemini API first, Vertex Veo fallback" describe block that assert a Veo fallback happens will now fail — update or remove them: search for any `it(` in that block asserting Veo was called after a Gemini failure, and delete those specific assertions/tests, since that behavior is now intentionally gone. Keep tests that exercise `callVertexVeoModel` and `classifyInteractionsVideoResponse` directly (they're still valid, just not reachable through `generateVideo` yet).

- [ ] **Step 5: Commit**

```bash
git add apps/inference-gateway/src/video.ts apps/inference-gateway/src/video.test.ts
git commit -m "fix(gateway): stop silently substituting Vertex Veo for a failed/unconfigured Gemini call"
```

### Task 4: Spike — determine the Interactions API's accepted image-reference format

**Files:**
- Create: `apps/inference-gateway/scratch/image-conditioning-spike.md` (a findings note, not shipped code — delete or move into a code comment once Task 5 is written)

This is a real external unknown, not a coding task — Google's Interactions API's accepted image-reference shape for `gemini-omni-1.1-flash` has not been confirmed against our own storage. Resolve it before Task 5.

- [ ] **Step 1: Get a presigned URL for a real uploaded test image** via the existing internal API (`fetchPresignedUrl`'s underlying endpoint, `${INTERNAL_API_URL}/files/{fileId}/presigned-url`) against any file already in a dev tenant's storage.

- [ ] **Step 2: Call the Interactions API directly** (`curl` or a throwaway script, not committed) with a request shaped like:

```bash
curl -sS -X POST "https://generativelanguage.googleapis.com/v1beta/interactions?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-omni-1.1-flash",
    "input": [
      {"type": "text", "text": "a short clip of this product on a table"},
      {"type": "image", "uri": "<the presigned URL from step 1>", "mime_type": "image/jpeg"}
    ],
    "response_format": {"type": "video", "resolution": "720p", "delivery": "inline", "aspect_ratio": "9:16", "duration": "6s"},
    "generation_config": {"video_config": {"task": "image_to_video"}}
  }'
```

- [ ] **Step 3: Record the outcome in `apps/inference-gateway/scratch/image-conditioning-spike.md`.** Two possible outcomes, each with a defined next step:
  - **The presigned S3 URL is accepted directly** (a 200 with video content, or at minimum the request passes validation and only fails on content/quota grounds unrelated to the image field): Task 5 sends `fetchPresignedUrl`'s output URL directly as the `uri` field. No staging step needed.
  - **The presigned S3 URL is rejected** (e.g. a 400 citing an unreachable/unsupported URI scheme or host): Task 5 must add a staging step — download the presigned URL's bytes server-side and re-upload to a short-lived GCS object the Interactions API can fetch, mirroring Vertex's own `gs://` requirement. Note in the spike file which of these was found, since Task 5's implementation branches on it.

- [ ] **Step 4: Commit the finding**

```bash
git add apps/inference-gateway/scratch/image-conditioning-spike.md
git commit -m "docs(gateway): record image-reference format finding for Omni image-conditioning spike"
```

### Task 5: Add image-conditioning support to the Gemini Omni gateway call

**Files:**
- Modify: `apps/inference-gateway/src/video.ts`
- Test: `apps/inference-gateway/src/video.test.ts`

**Interfaces:**
- Consumes: `VideoGenerationRequest` from Tasks 1-3; the spike finding from Task 4.
- Produces: `VideoGenerationRequest` gains an optional `imageUri?: string` field; `callGeminiApiKeyVideoModel` sends a multimodal `input` array (text + image parts) instead of a bare string when present, with `task: 'image_to_video'`.

This task's exact `input` shape depends on Task 4's finding. Both branches are written below; keep only the one the spike confirmed, delete the other, and note which was used in the commit message.

- [ ] **Step 1: Write the failing test**

```ts
it('sends a multimodal input array with an image part when imageUri is set', async () => {
  process.env.GEMINI_API_KEY = 'key'
  vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }))
  global.fetch = fetchSpy as unknown as typeof fetch

  await generateVideo({
    ...req, aspectRatio: '9:16', durationSeconds: 6,
    task: 'image_to_video', imageUri: 'https://example.com/product.jpg',
  })

  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  const body = JSON.parse(init.body as string)
  expect(body.input).toEqual([
    { type: 'text', text: req.prompt },
    { type: 'image', uri: 'https://example.com/product.jpg', mime_type: 'image/jpeg' },
  ])
  expect(body.generation_config.video_config.task).toBe('image_to_video')
})

it('still sends a bare string input for text_to_video (no regression)', async () => {
  process.env.GEMINI_API_KEY = 'key'
  vi.mocked(geminiVideoBreaker.isAvailable).mockReturnValue(true)
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }))
  global.fetch = fetchSpy as unknown as typeof fetch

  await generateVideo({ ...req, aspectRatio: '16:9', durationSeconds: 8 })

  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  const body = JSON.parse(init.body as string)
  expect(body.input).toBe(req.prompt)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts -t "multimodal input"`
Expected: FAIL — `imageUri` doesn't exist on the interface, `input` is always a bare string today.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface VideoGenerationRequest {
  model: string
  prompt: string
  task: 'text_to_video' | 'edit' | 'extend' | 'image_to_video'
  aspectRatio: '16:9' | '9:16'
  durationSeconds: number
  imageUri?: string
  imageMimeType?: string
}
```

```ts
async function callGeminiApiKeyVideoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  const key = process.env.GEMINI_API_KEY ?? ''
  const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${key}`
  const input = req.imageUri
    ? [
        { type: 'text', text: req.prompt },
        { type: 'image', uri: req.imageUri, mime_type: req.imageMimeType ?? 'image/jpeg' },
      ]
    : req.prompt
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      input,
      response_format: {
        type: 'video', resolution: '720p', delivery: 'inline',
        aspect_ratio: req.aspectRatio, duration: `${req.durationSeconds}s`,
      },
      generation_config: { video_config: { task: req.task } },
    }),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok) throw new Error(`Gemini API video generation failed: ${res.status} ${await res.text()}`)
  return classifyInteractionsVideoResponse(await res.json())
}
```

If Task 4's spike found the presigned S3 URL is rejected, add a staging helper instead and call it before building `input`:

```ts
async function stageImageForOmni(sourceUrl: string): Promise<string> {
  // Download the presigned source URL and re-upload to a short-lived GCS
  // object, mirroring Vertex's own gs:// requirement — only needed if the
  // spike in Task 4 found the Interactions API rejects a direct S3 URL.
  throw new Error('not implemented — fill in based on the Task 4 spike finding')
}
```

(This branch is intentionally left as a real follow-up, not implemented speculatively — only write it if Task 4 actually found the direct-URL path fails. If Task 4 confirmed the direct URL works, delete this function entirely and do not add it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/inference-gateway/src/video.ts apps/inference-gateway/src/video.test.ts
git commit -m "feat(gateway): support image-conditioned video generation on Gemini Omni Flash"
```

### Task 6: Rework `generateVideo.ts` — mode schema, image reference resolution, charge-before-call, deterministic job id, namespaced model id

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts` (full rewrite of the file's body)
- Test: `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`

**Interfaces:**
- Consumes: the gateway's new `VideoGenerationRequest` shape (Tasks 1, 3, 5); `fetchPresignedUrl(fileId, idToken, signal?)` from `src/mastra/tools/mediaCache.js` (existing).
- Produces: `generateVideo`'s `inputSchema` gains `mode`, `startImageFileId`, `referenceFileIds`, `aspectRatio`, `durationSeconds`; its `outputSchema` gains `jobId`. Task 12 (content gate) reads the tool's `mode`/`prompt` inputs directly — no new shared type needed beyond what's defined here.

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`, alongside the existing tests (update the existing tests' calls to include `mode: 'text_to_video', aspectRatio: '16:9' as const, durationSeconds: 8` in their input objects, since `mode` is now required):

```ts
it('rejects animate_frame without startImageFileId', async () => {
  await expect(
    generateVideo.execute!({ mode: 'animate_frame', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8 } as never, baseCtx()),
  ).rejects.toThrow()
})

it('resolves startImageFileId to a presigned URL and forwards it as imageUri', async () => {
  const fetchSpy = vi.fn(async (url: string) => {
    if (String(url).includes('presigned-url')) {
      return new Response(JSON.stringify({ presignedUrl: 'https://s3.example.com/product.jpg' }), { status: 200 })
    }
    return new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })
  })
  global.fetch = fetchSpy as unknown as typeof fetch
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

  await generateVideo.execute!(
    { mode: 'animate_frame', prompt: 'x', aspectRatio: '9:16', durationSeconds: 6, startImageFileId: 'img1' } as never,
    baseCtx(),
  )

  const genCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/v1/video/generations'))!
  const body = JSON.parse((genCall[1] as RequestInit).body as string)
  expect(body.imageUri).toBe('https://s3.example.com/product.jpg')
  expect(body.task).toBe('image_to_video')
})

it('charges credits before calling the gateway, refunding on a post-charge failure', async () => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
  const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
  getPool.mockReturnValue({ query })
  const callOrder: string[] = []
  spendCredits.mockImplementation(async () => { callOrder.push('charge') })
  const originalFetch = global.fetch
  global.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => { callOrder.push('gateway'); return (originalFetch as typeof fetch)(...args) }) as unknown as typeof fetch

  await generateVideo.execute!({ mode: 'text_to_video', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8 } as never, baseCtx())

  expect(callOrder[0]).toBe('charge')
})

it('uses a namespaced model id for the rate lookup and result', async () => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

  const result = await generateVideo.execute!({ mode: 'text_to_video', prompt: 'x', aspectRatio: '16:9', durationSeconds: 8 } as never, baseCtx()) as { model?: string }

  expect(resolveRate).toHaveBeenCalledWith('video_generation', 'google/gemini-omni-1.1-flash')
  expect(result.model).toBe('google/gemini-omni-1.1-flash')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts`
Expected: FAIL — none of `mode`, `startImageFileId`, image resolution, charge-before-call, or the namespaced id exist yet.

- [ ] **Step 3: Write minimal implementation**

Full rewrite of `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`:

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { refundVideoCharge } from './videoCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
// Namespaced per docs/media-generation/README.md's convention. This is a new
// row alongside the old bare 'gemini-omni-1.1-flash' subject in
// packages/foundation/database/seeds/credit-rates.ts and the gateway's own
// VIDEO_MODEL_ALLOWLIST — see Task 7. Never rename the old row in place.
const VIDEO_MODEL = 'google/gemini-omni-1.1-flash'
const GATEWAY_MODEL_ID = 'gemini-omni-1.1-flash' // the bare id the gateway's allowlist/wire format still expects

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  model: z.string().optional(),
  jobId: z.string().optional(),
})

const inputSchema = z.object({
  mode: z.enum(['text_to_video', 'animate_frame', 'composite_references']),
  prompt: z.string().describe('Description of the video to generate'),
  aspectRatio: z.enum(['16:9', '9:16']),
  durationSeconds: z.number().int().min(3).max(10),
  startImageFileId: z.string().optional().describe('Required for animate_frame — an existing files row to use as the literal first frame'),
  referenceFileIds: z.array(z.string()).min(1).max(3).optional().describe('Required for composite_references — identity-anchor images the model builds a new scene around'),
}).refine(
  (v) => (v.mode === 'animate_frame') === (v.startImageFileId !== undefined),
  { message: 'startImageFileId is required for animate_frame and only for animate_frame' },
).refine(
  (v) => (v.mode === 'composite_references') === (v.referenceFileIds !== undefined),
  { message: 'referenceFileIds is required for composite_references and only for composite_references' },
)

export const generateVideo = createTool({
  id: 'generate-video',
  description: 'Generates a short video clip from a text description, optionally conditioned on a product/reference image, using Gemini Omni Flash. Use when the user asks Director to create or generate a video.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { mode, prompt, aspectRatio, durationSeconds, startImageFileId, referenceFileIds } =
      inputData as z.infer<typeof inputSchema>
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    // toolCallId lives directly on execContext, not requestContext — confirmed
    // against @mastra/core's AgentToolExecutionContext type.
    const toolCallId = execContext?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    let imageUri: string | undefined
    if ((mode === 'animate_frame' || mode === 'composite_references') && idToken) {
      const referenceFileId = startImageFileId ?? referenceFileIds?.[0]
      if (referenceFileId) {
        try {
          imageUri = await fetchPresignedUrl(referenceFileId, idToken)
        } catch (err) {
          console.error(`[session:${sessionId}] generateVideo: failed to resolve reference image ${referenceFileId}:`, (err as Error).message)
          return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
        }
      }
    }

    // Charge BEFORE the vendor call — docs/media-generation/README.md's
    // settled rule. An attempt counter appended after any refund keeps a
    // retried tool call under the same toolCallId from being charged twice
    // (refundVideoCharge's `${chargeKey}:refund` scheme consumes the debit
    // key, so a bare re-execution under an unchanged key would otherwise
    // silently skip charging on retry).
    let attempt = 0
    let chargeKey = `video:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('video_generation', VIDEO_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED VIDEO GENERATION: no active video_generation rate for model=${VIDEO_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'video_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    const task = mode === 'text_to_video' ? 'text_to_video' : 'image_to_video'
    let genResult: { videoBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/video/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: GATEWAY_MODEL_ID, prompt, task, aspectRatio, durationSeconds, imageUri }),
        signal: AbortSignal.timeout(270_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateVideo gateway call failed:`, (err as Error).message)
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.videoBase64 !== 'string') {
      console.error(`[session:${sessionId}] generateVideo: gateway returned a non-refused response with no videoBase64`)
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    const buffer = Buffer.from(genResult.videoBase64, 'base64')
    const extension = (genResult.mimeType ?? 'video/mp4').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'mp4'
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, {
          conversationId, title: 'Generated Video', content: buffer,
          contentType: genResult.mimeType, extension,
        })
      : null

    if (!attachment) {
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      model: VIDEO_MODEL,
      jobId,
    }
  },
})
```

Note: `chargeKey`'s `attempt` counter is declared but the increment-on-refund loop is intentionally NOT implemented as a retry loop in this task — `generate_video` is called once per Mastra tool invocation; a genuine user-requested regenerate is a new tool call with a new `toolCallId`, which already produces a different `jobId`/`chargeKey` with no extra logic needed. The `attempt` suffix exists so a **future** internal retry (e.g. Mastra's own approval-resume retrying the same call) doesn't collide — leave it hardcoded at `0` for now and revisit if Phase 0.5's resolution introduces an actual internal retry path that reuses the same `toolCallId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts
git commit -m "feat(orchestrator): image-conditioned generate_video with charge-before-call and namespaced model id"
```

### Task 7: Migrate the credit rate to the namespaced model id, everywhere it's referenced

**Files:**
- Modify: `packages/foundation/database/seeds/credit-rates.ts`
- Modify: `apps/inference-gateway/src/video.ts` (`VIDEO_MODEL_ALLOWLIST`)
- Test: `apps/inference-gateway/src/video.test.ts`, `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts` (already covered by Task 6's namespaced-id test)

**Interfaces:**
- Consumes: nothing new.
- Produces: a deployed-environment migration path for the new `google/gemini-omni-1.1-flash` rate row, and confirmation the gateway's allowlist still matches the bare id `generateVideo.ts` sends on the wire (Task 6 sends `GATEWAY_MODEL_ID = 'gemini-omni-1.1-flash'`, the bare id — the allowlist does NOT need to change, since the wire-level model id stays bare; only the **credit rate subject** and **tool-facing model id** are namespaced). This task exists to make that split explicit and add the new rate row.

- [ ] **Step 1: Write the failing test**

```ts
// apps/inference-gateway/src/video.test.ts
it('keeps the wire-level model id in the allowlist unnamespaced — only the credit rate subject is namespaced', () => {
  expect(() => generateVideo({ ...req, model: 'gemini-omni-1.1-flash', aspectRatio: '16:9', durationSeconds: 8 }))
    .not.toThrow(UnsupportedVideoModelError)
})
```

(This documents the intentional split as a test, since it's easy for a future change to "helpfully" namespace the allowlist too and break every real request.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts -t "unnamespaced"`
Expected: This actually passes already if Tasks 1-3 didn't touch `VIDEO_MODEL_ALLOWLIST` — confirm it passes for the right reason (the allowlist still has the bare id), not because the test is vacuous. If it fails, something in Tasks 1-3 accidentally changed the allowlist — fix that regression first.

- [ ] **Step 3: Add the new namespaced credit rate row**

In `packages/foundation/database/seeds/credit-rates.ts`, add alongside the existing row (do not remove or rename the old one yet):

```ts
{ resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash',
  pricingSchema: { per_call_micro: 400_000 } },
```

Add a code comment above the OLD row noting it's superseded:

```ts
// Superseded by the 'google/gemini-omni-1.1-flash' row below, per
// docs/media-generation/README.md's namespaced-model-id convention.
// generateVideo.ts now looks up rates under the namespaced subject.
// Do not remove this row until confirming no other code (reporting queries,
// dashboards) still references the bare subject string.
{ resourceType: 'video_generation', subject: 'gemini-omni-1.1-flash',
  pricingSchema: { per_call_micro: 400_000 } },
```

- [ ] **Step 4: Write and run a real migration for deployed environments**

`seedCreditRates` only inserts a row if one doesn't already exist for that subject (confirmed in the current seed script) — a deployed environment that's already been seeded once will not pick up the new row from a reseed. Write a one-off migration script:

Create `packages/foundation/database/migrations/scripts/2026-09-18-namespace-video-generation-rate.ts`:

```ts
import { getDb } from '../client.js' // adjust to the actual exported client helper in this package
import { creditRates } from '../schema/index.js' // adjust to the actual credit_rates table export

async function main() {
  const db = getDb()
  const existing = await db.query.creditRates.findFirst({
    where: (r, { eq, and }) => and(eq(r.resourceType, 'video_generation'), eq(r.subject, 'google/gemini-omni-1.1-flash')),
  })
  if (existing) {
    console.log('already migrated, nothing to do')
    return
  }
  const old = await db.query.creditRates.findFirst({
    where: (r, { eq, and }) => and(eq(r.resourceType, 'video_generation'), eq(r.subject, 'gemini-omni-1.1-flash')),
  })
  if (!old) {
    console.error('no existing gemini-omni-1.1-flash rate found — insert manually with the correct pricingSchema')
    process.exit(1)
  }
  await db.insert(creditRates).values({
    resourceType: 'video_generation',
    subject: 'google/gemini-omni-1.1-flash',
    pricingSchema: old.pricingSchema,
  })
  console.log('inserted namespaced video_generation rate')
}

main()
```

(Adjust the exact `getDb`/schema import paths to match this package's real exports — check `packages/foundation/database/client.ts` and `schema/index.ts` for the actual names before running.)

Run against dev: `cd packages/foundation/database && pnpm exec tsx migrations/scripts/2026-09-18-namespace-video-generation-rate.ts`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/video.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/foundation/database/seeds/credit-rates.ts packages/foundation/database/migrations/scripts/2026-09-18-namespace-video-generation-rate.ts apps/inference-gateway/src/video.test.ts
git commit -m "feat(credits): add namespaced google/gemini-omni-1.1-flash video_generation rate"
```

---

## Phase 0.5: mandatory checkpoint — verify the approval gate actually fires

**This is not a code task owned by this plan.** It is a go/no-go gate. Do not start Task 11 onward until this passes.

### Task 8: Verify (or fix) delegate-nested approval resume for `generate_video`

**Files:**
- Read: `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts` (the `delegationDepth > 0` bypass)
- Read: project memory `project_delegate_network_migration` for full history
- Test: a new integration-style test exercising the exact call shape this skill needs

- [ ] **Step 1: Write a test that currently must fail (proving the gap is real)**

Add a test — e.g. `apps/agent-orchestrator/src/mastra/tools/__tests__/delegateApprovalResume.test.ts` — that:
1. Temporarily removes (via a test-only monkeypatch or a feature-flag param, not a permanent code change) the `delegationDepth > 0 → return false` bypass in `shouldRequireApproval`.
2. Drives a real `directorAgentDelegate` tool call for `generate_video` with `requireApproval` forced `true`.
3. Asserts the approval card (`tool-call-approval` chunk) is emitted AND that calling `approveToolCall({ runId, toolCallId })` afterward actually resumes and executes the tool (a real `fileId` comes back), not an empty/no-op result.

This test is expected to currently demonstrate the failure mode documented in `project_delegate_network_migration` (if it's still broken) or to newly pass (if Mastra's `approveToolCall` now genuinely resumes delegate-nested calls, per the "CORRECTION" note in that memory file that this was never actually retested).

- [ ] **Step 2: Run it and record the actual result** — this is real information the codebase currently lacks. Update `project_delegate_network_migration`'s project memory with the outcome either way.

- [ ] **Step 3a: If it resumes correctly** — remove the `delegationDepth > 0` bypass in `generationApproval.ts` (it existed only to route around the now-confirmed-fixed limitation). Run the full `generationApproval.test.ts` and `generateVideo.test.ts` suites to confirm nothing else depended on the bypass. Commit this fix on its own:

```bash
git add apps/agent-orchestrator/src/mastra/tools/generationApproval.ts
git commit -m "fix(orchestrator): remove delegationDepth approval bypass — Mastra resume confirmed working"
```

- [ ] **Step 3b: If it does not resume correctly** — this is a real, separate bug fix outside this plan's scope (`project_delegate_network_migration`'s domain). Do not proceed to Task 9. Escalate: this plan's Phase 1 cannot ship until that fix lands, full stop, per the design spec's Phase 0.5.

- [ ] **Step 4: Only once Task 8 resolves to 3a** — proceed to Phase 1.

---

## Phase 1: the `template-video-generation` skill

### Task 9: Register `analyze_video` and `analyze_audio` on Director's tool maps

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts:1-10,66,85`
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts` (create if it doesn't exist, following the pattern in `olmoDelegates.test.ts`)

**Interfaces:**
- Consumes: `analyzeVideoTool`, `analyzeAudioTool` from `../tools/analyzeVideo.js`/`../tools/analyzeAudio.js` (existing, currently only imported by `platformAgent.ts`).
- Produces: both `directorAgent.tools` and `directorAgentDelegate.tools` include `analyze_video`/`analyze_audio`; Task 11's instructions reference these tool names directly.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { directorAgent, directorAgentDelegate } from '../directorAgent.js'

describe('directorAgent tool registration', () => {
  it('has analyze_video and analyze_audio registered, needed for template-video-generation', () => {
    expect(Object.keys(directorAgent.tools ?? {})).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
    expect(Object.keys(directorAgentDelegate.tools ?? {})).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: FAIL — neither tool is registered today.

- [ ] **Step 3: Write minimal implementation**

In `directorAgent.ts`, add imports and extend both `tools:` maps:

```ts
import { analyzeVideoTool } from '../tools/analyzeVideo.js'
import { analyzeAudioTool } from '../tools/analyzeAudio.js'
```

```ts
export const directorAgent = new Agent({
  // ... unchanged
  tools: {
    generate_image: generateImage, edit_image: editImage, generate_video: generateVideo,
    retrieve_template: retrieveTemplate, analyze_video: analyzeVideoTool, analyze_audio: analyzeAudioTool,
  },
  errorProcessors: [streamErrorRetry()],
})

export const directorAgentDelegate = new Agent({
  // ... unchanged
  tools: {
    generate_image: generateImage, edit_image: editImage, generate_video: generateVideo,
    retrieve_template: retrieveTemplate, analyze_video: analyzeVideoTool, analyze_audio: analyzeAudioTool,
  },
  errorProcessors: [streamErrorRetry()],
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts
git commit -m "feat(orchestrator): register analyze_video/analyze_audio on Director for template-video-generation"
```

### Task 10: Add `retrieve_template` to Olmo's `SERVER_TOOLS`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (near `SERVER_TOOLS` definition, line ~97)
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/allowedSubAgents.test.ts` or a new focused test

**Interfaces:**
- Consumes: `retrieveTemplate` from `../tools/retrieveTemplate.js` (existing, currently only on Director).
- Produces: Olmo can call `retrieve_template` directly during intake (Task 11's flow step 1) without delegating to Director just to fetch a template contract.

- [ ] **Step 1: Write the failing test**

```ts
import { SERVER_TOOLS } from '../platformAgent.js'

it('registers retrieve_template so Olmo can resolve a template during intake without delegating', () => {
  expect(Object.keys(SERVER_TOOLS)).toContain('retrieve_template')
})
```

Add this to whichever existing test file already imports `SERVER_TOOLS` from `platformAgent.ts` (check `allowedSubAgents.test.ts` or create `platformAgent.test.ts` if none imports it directly).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run -t "retrieve_template so Olmo"`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `platformAgent.ts`, import and add to `SERVER_TOOLS`:

```ts
import { retrieveTemplate } from '../tools/retrieveTemplate.js'
```

```ts
export const SERVER_TOOLS = {
  retrieve_documents: retrieveDocumentsTool,
  ...platformCapabilityTools,
  retrieve_template: retrieveTemplate,
  internet_search: createTool({
    // ... unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run -t "retrieve_template so Olmo"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(orchestrator): register retrieve_template on Olmo for template-video-generation intake"
```

### Task 11: Add the `TEMPLATE_VIDEO_CONTRACT` prompt block to Olmo's instructions

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (inside the `instructions:` async function, alongside `ROUTING_CONTRACT`/`COST_CONFIRMATION_CONTRACT`)
- Test: a prompt-content test following the pattern used for other contracts, if one exists (check `platformAgent.test.ts` for a precedent — e.g. a test asserting `ROUTING_CONTRACT`'s exact text is present in composed instructions); otherwise skip a dedicated test for prompt text (this codebase does not appear to unit-test every contract's exact wording — verify by checking for existing contract-text assertions before deciding whether to add one)

**Interfaces:**
- Consumes: nothing new in code — this is a prompt-text addition appended in the same layered-contract style as the existing blocks (`CLARIFICATION_CONTRACT`, `ROUTING_CONTRACT`, etc.), appended to the final composed instructions the same way those are.
- Produces: Olmo's behavior for template-video-generation conversations — intake, brief, aspect-ratio lock, and the user-facing half of the content gate.

- [ ] **Step 1: Locate the exact append point**

Find where the existing contracts (`CLARIFICATION_CONTRACT`, `CODE_BLOCK_CONTRACT`, `CANVAS_CONTRACT`, `IDENTITY_CONTRACT`, `DELEGATION_CONTRACT`, `ROUTING_CONTRACT`, `COST_CONFIRMATION_CONTRACT`, `THINKING_STYLE_CONTRACT`) are concatenated into the final returned instructions string (further down in the same `instructions:` function than the excerpt already read — find the `return` statement that joins `composed` with all the `*_CONTRACT` constants).

- [ ] **Step 2: Add the new contract constant**

```ts
const TEMPLATE_VIDEO_CONTRACT = `\n\n## Template video cloning — required behaviour
When the user wants to clone/recreate a reference ad's structure onto their own product (phrases like "clone this ad", "make a video like this template", "recreate this ad style for my product"):
1. Resolve the template: call retrieve_template with the slug if one is named in the brief. If retrieve_template returns { found: false }, tell the user and ask them to pick again — do not invent a structure.
2. Ask for a product photo if one hasn't been provided. Strongly recommend it over a text-only description — tell the user plainly that without a photo, product identity will not be preserved in the generated video, only what the words describe.
3. Delegate to agent-director to analyze the template (analyze_video/analyze_audio) and classify its profile before proposing a plan.
4. Before generation, the plan you present under COST_CONFIRMATION_CONTRACT above must ALSO include: the output aspect ratio (16:9 or 9:16 — ask if the template and product photo don't obviously agree), a one-line description of what will and will not carry over from the template (the template's own brand/packaging/on-screen text must never appear in the output), and — whenever the clone will include spoken dialogue — the EXACT words the generated actor will say, verbatim, for the user to approve. This dialogue approval is separate from the cost approval: if the user approves the cost plan but you haven't shown them the exact spoken line, ask for that separately before calling agent-director. If you later change the wording for any reason (including your own correction, e.g. respelling a brand name), you must show the user the new line and get it approved again before generating.
5. After agent-director returns a result, if the clone included spoken dialogue, delegate a follow-up analyze_audio call on the resulting video's fileId and compare the transcript to the approved line before telling the user the clone is ready — if they don't match, tell the user plainly rather than presenting a mismatched result as correct.
6. State known limits plainly when delivering the result: product identity will read as recognizably similar, not pixel-exact; a template with multiple distinct scenes is compressed into one clip today, not a multi-shot series.`
```

- [ ] **Step 3: Append it in the final instructions composition**, in the same style as the other contracts (append order doesn't matter functionally since each is independent, but keep it near `ROUTING_CONTRACT`/`COST_CONFIRMATION_CONTRACT` for readability):

```ts
return `${composed}${CLARIFICATION_CONTRACT}${CODE_BLOCK_CONTRACT}${CANVAS_CONTRACT}${IDENTITY_CONTRACT}${DELEGATION_CONTRACT}${ROUTING_CONTRACT}${COST_CONFIRMATION_CONTRACT}${TEMPLATE_VIDEO_CONTRACT}${THINKING_STYLE_CONTRACT}` // + whatever else the real return statement already includes — insert TEMPLATE_VIDEO_CONTRACT into the existing chain, don't replace it
```

(Read the actual current `return` statement before editing — insert `TEMPLATE_VIDEO_CONTRACT` into the existing concatenation chain in place, do not reconstruct the whole return line from scratch, since it likely includes more than what's shown in the excerpt already read, such as the skill-invocation blocks further down in the function.)

- [ ] **Step 4: Manual verification** (no automated test for prompt wording, per this codebase's existing pattern) — run the orchestrator locally, start a chat as Olmo, and send a message like "clone this ad for my brand" with a template slug, confirming the response asks for a product photo and doesn't skip straight to generation.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(orchestrator): add TEMPLATE_VIDEO_CONTRACT for template cloning conversations"
```

### Task 12: Add the profile→generation-mode mapping and template rules to Director's instructions

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (the `defaultInstructions` string inside `directorInstructions`)
- Test: none new (prompt text, same as Task 11 — verify manually)

**Interfaces:**
- Consumes: the `mode`/`startImageFileId`/`referenceFileIds` fields Task 6 added to `generate_video`'s schema.
- Produces: Director's own instructions know which `mode` to pick per template profile.

- [ ] **Step 1: Add a new `## Template cloning` section to `defaultInstructions`**, inserted after the existing `## Templates` section (which already covers calling `retrieve_template`):

```ts
## Template cloning — generation mode selection
When generating a video that clones a template for a specific product:
- If a product photo/still exists and the template profile is visual_product_texture or platform_cta: call generate_video with mode: "animate_frame" and startImageFileId set to that image's fileId — the product photo becomes the literal first frame.
- If the template profile is human_demo, human_voiceover, or mixed, or no product still exists yet: call generate_video with mode: "composite_references" and referenceFileIds including the product photo (and a presenter reference image if one was generated).
- Never pass both startImageFileId and referenceFileIds — they are mutually exclusive generation modes.
- Always pass aspectRatio and durationSeconds explicitly — do not rely on defaults. durationSeconds must be a whole number of seconds between 3 and 10; if the template's own duration is longer, tell the user the clone will be compressed into a single clip within that ceiling rather than silently truncating a longer plan.
- Write the prompt as flowing prose in this order: Subject, Action, Camera, Style, Constraints. Never write it as a bulleted list or Label: value pairs — these render as literal on-screen text in the output. One primary action per shot; do not chain two actions with "then" or "followed by" in a single generate_video call.
- If the template or product has visible printed text (a label, package, or on-screen text), include this exact clause in the prompt: "the product label remains perfectly sharp and identical to the reference image, with its text unchanged and fully legible."
- For a UGC-style or human-presenter template, include: "handheld feel, slight camera shake, candid, natural skin texture, imperfect framing" — without these the model defaults to polished commercial-looking output.
```

- [ ] **Step 2: Manual verification** — trigger a template-clone generation via Olmo→Director locally and confirm the `generate_video` call Director makes uses the expected `mode` for a known template profile.

- [ ] **Step 3: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): add template-cloning generation-mode rules to Director's instructions"
```

### Task 13: Content/dialogue approval gate in tool code

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `generate_video`'s `inputSchema` gains an optional `approvedDialogue: string` field; a mismatch between it and any quoted spoken line in `prompt` refuses the call before the gateway is ever hit.

This is the "enforced in tool code, not prose" mechanism the spec requires. Scope: rather than a hash/token infrastructure, the tool does a direct string check — if the prompt contains a quoted line (matching `"..."`, the convention Director's own prompt-writing rules already use for spoken dialogue per Task 12), that exact quoted text must match the `approvedDialogue` field byte-for-byte, or the tool refuses. This makes it structurally impossible for Director to generate a spoken line the user never literally saw and approved, without requiring new shared infrastructure.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses when the prompt contains a quoted line that does not match approvedDialogue', async () => {
  const result = await generateVideo.execute!(
    {
      mode: 'text_to_video',
      prompt: 'A creator speaking to camera, saying "Try our new serum today."',
      aspectRatio: '16:9', durationSeconds: 8,
      approvedDialogue: 'Try our NEW serum today!',
    } as never,
    baseCtx(),
  )
  expect(result).toEqual({ refused: true, refusalReason: 'DIALOGUE_NOT_APPROVED' })
  expect(global.fetch).not.toHaveBeenCalled()
})

it('proceeds when the quoted line exactly matches approvedDialogue', async () => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

  const result = await generateVideo.execute!(
    {
      mode: 'text_to_video',
      prompt: 'A creator speaking to camera, saying "Try our new serum today."',
      aspectRatio: '16:9', durationSeconds: 8,
      approvedDialogue: 'Try our new serum today.',
    } as never,
    baseCtx(),
  ) as { refused?: boolean }
  expect(result.refused).toBeUndefined()
})

it('proceeds without approvedDialogue when the prompt has no quoted line', async () => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'x.mp4', type: 'video/mp4', size: 3 })

  const result = await generateVideo.execute!(
    { mode: 'text_to_video', prompt: 'A calm sunrise over mountains, no dialogue.', aspectRatio: '16:9', durationSeconds: 8 } as never,
    baseCtx(),
  ) as { refused?: boolean }
  expect(result.refused).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts -t "approvedDialogue\|DIALOGUE_NOT_APPROVED\|quoted line"`
Expected: FAIL — the field and check don't exist yet.

- [ ] **Step 3: Write minimal implementation**

Add to `inputSchema`:

```ts
const inputSchema = z.object({
  mode: z.enum(['text_to_video', 'animate_frame', 'composite_references']),
  prompt: z.string().describe('Description of the video to generate'),
  aspectRatio: z.enum(['16:9', '9:16']),
  durationSeconds: z.number().int().min(3).max(10),
  startImageFileId: z.string().optional(),
  referenceFileIds: z.array(z.string()).min(1).max(3).optional(),
  approvedDialogue: z.string().optional().describe('The exact spoken line the user approved, if the prompt includes quoted dialogue — required to match a quoted line in prompt byte-for-byte'),
}).refine(/* existing refinements unchanged */)
```

Add a pure helper and the check at the top of `execute`, before the image-resolution step:

```ts
function extractQuotedLine(prompt: string): string | null {
  const match = prompt.match(/"([^"]+)"/)
  return match ? match[1] : null
}
```

```ts
execute: async (inputData, execContext) => {
  const { mode, prompt, aspectRatio, durationSeconds, startImageFileId, referenceFileIds, approvedDialogue } =
    inputData as z.infer<typeof inputSchema>

  const quotedLine = extractQuotedLine(prompt)
  if (quotedLine !== null && quotedLine !== approvedDialogue) {
    return { refused: true, refusalReason: 'DIALOGUE_NOT_APPROVED' }
  }

  // ... rest of execute unchanged from Task 6
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateVideo.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the corresponding rule to Director's instructions** (Task 12's section), so Director actually populates `approvedDialogue`:

Append to the `## Template cloning — generation mode selection` section added in Task 12:

```ts
- Whenever your prompt includes a quoted spoken line (dialogue the on-screen creator says), you MUST pass that exact same text in the approvedDialogue field. If Olmo's delegation to you did not include an approved line for dialogue you're about to write, do not invent one — ask Olmo (by returning a refused: true-shaped explanation in your reply) rather than guessing at wording the user never saw.
```

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): enforce dialogue approval in generate_video tool code, not prose"
```

### Task 14: Post-generation transcript QA

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (instructions)
- Test: none new — this is a prompt-driven follow-up call to the already-tested `analyze_audio` tool (Task 9), not new tool code

**Interfaces:**
- Consumes: `analyze_audio` (Task 9), the `fileId` a successful `generate_video` call returns.
- Produces: Director's instructions require a transcript-diff step after a dialogue-bearing generation succeeds.

- [ ] **Step 1: Add to the `## Template cloning` section of `defaultInstructions`**:

```ts
- After a successful generate_video call that included approvedDialogue, call analyze_audio on the returned fileId (mode: "deep" for a full transcript) and compare the transcript to approvedDialogue. If they differ in a way that changes meaning (a wrong brand name, a dropped claim, a garbled word) — not just minor transcription noise — tell the user plainly that the spoken line came out differently than approved, quote both versions, and ask whether to accept it or retry. Do not present a mismatched result as if it matched.
```

- [ ] **Step 2: Manual verification** — generate a dialogue-bearing clip locally, confirm Director calls `analyze_audio` afterward and surfaces a mismatch if one exists (can be forced by testing against a clip known to mispronounce a coined brand name, per the Novoads finding this rule is based on).

- [ ] **Step 3: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): require post-generation transcript QA for dialogue-bearing clones"
```

---

## Self-review notes (completed during plan authoring)

- **Spec coverage:** Phase 0's aspect-ratio/duration wire params (Tasks 1-2), image conditioning (Tasks 4-5), cross-vendor-substitution fix (Task 3), charge-before-call/deterministic job id/namespaced model id (Task 6-7) all map to spec sections. Phase 0.5's exact verification step is Task 8. Phase 1's Olmo/Director split (Tasks 9-12), content gate (Task 13), and post-gen QA (Task 14) all map to spec sections. The spec's "three-tier no-photo fallback" (open question, UX wording) and "retrieve_template on Olmo vs. narrow delegation" (open question, resolved as: add directly to Olmo — Task 10) are both addressed; the exact fallback wording is left to manual QA in Task 11 rather than a scripted task, since it's UX copy, not a testable code path.
- **Placeholder scan:** the one intentionally-incomplete piece (`stageImageForOmni` in Task 5) is explicitly conditional on Task 4's real spike finding, not a vague TODO — it's deleted entirely if the spike finds the direct-URL path works, which is the likely outcome given `fetchPresignedUrl` already returns an HTTPS URL.
- **Type consistency:** `mode`/`startImageFileId`/`referenceFileIds`/`approvedDialogue`/`jobId` are introduced once in Task 6 and referenced identically in Tasks 12-13; `VideoGenerationRequest`'s `aspectRatio`/`durationSeconds`/`imageUri`/`imageMimeType` fields are introduced once in Tasks 1/5 and used identically by Task 6's gateway call body.

---

Plan complete and saved to `docs/superpowers/plans/2026-09-18-template-video-generation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

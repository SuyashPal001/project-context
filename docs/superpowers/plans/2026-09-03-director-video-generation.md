# Director Video Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Director agent with a `generate_video` tool backed by Gemini Omni 1.1 Flash (`gemini-omni-1.1-flash`), inline in chat, charged per call.

**Architecture:** Same shape as the shipped image pipeline and the Producer/song plan, with one real difference: Omni Flash speaks the Interactions API, a wire shape not present anywhere else in this codebase (every existing adapter speaks `:generateContent` or `:predict`). A new gateway adapter (`video.ts`) isolates that shape behind the same `{ videoBase64, mimeType } | { refused, reason }` contract the tool layer already expects, so `generateVideo.ts`, `directorAgent.ts`, and `chatStream.ts` changes are mechanical repeats of the image/song pattern.

**Tech Stack:** TypeScript, Mastra, Vertex AI Interactions API, Drizzle ORM, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-03-director-video-generation-design.md](../specs/2026-09-03-director-video-generation-design.md) (extends [2026-09-01-director-agent-image-generation-design.md](../specs/2026-09-01-director-agent-image-generation-design.md))

## Global Constraints

- Model id is `gemini-omni-1.1-flash` only — GA as of 2026-08-27. Never use `gemini-omni-flash-preview` (allowlist-gated, deprecating 2026-09-30).
- No new persona/agent roster entries — Director already exists everywhere; this only adds a tool and updates instructions/description text.
- Charge-after-success only. `jobType: 'video_generation'`.
- New sibling credit helper `videoCredits.ts`, not folded into `imageCredits.ts` — same convention as `musicCredits.ts`.
- **The exact Vertex-side REST path for the Interactions API is unverified against a live account as of this plan's writing.** Task 2 includes an explicit verification step before this can be considered done — do not skip it or assume the documented shape is exactly right without testing it.
- `apps/agent-orchestrator` and `apps/inference-gateway` changes require manual `pm2 restart` after deploy.

---

### Task 1: `credit_rates` schema — add `video_generation` resource type

**Files:**
- Modify: `packages/foundation/database/schema/credits.ts:17-19`
- Create: a new Drizzle migration

**Interfaces:**
- Produces: `resourceType` enum value `'video_generation'`, usable by `resolveRate('video_generation', 'gemini-omni-1.1-flash')` in Task 5.

- [ ] **Step 1: Extend the enum**

In `packages/foundation/database/schema/credits.ts` (this may already include `'music_generation'` if the Producer plan ran first — check before editing):

```ts
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation', 'music_generation', 'video_generation'],
  }).notNull(),
```

- [ ] **Step 2: Generate and apply the migration**

```bash
cd packages/foundation/database
pnpm exec drizzle-kit generate
pnpm exec drizzle-kit migrate
```
Expected: new migration adding `'video_generation'` to the constraint, applies without error.

- [ ] **Step 3: Commit**

```bash
git add packages/foundation/database/schema/credits.ts packages/foundation/database/migrations/
git commit -m "feat(credits): add video_generation resource type"
```

---

### Task 2: Verify the Vertex Interactions API shape against a live account

**Files:** none — this is a research/verification task, output feeds Task 3.

- [ ] **Step 1: Confirm project allowlist status**

Check whether the project's GCP project has access to `gemini-omni-1.1-flash` on Vertex (it's GA, but confirm no residual allowlist requirement applies to this specific project). If blocked, this whole plan pauses here — report back rather than guessing.

- [ ] **Step 2: Make one real call and record the exact request/response shape**

Using `gcloud auth print-access-token` and `curl` (or the Python/Node Vertex SDK if faster), attempt:

```bash
curl -X POST \
  "https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/us-central1/publishers/google/interactions" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-omni-1.1-flash",
    "input": "a marble rolling down a chain reaction track",
    "response_format": { "type": "video", "resolution": "720p", "delivery": "base64" },
    "generation_config": { "video_config": { "task": "text_to_video" } }
  }'
```

If this 404s, the path is wrong — the raw REST path for the Interactions API on Vertex specifically was not confirmed in the spec's research (only the SDK-level `client.interactions.create()` call was). Check `google-cloud-aiplatform`'s Node/Python SDK source for the literal HTTP path it constructs, or Google's Interactions API reference under `docs.cloud.google.com/vertex-ai/generative-ai/docs/interactions`, and correct the path before proceeding.

- [ ] **Step 3: Record the exact response field names**

Note the actual field names for: the base64 video payload (likely nested under a `steps`/content-block array, per the spec's research — confirm the exact key names), the mime type field, and what a refusal/safety-block response looks like (may differ from the `predictions`/`candidates` shapes used elsewhere — Interactions API may use a distinct error/refusal envelope).

- [ ] **Step 4: Write down findings as a code comment anchor for Task 3**

Keep the exact request path, request body shape, and response field names from Steps 2-3 at hand — Task 3's `classifyVertexVideoResponse` and `callVertexVideoModel` must match what was actually observed, not the best-guess shape below. If the observed shape differs from Task 3's draft implementation, update Task 3's code accordingly before writing its test.

---

### Task 3: Inference gateway — `video.ts` adapter

**Files:**
- Create: `apps/inference-gateway/src/video.ts`
- Modify: `apps/inference-gateway/src/router.ts` (add `vertexVideoBreaker`)
- Test: `apps/inference-gateway/src/video.test.ts`

**Interfaces:**
- Consumes: `CircuitBreaker` from `./circuit-breaker` (same shape as Task 2 of the Producer plan).
- Produces: `generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult>` and `handleVideoGenerations(req, res, readBody)`, consumed by Task 4 (route) and `generateVideo.ts` tool (Task 6, via HTTP).

**This task's implementation below uses the best-documented request/response shape found during spec research. Before writing the test in Step 1, substitute in whatever Task 2 actually observed if it differs — do not skip that reconciliation.**

- [ ] **Step 1: Add the breaker to `router.ts`**

```ts
export const vertexVideoBreaker = new CircuitBreaker('vertex-video', { failureThreshold: 10, resetTimeoutMs: 60_000 });
```

- [ ] **Step 2: Write the failing test**

Create `apps/inference-gateway/src/video.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  vertexVideoBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
}))

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function GoogleAuth() {
    return {
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({ token: 'fake-token' }),
      }),
    }
  }),
}))

import { classifyVertexVideoResponse, generateVideo } from './video'
import { vertexVideoBreaker } from './router.js'

describe('classifyVertexVideoResponse', () => {
  it('extracts base64 video bytes from a normal interactions response', () => {
    const interactionResponse = {
      steps: [{ content: [{ type: 'video', video: { data: 'QUJD', mime_type: 'video/mp4' } }] }],
    }
    expect(classifyVertexVideoResponse(interactionResponse)).toEqual({
      videoBase64: 'QUJD',
      mimeType: 'video/mp4',
    })
  })

  it('classifies a response with no video content block as a refusal', () => {
    expect(classifyVertexVideoResponse({ steps: [{ content: [] }] })).toEqual({
      refused: true,
      reason: 'NO_VIDEO_CONTENT',
    })
  })

  it('classifies an empty steps array as a refusal', () => {
    expect(classifyVertexVideoResponse({ steps: [] })).toEqual({
      refused: true,
      reason: 'NO_STEPS',
    })
  })
})

describe('generateVideo — allowlist and breaker invariants', () => {
  const req = { model: 'gemini-omni-1.1-flash', prompt: 'a marble rolling down a track', task: 'text_to_video' as const }
  const okBody = { steps: [{ content: [{ type: 'video', video: { data: 'QUJD', mime_type: 'video/mp4' } }] }] }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('vertex success → returns video bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateVideo(req)

    expect(result).toEqual({ videoBase64: 'QUJD', mimeType: 'video/mp4' })
    expect(vertexVideoBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('vertex failure → throws cleanly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'vertex boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/vertex boom/i)
    expect(vertexVideoBreaker.onFailure).toHaveBeenCalledTimes(1)
  })

  it('vertex circuit open → throws cleanly without attempting a call', async () => {
    vi.mocked(vertexVideoBreaker.isAvailable).mockReturnValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects the deprecating preview model id before making any call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateVideo({ ...req, model: 'gemini-omni-flash-preview' }) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Unsupported video model/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/inference-gateway && pnpm exec vitest run video.test.ts`
Expected: FAIL — `Cannot find module './video'`.

- [ ] **Step 4: Implement `video.ts`**

Create `apps/inference-gateway/src/video.ts` — **replace the URL and response-parsing details below with whatever Task 2 actually confirmed if it differs**:

```ts
import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexVideoBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const VIDEO_MODEL_ALLOWLIST = new Set(['gemini-omni-1.1-flash'])

const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

export interface VideoGenerationRequest {
  model: string
  prompt: string
  task: 'text_to_video' | 'edit' | 'extend'
  sourceVideoBase64?: string
  sourceMimeType?: string
}

export type VideoGenerationResult =
  | { videoBase64: string; mimeType: string }
  | { refused: true; reason: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyVertexVideoResponse(interactionResponse: any): VideoGenerationResult {
  const steps: unknown[] = interactionResponse?.steps ?? []
  if (steps.length === 0) return { refused: true, reason: 'NO_STEPS' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoBlock = (steps[0] as any)?.content?.find((c: any) => c.type === 'video')
  if (!videoBlock?.video?.data) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
  return { videoBase64: videoBlock.video.data, mimeType: videoBlock.video.mime_type ?? 'video/mp4' }
}

function buildInteractionRequest(req: VideoGenerationRequest) {
  return {
    model: req.model,
    input: req.prompt,
    response_format: { type: 'video', resolution: '720p', delivery: 'base64' },
    generation_config: { video_config: { task: req.task } },
    // sourceVideoBase64/sourceMimeType wiring for edit/extend depends on
    // Task 2's confirmed request shape for source media — the Interactions
    // API may take this as a multimodal `input` array entry rather than a
    // separate field; verify against the real shape before shipping edit/extend.
  }
}

async function callVertexVideoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/interactions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildInteractionRequest(req)),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Vertex video generation failed: ${res.status} ${await res.text()}`)
  return classifyVertexVideoResponse(await res.json())
}

export class UnsupportedVideoModelError extends Error {}

export async function generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  if (!VIDEO_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedVideoModelError(`Unsupported video model: ${req.model}`)
  }
  if (!vertexVideoBreaker.isAvailable()) {
    throw new Error('Vertex video generation unavailable (circuit open)')
  }
  try {
    const result = await callVertexVideoModel(req)
    vertexVideoBreaker.onSuccess()
    return result
  } catch (err) {
    vertexVideoBreaker.onFailure()
    throw err
  }
}

export async function handleVideoGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: VideoGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await generateVideo(payload)
    latency.observe({ adapter: 'video' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'video', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'video' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'video', status: 'failure' })
    if (err instanceof UnsupportedVideoModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[video] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/inference-gateway && pnpm exec vitest run video.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/inference-gateway/src/video.ts apps/inference-gateway/src/video.test.ts apps/inference-gateway/src/router.ts
git commit -m "feat(inference-gateway): add gemini-omni-1.1-flash video generation adapter"
```

---

### Task 4: Inference gateway — route registration

**Files:**
- Modify: `apps/inference-gateway/src/index.ts`

**Interfaces:**
- Consumes: `handleVideoGenerations` from `./video.js` (Task 3).
- Produces: `POST /v1/video/generations`, consumed by `generateVideo.ts` tool (Task 6).

- [ ] **Step 1: Import and register**

```ts
import { handleVideoGenerations } from './video.js';
```

```ts
  // Video generation (Director agent)
  if (req.method === 'POST' && req.url === '/v1/video/generations') {
    await handleVideoGenerations(req, res, readBody);
    return;
  }
```

- [ ] **Step 2: Verify build**

Run: `cd apps/inference-gateway && pnpm build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/inference-gateway/src/index.ts
git commit -m "feat(inference-gateway): register POST /v1/video/generations route"
```

---

### Task 5: `videoCredits.ts` — refund helper

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoCredits.ts`

**Interfaces:**
- Consumes: same as `musicCredits.ts` (Task 4 of the Producer plan).
- Produces: `refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion): Promise<void>`, consumed by `generateVideo.ts` (Task 6).

- [ ] **Step 1: Create the file**

Direct copy of `imageCredits.ts` with `image_generation` → `video_generation`:

```ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

export async function refundVideoCharge(
  tenantId: string, agentId: string, chargeKey: string,
  rateId: string | null, rateVersion: number | null,
): Promise<void> {
  try {
    const pool = getPool()
    const res = await pool.query<{ amount_micro: string; expires_at: string | null }>(
      `select cl.amount_micro, cg.expires_at
         from credit_ledger cl
         left join credit_grants cg on cg.id = cl.grant_id
        where cl.tenant_id = $1 and cl.idempotency_key = $2 and cl.kind = 'debit'`,
      [tenantId, chargeKey],
    )
    const net = res.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n)
    if (net >= 0n) return
    const expiresAt = shortestExpiresAt(res.rows.map(row => row.expires_at))
    const refundKey = `${chargeKey}:refund`

    try {
      await spendCredits({
        tenantId, amountMicro: -net, key: refundKey, kind: 'refund',
        actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'video_generation',
        grantType: 'refund', expiresAt,
      })
    } catch (err) {
      console.error(
        `[credits] UNREFUNDED VIDEO CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundVideoCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoCredits.ts
git commit -m "feat(agent-orchestrator): add refundVideoCharge helper"
```

---

### Task 6: `generateVideo.ts` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`

**Interfaces:**
- Consumes: `costMicro, isUnlimited, resolveRate, spendCredits` from `@serverless-saas/credits`; `uploadGeneratedFile` from `../../persistence.js`; `resolveSourceImage`-equivalent for video — reuse `downloadMediaAttachment` from `../../media.js` for `sourceFileId` resolution (source video bytes, not source image); `refundVideoCharge` from `./videoCredits.js` (Task 5); gateway `POST /v1/video/generations` (Task 4).
- Produces: `generateVideo` (Mastra tool, `id: 'generate-video'`), consumed by `directorAgent.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts`:

```ts
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

import { generateVideo } from './generateVideo.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 100_000 } })
})

describe('generateVideo tool', () => {
  it('calls the gateway, charges credits only after success, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'clip.mp4', type: 'video/mp4', size: 3 })

    const result = await generateVideo.execute!({ prompt: 'a marble rolling down a track' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -100_000n, kind: 'debit', jobType: 'video_generation' }))
    expect(result).toEqual({ fileId: 'f1', name: 'clip.mp4', fileType: 'video/mp4', size: 3 })
    expect(result).not.toHaveProperty('videoBase64')
  })

  it('does not charge when the gateway refuses', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'NO_VIDEO_CONTENT' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateVideo.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'NO_VIDEO_CONTENT' })
  })

  it('refunds when the post-charge upload fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-100000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateVideo.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 100_000n, kind: 'refund', grantType: 'refund', jobType: 'video_generation',
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED' })
  })

  it('returns insufficientCredits when spendCredits throws after a successful generation', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    spendCredits.mockRejectedValue(Object.assign(new Error('insufficient'), { name: 'InsufficientCreditsError' }))

    const result = await generateVideo.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(uploadGeneratedFile).not.toHaveBeenCalled()
    expect(result).toEqual({ insufficientCredits: true })
  })

  it('returns GENERATION_FAILED without charging when a non-refused gateway response is missing videoBase64', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateVideo.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'GENERATION_FAILED' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateVideo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `generateVideo.ts`**

Text-to-video only for this version (`task: 'text_to_video'` hardcoded) — edit/extend via `sourceFileId` is deferred to a follow-up once Task 2's real source-media request shape is confirmed, per this task's Interfaces note. Create `apps/agent-orchestrator/src/mastra/tools/generateVideo.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { refundVideoCharge } from './videoCredits.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const VIDEO_MODEL = 'gemini-omni-1.1-flash'

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})

export const generateVideo = createTool({
  id: 'generate-video',
  description: 'Generates a short video clip from a text description using Gemini Omni Flash. Use when the user asks Director to create or generate a video.',
  inputSchema: z.object({
    prompt: z.string().describe('Description of the video to generate'),
  }),
  outputSchema,
  execute: async (inputData, execContext) => {
    const { prompt } = inputData as { prompt: string }
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'

    let genResult: { videoBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/video/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: VIDEO_MODEL, prompt, task: 'text_to_video' }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateVideo gateway call failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    if (genResult.refused) {
      return { refused: true, refusalReason: genResult.reason ?? 'unknown' }
    }

    if (typeof genResult.videoBase64 !== 'string') {
      console.error(`[session:${sessionId}] generateVideo: gateway returned a non-refused response with no videoBase64`)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    const chargeKey = `video:${sessionId}:${randomUUID()}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('video_generation', VIDEO_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED VIDEO GENERATION: no active video_generation rate for model=${VIDEO_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        const amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'video_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
          throw err
        }
      }
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
      return { refused: true, refusalReason: 'STORAGE_FAILED' }
    }

    return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
  },
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateVideo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateVideo.ts apps/agent-orchestrator/src/mastra/tools/generateVideo.test.ts
git commit -m "feat(agent-orchestrator): add generate_video tool (text-to-video only)"
```

---

### Task 7: Wire `generate_video` into Director

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`

**Interfaces:**
- Consumes: `generateVideo` from `../tools/generateVideo.js` (Task 6).
- Produces: `directorAgent.tools.generate_video`, invoked by the model at runtime.

- [ ] **Step 1: Add the import and tool registration**

```ts
import { generateVideo } from '../tools/generateVideo.js'
```

```ts
  tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo },
```

- [ ] **Step 2: Extend the instructions block**

Append to the existing `base` instructions string in `directorAgent.ts`:

```
## Video rules
- Call generate_video for a new short video clip from a text description.
- This produces a short clip (seconds, not minutes) — set that expectation if the user implies a longer video.
- Before claiming a clip is ready, check the tool result for a fileId field, same as images.
- If a generation returns refused: true, handle refusalReason the same way as images: "GENERATION_FAILED" is a temporary failure worth retrying, "STORAGE_FAILED" means the video generated but couldn't be saved, any other reason means declined/failed and should be stated plainly.
- If insufficientCredits is returned, tell the user they're out of credits — do not retry.
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(agent-orchestrator): wire generate_video into Director"
```

---

### Task 8: `chatStream.ts` — attachment delivery gate

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:133,209,375`
- Test: `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts`

**Interfaces:** same as Task 7 of the Producer plan, for `generate-video` instead of `generate-song`.

- [ ] **Step 1: Write the failing test**

```ts
describe('attachmentFromCanvasToolResult — generate-video', () => {
  it('returns an attachment payload for a generate-video result with a fileId', () => {
    const result = attachmentFromCanvasToolResult('generate-video', { fileId: 'f1', name: 'clip.mp4', fileType: 'video/mp4', size: 100 })
    expect(result).toEqual({ fileId: 'f1', name: 'clip.mp4', type: 'video/mp4', size: 100 })
  })

  it('returns null for a generate-video result with no fileId (refusal)', () => {
    const result = attachmentFromCanvasToolResult('generate-video', { refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/routes/__tests__/chatStream.test.ts -t "generate-video"`
Expected: FAIL.

- [ ] **Step 3: Update the three allowlist sites**

Line 133:
```ts
  if (!['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video'].includes(normalizedToolName)) return null
```

Line 209 (note: if the Producer plan already ran, `generate-song` is already present — add `generate-video` alongside it):
```ts
  const SAVE_TOOL_NAMES = new Set(['saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks', 'rendercanvas', 'render-canvas', 'render_canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video'])
```

Line 375:
```ts
          if (SAVE_TOOL_NAMES.has(normName) && !['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video'].includes(normName)) {
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/routes/__tests__/chatStream.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts
git commit -m "fix(agent-orchestrator): let generate-video results reach the chat client"
```

---

### Task 9: Manual deployment and verification (operational, not code)

- [ ] **Step 1: Insert the `video_generation` credit rate row** (get the `per_call_micro` value from whoever owns pricing first — possibly resolution-keyed per the spec's §6 note, not a flat rate)

```sql
insert into credit_rates (resource_type, subject, version, pricing_schema, is_active)
values ('video_generation', 'gemini-omni-1.1-flash', 1, '{"per_call_micro": <agreed_value>}'::jsonb, true);
```

- [ ] **Step 2: Restart the VM services**

```bash
pm2 restart agent-orchestrator
pm2 restart inference-gateway
```

- [ ] **Step 3: Check `AttachmentStrip.tsx`'s rendering for `video/*`**

Confirm it shows something sensible (poster-frame thumbnail or download affordance) for a `video/mp4` attachment — per the spec's §7 note, no code change may be required, but verify rather than assume.

- [ ] **Step 4: Manual smoke test**

Chat with Director in dev, ask for a short video clip, confirm it round-trips through S3, appears in chat, and debits the correct credit amount.

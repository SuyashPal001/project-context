# Producer Agent (Song Generation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a "Producer" agent that generates a ~30-second instrumental music clip from a text prompt via Vertex AI's `lyria-002`, inline in chat, charged per call.

**Architecture:** Mirrors the already-shipped Director/image-generation pipeline exactly: a new inference-gateway adapter (`music.ts`, Vertex `:predict`, no Ollama/cross-vendor fallback, own circuit breaker) behind a new `POST /v1/music/generations` route; a new Mastra tool (`generateSong.ts`) that calls the gateway, charges credits after success, uploads the resulting WAV via the already-generalized `uploadGeneratedFile`, and refunds on post-charge failure; a new Mastra agent (`producerAgent.ts`) owning that one tool; registration across all four agent/persona rosters; and a `chatStream.ts` gate update so the resulting attachment actually reaches the client.

**Tech Stack:** TypeScript, Mastra (`@mastra/core/tools`, `@mastra/core/agent`), Vertex AI REST (`:predict`), Drizzle ORM, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-03-producer-agent-song-generation-design.md](../specs/2026-09-03-producer-agent-song-generation-design.md) (also see the Director image-generation spec it mirrors: [2026-09-01-director-agent-image-generation-design.md](../specs/2026-09-01-director-agent-image-generation-design.md))

## Global Constraints

- Model id is `lyria-002` only — GA, no allowlist, `:predict` endpoint, region `us-central1` (not global-endpoint-only). Never use a `lyria-3-*-preview` id (allowlist-gated, different wire shape — out of scope).
- No Ollama fallback and no cross-vendor substitution for music generation (spec's settled rule).
- No Gemini-API-key fallback tier for `lyria-002` — it does not exist on the direct Gemini API surface (only `lyria-3-*-preview` does). `music.ts` is Vertex-only by necessity; a Vertex failure is a clean 503.
- Charge-after-success only, never pre-charge. `jobType: 'music_generation'`.
- Credit helper code lives in its own file (`musicCredits.ts`), not folded into `imageCredits.ts` — this repo's established "two homes deliberately" convention for per-modality credit logic.
- Tool output schemas return metadata only — audio bytes never enter a tool's return value (they'd otherwise replay into every later conversation turn via Mastra's per-tenant memory).
- `apps/agent-orchestrator` and `apps/inference-gateway` changes require a manual `pm2 restart` on the VM after deploy — not covered by `./deploy.sh`. Roster-seed changes (`onboarding.ts`) require `sam deploy`; `backfill-agents.ts`/`personas.ts` seeds are one-time manual scripts.

---

### Task 1: `credit_rates` schema — add `music_generation` resource type

**Files:**
- Modify: `packages/foundation/database/schema/credits.ts:17-19`
- Create: a new Drizzle migration (via `drizzle-kit generate`, not hand-written)

**Interfaces:**
- Produces: `resourceType` enum value `'music_generation'`, usable by `resolveRate('music_generation', 'lyria-002')` (from `@serverless-saas/credits`) in Task 5.

- [ ] **Step 1: Extend the enum**

In `packages/foundation/database/schema/credits.ts`, change:

```ts
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation'],
  }).notNull(),
```

to:

```ts
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation', 'music_generation'],
  }).notNull(),
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
cd packages/foundation/database && pnpm exec drizzle-kit generate
```
Expected: a new migration file under `packages/foundation/database/migrations/` altering the `resource_type` check constraint (or enum type, depending on how Drizzle represents this text-with-enum column) to add `'music_generation'`.

- [ ] **Step 3: Apply the migration against the dev database**

Run:
```bash
pnpm exec drizzle-kit migrate
```
Expected: migration applies without error. Verify with:
```bash
psql "$DATABASE_URL" -c "\d credit_rates" 2>/dev/null || echo "check constraint manually if psql unavailable"
```

- [ ] **Step 4: Commit**

```bash
git add packages/foundation/database/schema/credits.ts packages/foundation/database/migrations/
git commit -m "feat(credits): add music_generation resource type"
```

---

### Task 2: Inference gateway — `music.ts` adapter

**Files:**
- Create: `apps/inference-gateway/src/music.ts`
- Modify: `apps/inference-gateway/src/router.ts` (add `vertexMusicBreaker`)
- Test: `apps/inference-gateway/src/music.test.ts`

**Interfaces:**
- Consumes: `CircuitBreaker` from `./circuit-breaker` (constructor: `new CircuitBreaker(name, { failureThreshold, resetTimeoutMs })`, methods `isAvailable()`, `onSuccess()`, `onFailure()` — same shape `vertexImageBreaker` already uses in `router.ts`).
- Produces: `generateMusic(req: MusicGenerationRequest): Promise<MusicGenerationResult>` and `handleMusicGenerations(req, res, readBody)`, consumed by Task 3 (route registration) and `generateSong.ts` (Task 6, via HTTP, not a direct import).

- [ ] **Step 1: Add the breaker to `router.ts`**

In `apps/inference-gateway/src/router.ts`, next to the existing image breakers (around line 36-37):

```ts
export const vertexMusicBreaker = new CircuitBreaker('vertex-music', { failureThreshold: 10, resetTimeoutMs: 60_000 });
```

No Gemini-API-key fallback breaker — `lyria-002` has no equivalent on that surface (Global Constraints).

- [ ] **Step 2: Write the failing test for response classification**

Create `apps/inference-gateway/src/music.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  vertexMusicBreaker: { isAvailable: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
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

import { classifyVertexMusicResponse, generateMusic } from './music'
import { vertexMusicBreaker } from './router.js'

describe('classifyVertexMusicResponse', () => {
  it('extracts base64 audio bytes from a normal predict response', () => {
    const predictResponse = {
      predictions: [{ bytesBase64Encoded: 'QUJD', mimeType: 'audio/wav' }],
    }
    expect(classifyVertexMusicResponse(predictResponse)).toEqual({
      audioBase64: 'QUJD',
      mimeType: 'audio/wav',
    })
  })

  it('classifies an empty predictions list as a refusal', () => {
    expect(classifyVertexMusicResponse({ predictions: [] })).toEqual({
      refused: true,
      reason: 'NO_PREDICTIONS',
    })
  })

  it('classifies a missing bytesBase64Encoded field as a refusal', () => {
    expect(classifyVertexMusicResponse({ predictions: [{ mimeType: 'audio/wav' }] })).toEqual({
      refused: true,
      reason: 'NO_AUDIO_BYTES',
    })
  })
})

describe('generateMusic — single-path invariant (no fallback)', () => {
  const req = { model: 'lyria-002', prompt: 'a calm lo-fi beat' }
  const okBody = { predictions: [{ bytesBase64Encoded: 'QUJD', mimeType: 'audio/wav' }] }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('vertex success → returns audio bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateMusic(req)

    expect(result).toEqual({ audioBase64: 'QUJD', mimeType: 'audio/wav' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('lyria-002:predict')
    expect(vertexMusicBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('vertex failure → throws cleanly, no fallback attempted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'vertex boom' })
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateMusic(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/vertex boom/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vertexMusicBreaker.onFailure).toHaveBeenCalledTimes(1)
  })

  it('vertex circuit open → throws cleanly without attempting a call', async () => {
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateMusic(req) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/circuit open/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a model not on the allowlist before making any call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateMusic({ model: 'lyria-3-pro-preview', prompt: 'x' }) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Unsupported music model/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/inference-gateway && pnpm exec vitest run music.test.ts`
Expected: FAIL — `Cannot find module './music'`.

- [ ] **Step 3: Implement `music.ts`**

Create `apps/inference-gateway/src/music.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexMusicBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const MUSIC_MODEL_ALLOWLIST = new Set(['lyria-002'])

const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

export interface MusicGenerationRequest {
  model: string
  prompt: string
}

export type MusicGenerationResult =
  | { audioBase64: string; mimeType: string }
  | { refused: true; reason: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyVertexMusicResponse(vertexResponse: any): MusicGenerationResult {
  const prediction = vertexResponse?.predictions?.[0]
  if (!prediction) return { refused: true, reason: 'NO_PREDICTIONS' }
  if (typeof prediction.bytesBase64Encoded !== 'string') return { refused: true, reason: 'NO_AUDIO_BYTES' }
  return { audioBase64: prediction.bytesBase64Encoded, mimeType: prediction.mimeType ?? 'audio/wav' }
}

async function callVertexMusicModel(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${req.model}:predict`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt: req.prompt }] }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Vertex music generation failed: ${res.status} ${await res.text()}`)
  return classifyVertexMusicResponse(await res.json())
}

export class UnsupportedMusicModelError extends Error {}

// No fallback tier — lyria-002 has no Gemini-API-key equivalent (see spec's
// "No Gemini-API-key fallback tier" note). A Vertex failure or open circuit
// is a clean throw; there is nothing to fall back to.
export async function generateMusic(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  if (!MUSIC_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedMusicModelError(`Unsupported music model: ${req.model}`)
  }
  if (!vertexMusicBreaker.isAvailable()) {
    throw new Error('Vertex music generation unavailable (circuit open)')
  }
  try {
    const result = await callVertexMusicModel(req)
    vertexMusicBreaker.onSuccess()
    return result
  } catch (err) {
    vertexMusicBreaker.onFailure()
    throw err
  }
}

export async function handleMusicGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: MusicGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await generateMusic(payload)
    latency.observe({ adapter: 'music' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'music', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'music' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'music', status: 'failure' })
    if (err instanceof UnsupportedMusicModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[music] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/inference-gateway && pnpm exec vitest run music.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/inference-gateway/src/music.ts apps/inference-gateway/src/music.test.ts apps/inference-gateway/src/router.ts
git commit -m "feat(inference-gateway): add lyria-002 music generation adapter"
```

---

### Task 3: Inference gateway — route registration

**Files:**
- Modify: `apps/inference-gateway/src/index.ts`

**Interfaces:**
- Consumes: `handleMusicGenerations` from `./music.js` (Task 2).
- Produces: `POST /v1/music/generations` HTTP endpoint, consumed by `generateSong.ts` (Task 6).

- [ ] **Step 1: Import and register the route**

In `apps/inference-gateway/src/index.ts`, add the import near the existing `handleImageGenerations` import:

```ts
import { handleMusicGenerations } from './music.js';
```

Add the route block right after the existing images block (around line 381-385):

```ts
  // Music generation (Producer agent)
  if (req.method === 'POST' && req.url === '/v1/music/generations') {
    await handleMusicGenerations(req, res, readBody);
    return;
  }
```

- [ ] **Step 2: Verify the gateway builds**

Run: `cd apps/inference-gateway && pnpm build`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/inference-gateway/src/index.ts
git commit -m "feat(inference-gateway): register POST /v1/music/generations route"
```

---

### Task 4: `musicCredits.ts` — refund helper

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/musicCredits.ts`

**Interfaces:**
- Consumes: `spendCredits` from `@serverless-saas/credits`; `shortestExpiresAt` from `../../credits.js`; `getPool` from `../../usage.js`.
- Produces: `refundMusicCharge(tenantId, agentId, chargeKey, rateId, rateVersion): Promise<void>`, consumed by `generateSong.ts` (Task 6).

- [ ] **Step 1: Create the file**

Direct copy of `apps/agent-orchestrator/src/mastra/tools/imageCredits.ts` with `image_generation` → `music_generation` and the function/log-line renamed:

```ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

// Shared by generateSong.ts — mirrors refundImageCharge's read-back pattern
// (imageCredits.ts) and refundTask's (products/agent-platform/packages/credits/refund.ts):
// the refund amount and expiry are read back from the ledger, never trusted
// from in-memory state, and the refund grant inherits the SHORTEST expiry
// among the grants the original debit drew from.
export async function refundMusicCharge(
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
        actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'music_generation',
        grantType: 'refund', expiresAt,
      })
    } catch (err) {
      console.error(
        `[credits] UNREFUNDED MUSIC CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed; tenant is still down ${-net} micro-credits for a ` +
        `generation that could not be saved. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(
      `[credits] refundMusicCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`,
      (err as Error).message,
    )
  }
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`
Expected: no errors attributable to this file.

- [ ] **Step 3: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/musicCredits.ts
git commit -m "feat(agent-orchestrator): add refundMusicCharge helper"
```

---

### Task 5: `generateSong.ts` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/generateSong.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/generateSong.test.ts`

**Interfaces:**
- Consumes: `costMicro, isUnlimited, resolveRate, spendCredits` from `@serverless-saas/credits`; `uploadGeneratedFile` from `../../persistence.js` (signature: `(idToken: string, input: { conversationId: string; title: string; content: string | Buffer; contentType?: string; extension?: string }) => Promise<AttachmentPayload | null>`); `refundMusicCharge` from `./musicCredits.js` (Task 4); gateway `POST /v1/music/generations` (Task 3).
- Produces: `generateSong` (a Mastra `createTool` instance with `id: 'generate-song'`), consumed by `producerAgent.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/generateSong.test.ts`:

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

import { generateSong } from './generateSong.js'
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
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 20_000 } })
})

describe('generateSong tool', () => {
  it('calls the gateway, charges credits only after success, uploads the result, and returns metadata only', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ audioBase64: 'QUJD', mimeType: 'audio/wav' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'song.wav', type: 'audio/wav', size: 3 })

    const result = await generateSong.execute!({ prompt: 'a calm lo-fi beat' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -20_000n, kind: 'debit', jobType: 'music_generation' }))
    expect(result).toEqual({ fileId: 'f1', name: 'song.wav', fileType: 'audio/wav', size: 3 })
    expect(result).not.toHaveProperty('audioBase64')
  })

  it('does not charge when the gateway refuses', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ refused: true, reason: 'NO_PREDICTIONS' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateSong.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'NO_PREDICTIONS' })
  })

  it('refunds when the post-charge upload fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ audioBase64: 'QUJD', mimeType: 'audio/wav' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const query = vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-20000', expires_at: null }] })
    getPool.mockReturnValue({ query })

    const result = await generateSong.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantId: 't1', amountMicro: 20_000n, kind: 'refund', grantType: 'refund', jobType: 'music_generation',
    }))
    expect(result).toEqual({ refused: true, refusalReason: 'STORAGE_FAILED' })
  })

  it('returns insufficientCredits when spendCredits throws after a successful generation', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ audioBase64: 'QUJD', mimeType: 'audio/wav' }), { status: 200 })) as unknown as typeof fetch
    spendCredits.mockRejectedValue(Object.assign(new Error('insufficient'), { name: 'InsufficientCreditsError' }))

    const result = await generateSong.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(uploadGeneratedFile).not.toHaveBeenCalled()
    expect(result).toEqual({ insufficientCredits: true })
  })

  it('returns GENERATION_FAILED without charging when a non-refused gateway response is missing audioBase64', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ mimeType: 'audio/wav' }), { status: 200 })) as unknown as typeof fetch

    const result = await generateSong.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'GENERATION_FAILED' })
  })

  it('returns GENERATION_FAILED when the gateway call itself throws', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch

    const result = await generateSong.execute!({ prompt: 'anything' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toEqual({ refused: true, refusalReason: 'GENERATION_FAILED' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateSong.test.ts`
Expected: FAIL — `Cannot find module './generateSong.js'`.

- [ ] **Step 3: Implement `generateSong.ts`**

Create `apps/agent-orchestrator/src/mastra/tools/generateSong.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { refundMusicCharge } from './musicCredits.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MUSIC_MODEL = 'lyria-002'

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})

export const generateSong = createTool({
  id: 'generate-song',
  description: 'Generates a ~30-second instrumental music clip from a text prompt using Lyria. No vocals, no lyrics, no song structure. Use when the user asks Producer to create or generate instrumental music.',
  inputSchema: z.object({
    prompt: z.string().describe('Mood/genre/style description of the instrumental clip to generate'),
  }),
  outputSchema,
  execute: async (inputData, execContext) => {
    const { prompt } = inputData as { prompt: string }
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'

    let genResult: { audioBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/music/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: MUSIC_MODEL, prompt }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateSong gateway call failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    if (genResult.refused) {
      return { refused: true, refusalReason: genResult.reason ?? 'unknown' }
    }

    if (typeof genResult.audioBase64 !== 'string') {
      console.error(`[session:${sessionId}] generateSong: gateway returned a non-refused response with no audioBase64`)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    const chargeKey = `music:${sessionId}:${randomUUID()}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('music_generation', MUSIC_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED MUSIC GENERATION: no active music_generation rate for model=${MUSIC_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        const amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'music_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
          throw err
        }
      }
    }

    const buffer = Buffer.from(genResult.audioBase64, 'base64')
    const extension = (genResult.mimeType ?? 'audio/wav').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'wav'
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, {
          conversationId, title: 'Generated Song', content: buffer,
          contentType: genResult.mimeType, extension,
        })
      : null

    if (!attachment) {
      if (charged) await refundMusicCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED' }
    }

    return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
  },
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/generateSong.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateSong.ts apps/agent-orchestrator/src/mastra/tools/generateSong.test.ts
git commit -m "feat(agent-orchestrator): add generate_song tool"
```

---

### Task 6: `producerAgent.ts` + registry

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/agents/producerAgent.ts`
- Modify: `apps/agent-orchestrator/src/mastra/registry.ts`

**Interfaces:**
- Consumes: `generateSong` from `../tools/generateSong.js` (Task 5); `selectModel` from `./modelSelection.js`; `getMastraMemory` from `../memory.js`; `tenantContextSchema` from `../context.js` — all already used identically by `directorAgent.ts`.
- Produces: `producerAgent` (Mastra `Agent`), registered under `AGENT_REGISTRY['producer']`, consumed at runtime by `resolveAgent()` — no other file imports it directly.

- [ ] **Step 1: Create `producerAgent.ts`**

Mirrors `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` exactly in structure:

```ts
import { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { tenantContextSchema } from '../context.js'
import { selectModel } from './modelSelection.js'
import { getMastraMemory } from '../memory.js'
import { generateSong } from '../tools/generateSong.js'

export const producerAgent = new Agent({
  id: 'pc-producer',
  name: 'Producer',
  description: 'Generates instrumental music clips from a text description.',
  instructions: async ({ requestContext }: { requestContext?: RequestContext }) => {
    const base = `You are Producer — an instrumental music generation specialist.

## Rules
- Call generate_song for a new instrumental clip from a mood/genre/style description.
- This produces a short (~30 second) INSTRUMENTAL piece only — no vocals, no lyrics, no verse/chorus structure. If the user asks for a "song" with singing or lyrics, tell them plainly that's not supported yet, BEFORE attempting a generation — do not call the tool and let it fail.
- Before claiming a clip is ready, check the tool result for a fileId field. No fileId means no clip exists yet, regardless of what else the result contains — never say "here's your track" or similar in that case.
- If a generation returns refused: true, check refusalReason:
  - "GENERATION_FAILED": tell the user generation failed due to a temporary issue — they can try again.
  - "STORAGE_FAILED": tell the user the clip WAS generated successfully but could not be saved (likely a storage limit) — this is not a content refusal.
  - Any other reason: tell the user their request could not be fulfilled and why, plainly.
- If insufficientCredits is returned, tell the user they're out of credits — do not retry.
- Never invent a fileId — only use one an earlier tool result actually gave you.
- Never restate a tool result's fileId, name, fileType, or size in your reply text — the UI already renders an attachment card with that information. Reply with plain conversational text only.`
    const persona = requestContext?.get('personaPersonality') as string | undefined
    return persona ? `${persona}\n\n${base}` : base
  },
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  tools: { generate_song: generateSong },
})
```

- [ ] **Step 2: Register in `registry.ts`**

In `apps/agent-orchestrator/src/mastra/registry.ts`, add the import:

```ts
import { producerAgent } from './agents/producerAgent.js'
```

Add to `AGENT_REGISTRY`:

```ts
const AGENT_REGISTRY: Record<string, Agent> = {
  disco:      platformAgent as unknown as Agent,
  'pm agent': pmAgent as unknown as Agent,
  architect:  architectAgent as unknown as Agent,
  director:   directorAgent as unknown as Agent,
  producer:   producerAgent as unknown as Agent,
}
```

Add a branch to `resolveAgentLabel`:

```ts
  if (agent === (producerAgent as unknown as Agent)) return 'producerAgent'
```

Add a `DEFAULT_AGENTS` display entry:

```ts
  {
    name: 'Producer',
    description: 'Generates instrumental music',
    type: 'assistant',
    status: 'active',
    is_internal: false,
    apiKeyName: 'Producer API Key',
  },
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/agent-orchestrator && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/producerAgent.ts apps/agent-orchestrator/src/mastra/registry.ts
git commit -m "feat(agent-orchestrator): add Producer agent, register in AGENT_REGISTRY"
```

---

### Task 7: `chatStream.ts` — attachment delivery gate

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:133,209,375`
- Test: `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts`

**Interfaces:**
- Consumes: nothing new — modifies existing constants/logic in place.
- Produces: `generate-song` tool results now survive the attachment gate, same as `generate-image`/`edit-image` already do.

- [ ] **Step 1: Write the failing test**

Add to `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts` (adjacent to any existing `attachmentFromCanvasToolResult` test — if none exists yet for images, add both in this same step, following whatever pattern the file already uses for testing exported pure functions):

```ts
import { attachmentFromCanvasToolResult } from '../chatStream.js'

describe('attachmentFromCanvasToolResult — generate-song', () => {
  it('returns an attachment payload for a generate-song result with a fileId', () => {
    const result = attachmentFromCanvasToolResult('generate-song', { fileId: 'f1', name: 'song.wav', fileType: 'audio/wav', size: 100 })
    expect(result).toEqual({ fileId: 'f1', name: 'song.wav', type: 'audio/wav', size: 100 })
  })

  it('returns null for a generate-song result with no fileId (refusal)', () => {
    const result = attachmentFromCanvasToolResult('generate-song', { refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/routes/__tests__/chatStream.test.ts -t "generate-song"`
Expected: FAIL — `attachmentFromCanvasToolResult` returns `null` for `'generate-song'` because it isn't in the allowlist yet.

- [ ] **Step 3: Update the two allowlists**

In `apps/agent-orchestrator/src/routes/chatStream.ts:133`:

```ts
  if (!['render-canvas', 'generate-image', 'edit-image', 'generate-song'].includes(normalizedToolName)) return null
```

Line 209:

```ts
  const SAVE_TOOL_NAMES = new Set(['saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks', 'rendercanvas', 'render-canvas', 'render_canvas', 'generate-image', 'edit-image', 'generate-song'])
```

Line 375's ephemeral-display exclusion list:

```ts
          if (SAVE_TOOL_NAMES.has(normName) && !['render-canvas', 'generate-image', 'edit-image', 'generate-song'].includes(normName)) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/routes/__tests__/chatStream.test.ts -t "generate-song"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full chatStream test suite to check for regressions**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/routes/__tests__/chatStream.test.ts`
Expected: PASS, no regressions in the existing `generate-image`/`edit-image`/`render-canvas` cases.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts
git commit -m "fix(agent-orchestrator): let generate-song results reach the chat client"
```

---

### Task 8: Roster seeding — personas, onboarding, backfill

**Files:**
- Modify: `products/agent-platform/packages/api/seeds/personas.ts`
- Modify: `apps/api/src/routes/onboarding.ts` (after the Director block, ~line 392)
- Modify: `packages/foundation/database/seeds/backfill-agents.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: a `producer` persona row (draft), a `Producer` agent row per new tenant (onboarding) and per existing tenant (backfill) — no code elsewhere depends on these directly; they're read at runtime via `resolveAgent('Producer')` matching `AGENT_REGISTRY['producer']` (Task 6) by substring.

- [ ] **Step 1: Add the persona seed entry**

In `products/agent-platform/packages/api/seeds/personas.ts`, add to `DEFAULT_PERSONAS` (after the `director` entry):

```ts
  {
    slug: 'producer',
    name: 'Producer',
    tagline: 'Generates instrumental music clips from a description.',
    basePersonality: 'You think in mood and texture: you turn a rough description into a concrete musical brief, and never claim a clip exists until the generation actually succeeds.',
    skillTags: ['music-generation'],
  },
```

Update the file's header comment (`Seeds the 4 default personas`) to `5 default personas`.

- [ ] **Step 2: Add the onboarding.ts block**

In `apps/api/src/routes/onboarding.ts`, immediately after the Director block (after the `agentSkills` insert around line 392), add:

```ts
    // Seed Producer Agent
    const [producerPersona] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, 'producer')).limit(1);
    if (!producerPersona) {
        console.warn('[onboarding] producer persona not found — run the personas seed before onboarding tenants. Creating Producer agent with personaId: null.');
    }

    const producerRawKey = `ak_${randomBytes(32).toString('hex')}`;
    const producerKeyHash = createHash('sha256').update(producerRawKey).digest('hex');
    const [producerKey] = await db.insert(apiKeys).values({
        tenantId,
        name: 'Producer API Key',
        type: 'agent',
        keyHash: producerKeyHash,
        permissions: agentRolePermissionStrings,
        status: 'active',
        createdBy: userId,
    }).returning();
    const [producerAgentRow] = await db.insert(agents).values({
        tenantId,
        name: 'Producer',
        type: 'custom',
        status: 'active',
        description: 'Generates instrumental music clips from a description.',
        apiKeyId: producerKey.id,
        personaId: producerPersona?.id ?? null,
        createdBy: userId,
    }).returning();
    await db.insert(agentSkills).values({
        agentId: producerAgentRow.id,
        tenantId,
        name: 'default',
        systemPrompt: 'You are Producer. Generate instrumental music from a description.',
        tools: [],
        status: 'active',
    });
```

(`producerAgentRow` is unused past this point, same as `directorAgentRow` — this matches the existing pattern exactly, not a new inconsistency.)

- [ ] **Step 3: Add the backfill entry**

In `packages/foundation/database/seeds/backfill-agents.ts`, add to the agents array (after the Director entry):

```ts
    {
        name: 'Producer',
        description: 'Generates instrumental music clips from a description.',
        systemPrompt: 'You are Producer. Generate instrumental music from a description.',
        personaSlug: 'producer',
    },
```

- [ ] **Step 4: Verify all three files compile / typecheck**

Run:
```bash
cd apps/api && pnpm exec tsc --noEmit
cd ../../packages/foundation/database && pnpm exec tsc --noEmit
cd ../../products/agent-platform/packages/api && pnpm exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/seeds/personas.ts apps/api/src/routes/onboarding.ts packages/foundation/database/seeds/backfill-agents.ts
git commit -m "feat(onboarding): seed Producer persona and agent across all rosters"
```

---

### Task 9: Manual deployment and verification steps (not code — run by a human after review)

**Files:** none — this task is operational, not a code change.

- [ ] **Step 1: Deploy the Lambda** (roster seeding changes reach `apps/api`)

```bash
pnpm --filter @serverless-saas/database build
pnpm --filter @serverless-saas/agent-* build  # rebuild product packages, per the stale-dist/ footgun
sam build --config-file samconfig.dev.toml
sam deploy --config-file samconfig.dev.toml
```

- [ ] **Step 2: Run the one-time seed scripts**

```bash
pnpm --filter @serverless-saas/agent-api db:seed:personas
node packages/foundation/database/seeds/backfill-agents.ts   # or however this repo invokes it — check package.json script name
```

- [ ] **Step 3: Insert the `music_generation` credit rate row**

Business decision, not an engineering one — get the `per_call_micro` value from whoever owns pricing before running this step (flagged in the spec, not invented here):

```sql
insert into credit_rates (resource_type, subject, version, pricing_schema, is_active)
values ('music_generation', 'lyria-002', 1, '{"per_call_micro": <agreed_value>}'::jsonb, true);
```

- [ ] **Step 4: Restart the two VM services this change touches**

```bash
pm2 restart agent-orchestrator
pm2 restart inference-gateway
```

- [ ] **Step 5: Publish the Producer persona**

Attach a real preview asset, then:
```
PUT /ops/personas/:id   (set exampleAssetUrl)
POST /ops/personas/:id/publish
```

- [ ] **Step 6: Manual smoke test**

In dev, chat with Producer, request an instrumental clip (e.g. "make a calm lo-fi beat"), confirm it round-trips through S3 and appears in chat. Separately, ask for "a song with lyrics" and confirm Producer declines before any tool call fires (check server logs — `generate_song` should not appear in the tool-call trace for that turn).

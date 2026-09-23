# Talking-Head Skill (Skill 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `talking-head` skill in `apps/agent-orchestrator` that turns a script + voice pick into one continuous 15-30s lip-synced spokesperson video, built on three new prerequisite tools (narration, lip-sync, clip assembly) routed through `apps/inference-gateway` the same way every existing generation tool is.

**Architecture:** Phase 0 adds two gateway routes (`/v1/audio/speech`, `/v1/video/lipsync`) plus three orchestrator tools (`generate_narration`, `lipsync`, `assemble_clips`) that call them, following `generateVideo.ts`'s charge-before-call/toolCallId-chargeKey pattern (never `generateSong.ts`'s divergent one). Phase 1 wires a new `TALKING_HEAD_SECTION` into `directorAgent.ts` describing the 11-step flow: cast sheet → one continuous narration (locked into working memory) → clip-count/duration computation → per-clip stills with a board gate → per-clip silent video (with a motion-craft override so only the last clip pins its end state) → ffmpeg assembly → one lip-sync pass → prose QA → deliver.

**Tech Stack:** TypeScript, Mastra (`@mastra/core/tools`), Hono-free raw Node HTTP gateway (`apps/inference-gateway`), Zod schemas, Vitest, ffmpeg/ffprobe via `execFile`, Drizzle (credit-rate seeds), Postgres (`credit_ledger`/`credit_grants` refund read-back).

**Spec:** `docs/superpowers/specs/2026-09-20-talking-head-design.md`

## Global Constraints

- Every vendor call (Cartesia, fal.ai/Sync Labs) goes through `apps/inference-gateway` — never called directly from the orchestrator. This is the one architectural correction from the spec's revision note; do not regress it.
- Charge credits **before** the vendor/gateway call, never after (`generateVideo.ts`'s pattern) — `generateSong.ts` charges after and is a known-divergent tool, not a template to copy.
- ChargeKey is derived from `execContext.agent.toolCallId`, never a fresh `randomUUID()` per execution and never `sessionId` alone — both make `spendCredits`' idempotency a no-op.
- `agentId` is read as `execContext?.requestContext?.get('agentId') as string | undefined` and left `undefined` when absent — never defaulted to `''`, which breaks Postgres's `::uuid` cast and aborts the charge.
- Every new generation tool needs all three of: a credit-rate seed row, a `GENERATION_APPROVAL_METADATA` entry under **both** its hyphenated and underscored key, and a per-tool refund helper. Skipping any one is a silent-failure mode (free/unapproved generation, or a stream-resume crash, or an un-refundable failed charge).
- `generate_narration`'s script cap is 500 characters (not 1000) — this refuses an overlong script before any charge, given the 30-second ceiling.
- `assemble_clips` and `lipsync` are shared prerequisite infra with skill 7 (`short-drama-stitch`, not yet built) — keep them general-purpose, not talking-head-specific in naming or behavior.
- Total ad length is capped at 30 seconds; clip count is capped at 3.

---

## File Structure

**New files:**
- `apps/inference-gateway/src/speech.ts` — Cartesia narration adapter + HTTP handler (mirrors `music.ts`'s single-vendor shape).
- `apps/inference-gateway/src/speech.test.ts`
- `apps/inference-gateway/src/lipsync.ts` — lip-sync adapter (fal.ai default, Sync Labs alternate) + HTTP handler, with polling (no existing precedent for polling in this gateway — `video.ts`'s Veo branch polls a *Vertex* long-running op, which is a close-enough shape to follow for the polling loop's structure, but this is genuinely new vendor integration code).
- `apps/inference-gateway/src/lipsync.test.ts`
- `apps/agent-orchestrator/src/mastra/tools/generateNarration.ts`
- `apps/agent-orchestrator/src/mastra/tools/generateNarration.test.ts`
- `apps/agent-orchestrator/src/mastra/tools/narrationCredits.ts` — refund helper, `jobType: 'narration_generation'`.
- `apps/agent-orchestrator/src/mastra/tools/lipsync.ts`
- `apps/agent-orchestrator/src/mastra/tools/lipsync.test.ts`
- `apps/agent-orchestrator/src/mastra/tools/lipsyncCredits.ts` — refund helper, `jobType: 'lipsync_generation'`.
- `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts`
- `apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts`

**Modified files:**
- `apps/inference-gateway/src/index.ts` — two new dispatch routes.
- `packages/foundation/database/seeds/credit-rates.ts` — three new rate rows.
- `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts` — three new `GENERATION_APPROVAL_METADATA` entries (six keys total, hyphenated + underscored each).
- `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` — three new tool imports, three new tool-map entries (both `directorAgent` and `directorAgentDelegate`), one new `TALKING_HEAD_SECTION` appended to `base`.
- `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts` — extend the existing override-survival test to also assert the new section header.

---

### Task 1: Gateway route — `POST /v1/audio/speech` (Cartesia narration)

**Files:**
- Create: `apps/inference-gateway/src/speech.ts`
- Create: `apps/inference-gateway/src/speech.test.ts`
- Modify: `apps/inference-gateway/src/index.ts` (add dispatch route)

**Interfaces:**
- Produces: `export interface SpeechGenerationRequest { model: string; transcript: string; voiceId: string }`, `export type SpeechGenerationResult = { audioBase64: string; mimeType: string; durationSeconds: number } | { refused: true; reason: string }`, `export async function generateSpeech(req: SpeechGenerationRequest): Promise<SpeechGenerationResult>`, `export async function handleSpeechGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void>`.
- Consumes: `requestsTotal`, `latency` from `./metrics.js` (same as `music.ts`/`video.ts`).

- [ ] **Step 1: Write the failing test for the adapter function**

```ts
// apps/inference-gateway/src/speech.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('CARTESIA_API_KEY', 'test-key')

import { generateSpeech, UnsupportedSpeechModelError } from './speech.js'

describe('generateSpeech', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('rejects a model not on the allowlist', async () => {
    await expect(generateSpeech({ model: 'not-a-real-model', transcript: 'hi', voiceId: 'v1' }))
      .rejects.toThrow(UnsupportedSpeechModelError)
  })

  it('calls Cartesia and returns audio plus duration on success', async () => {
    // Cartesia returns raw WAV bytes; duration is read from the WAV header's
    // data-chunk size and sample rate, not from a JSON field (Cartesia's
    // /tts/bytes response is the audio file itself, not JSON).
    const sampleRate = 44100
    const numSamples = sampleRate * 2 // 2 seconds of silence
    const dataSize = numSamples * 2 // 16-bit PCM
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVE', 8)
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(dataSize, 40)
    const wavBytes = Buffer.concat([header, Buffer.alloc(dataSize)])

    global.fetch = vi.fn(async () => new Response(wavBytes, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    })) as unknown as typeof fetch

    const result = await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello world', voiceId: 'v1' })

    expect(result).toMatchObject({ mimeType: 'audio/wav', durationSeconds: 2 })
    expect('audioBase64' in result && typeof result.audioBase64 === 'string').toBe(true)
  })

  it('returns a refused result when Cartesia returns a non-ok, non-throwing status', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400 })) as unknown as typeof fetch

    await expect(generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'v1' }))
      .rejects.toThrow(/Cartesia speech generation failed/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/speech.test.ts`
Expected: FAIL — `Cannot find module './speech.js'`

- [ ] **Step 3: Write the adapter implementation**

```ts
// apps/inference-gateway/src/speech.ts
import type { IncomingMessage, ServerResponse } from 'http'
import { requestsTotal, latency } from './metrics.js'

const SPEECH_MODEL_ALLOWLIST = new Set(['sonic-3.5'])

// Cartesia's own versioning header — one value, used consistently, unlike
// apps/web's two existing Cartesia call sites which currently disagree
// (2026-03-01 vs 2026-08-14). Picking the more recent one deliberately;
// apps/web's inconsistency is out of scope to fix here (see spec's Open
// Questions).
const CARTESIA_VERSION = '2026-08-14'

export interface SpeechGenerationRequest {
  model: string
  transcript: string
  voiceId: string
}

export type SpeechGenerationResult =
  | { audioBase64: string; mimeType: string; durationSeconds: number }
  | { refused: true; reason: string }

export class UnsupportedSpeechModelError extends Error {}

// Reads duration from a canonical 44-byte WAV header (RIFF/WAVE, one fmt
// chunk before data) rather than trusting any vendor-reported duration field
// — Cartesia's /tts/bytes response is the raw audio file, not a JSON
// envelope with metadata. sampleRate and numChannels come straight from the
// fmt chunk so this works regardless of what output_format was requested.
export function readWavDurationSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file')
  }
  const numChannels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)
  const dataSize = buf.readUInt32LE(40)
  const bytesPerSample = bitsPerSample / 8
  const numSamples = dataSize / (bytesPerSample * numChannels)
  return numSamples / sampleRate
}

async function callCartesia(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  const key = process.env.CARTESIA_API_KEY ?? ''
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: req.model,
      transcript: req.transcript,
      voice: { mode: 'id', id: req.voiceId },
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
      language: 'en',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`Cartesia speech generation failed: ${res.status} ${await res.text()}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const durationSeconds = readWavDurationSeconds(buf)
  return { audioBase64: buf.toString('base64'), mimeType: 'audio/wav', durationSeconds }
}

export async function generateSpeech(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  if (!SPEECH_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedSpeechModelError(`Unsupported speech model: ${req.model}`)
  }
  return callCartesia(req)
}

export async function handleSpeechGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: SpeechGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await generateSpeech(payload)
    latency.observe({ adapter: 'speech' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'speech', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'speech' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'speech', status: 'failure' })
    if (err instanceof UnsupportedSpeechModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[speech] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/speech.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the dispatch route into `index.ts`**

Find the existing block (around where `/v1/music/generations` is dispatched):

```ts
  // Music generation (Producer agent)
  if (req.method === 'POST' && req.url === '/v1/music/generations') {
    await handleMusicGenerations(req, res, readBody);
    return;
  }
```

Add immediately after it:

```ts
  // Speech/narration generation (talking-head skill)
  if (req.method === 'POST' && req.url === '/v1/audio/speech') {
    await handleSpeechGenerations(req, res, readBody);
    return;
  }
```

Add the import near the other adapter imports at the top of the file:

```ts
import { handleSpeechGenerations } from './speech.js';
```

- [ ] **Step 6: Manually verify the route is reachable**

Run: `cd apps/inference-gateway && pnpm build && node dist/index.js &` then in another shell:
```bash
curl -s -X POST http://localhost:4001/v1/audio/speech \
  -H "Content-Type: application/json" \
  -H "x-internal-service-key: $INTERNAL_SERVICE_KEY" \
  -d '{"model":"sonic-3.5","transcript":"test","voiceId":"invalid-id-for-manual-check"}' | head -c 300
```
Expected: a 503 with a Cartesia error message (proves the route dispatches and reaches Cartesia, not a 401/404) — do not expect success without a real `CARTESIA_API_KEY` and valid `voiceId`. Kill the background process after checking (`kill %1`).

- [ ] **Step 7: Commit**

```bash
git add apps/inference-gateway/src/speech.ts apps/inference-gateway/src/speech.test.ts apps/inference-gateway/src/index.ts
git commit -m "feat(gateway): add POST /v1/audio/speech for Cartesia narration"
```

---

### Task 2: Gateway route — `POST /v1/video/lipsync` (fal.ai LatentSync default, Sync Labs alternate)

**Files:**
- Create: `apps/inference-gateway/src/lipsync.ts`
- Create: `apps/inference-gateway/src/lipsync.test.ts`
- Modify: `apps/inference-gateway/src/index.ts` (add dispatch route)

**Interfaces:**
- Produces: `export interface LipsyncGenerationRequest { model: string; videoUri: string; audioUri: string }`, `export type LipsyncGenerationResult = { videoBase64: string; mimeType: string } | { refused: true; reason: string }`, `export async function generateLipsync(req: LipsyncGenerationRequest): Promise<LipsyncGenerationResult>`, `export async function handleLipsyncGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void>`.
- Consumes: `requestsTotal`, `latency` from `./metrics.js`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/inference-gateway/src/lipsync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('FAL_API_KEY', 'test-fal-key')
vi.stubEnv('SYNC_LABS_API_KEY', 'test-sync-key')

import { generateLipsync, UnsupportedLipsyncModelError, LipsyncTimeoutError } from './lipsync.js'

describe('generateLipsync', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
  })

  it('rejects a model not on the allowlist', async () => {
    await expect(generateLipsync({ model: 'not-real', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' }))
      .rejects.toThrow(UnsupportedLipsyncModelError)
  })

  it('submits to fal.ai, polls until complete, and returns the result video', async () => {
    const fetchMock = vi.fn()
      // 1. submit job
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-1' }), { status: 200 }))
      // 2. first poll: still processing
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 }))
      // 3. second poll: complete, with a result video URL
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', video: { url: 'https://fal.example/out.mp4' } }), { status: 200 }))
      // 4. download the result video bytes
      .mockResolvedValueOnce(new Response(Buffer.from('fake-mp4-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
    global.fetch = fetchMock as unknown as typeof fetch

    const promise = generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    // Advance past the poll interval once so the second (IN_PROGRESS) poll and
    // the third (COMPLETED) poll both get their turn on the fake timer queue.
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await promise

    expect(result).toMatchObject({ mimeType: 'video/mp4' })
    expect('videoBase64' in result && typeof result.videoBase64 === 'string').toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('throws LipsyncTimeoutError if the job never completes within the budget', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-1' }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const promise = generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    const assertion = expect(promise).rejects.toThrow(LipsyncTimeoutError)
    await vi.advanceTimersByTimeAsync(300_000)
    await assertion
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && npx vitest run src/lipsync.test.ts`
Expected: FAIL — `Cannot find module './lipsync.js'`

- [ ] **Step 3: Write the adapter implementation**

```ts
// apps/inference-gateway/src/lipsync.ts
import type { IncomingMessage, ServerResponse } from 'http'
import { requestsTotal, latency } from './metrics.js'

const LIPSYNC_MODEL_ALLOWLIST = new Set(['fal-ai/latentsync', 'sync-2.0'])

// Matches generateVideo.ts's in-turn blocking-timeout shape (270s), per the
// spec's explicit recommendation not to invent a new async pattern until the
// platform-wide async job layer exists. This runs inside a live SSE chat
// turn — there is no queue/watchdog bridge for this yet.
const POLL_TIMEOUT_MS = 270_000
const POLL_INTERVAL_MS = 5_000

export interface LipsyncGenerationRequest {
  model: string
  videoUri: string
  audioUri: string
}

export type LipsyncGenerationResult =
  | { videoBase64: string; mimeType: string }
  | { refused: true; reason: string }

export class UnsupportedLipsyncModelError extends Error {}
export class LipsyncTimeoutError extends Error {}

async function downloadResultVideo(url: string): Promise<{ videoBase64: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`lipsync result download failed: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const mimeType = res.headers.get('content-type') ?? 'video/mp4'
  return { videoBase64: buf.toString('base64'), mimeType }
}

// fal.ai's queue API: submit returns a request_id, poll a status endpoint
// until status is COMPLETED (or an error status), then the completed
// response carries the result video's URL.
async function callFalLatentsync(req: LipsyncGenerationRequest): Promise<LipsyncGenerationResult> {
  const key = process.env.FAL_API_KEY ?? ''
  const submitRes = await fetch('https://queue.fal.run/fal-ai/latentsync', {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: req.videoUri, audio_url: req.audioUri }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!submitRes.ok) throw new Error(`fal.ai lipsync submit failed: ${submitRes.status} ${await submitRes.text()}`)
  const { request_id: requestId } = await submitRes.json() as { request_id?: string }
  if (!requestId) throw new Error('fal.ai lipsync submit returned no request_id')

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const pollRes = await fetch(`https://queue.fal.run/fal-ai/latentsync/requests/${requestId}/status`, {
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!pollRes.ok) throw new Error(`fal.ai lipsync poll failed: ${pollRes.status}`)
    const status = await pollRes.json() as { status?: string; video?: { url?: string }; error?: string }
    if (status.status === 'COMPLETED') {
      if (!status.video?.url) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
      return downloadResultVideo(status.video.url)
    }
    if (status.status === 'FAILED' || status.error) {
      return { refused: true, reason: status.error ?? 'LIPSYNC_FAILED' }
    }
    // IN_QUEUE / IN_PROGRESS — keep polling
  }
  throw new LipsyncTimeoutError(`fal.ai lipsync job ${requestId} did not complete within ${POLL_TIMEOUT_MS}ms`)
}

// Sync Labs' API: submit returns an id, poll a status endpoint the same
// shape as fal.ai's — kept as a distinct function (not merged with the fal
// branch above) because the two vendors' actual field names differ even
// though the poll-loop shape is similar; a future third vendor is more
// likely to need its own function than to fit a forced-shared abstraction.
async function callSyncLabs(req: LipsyncGenerationRequest): Promise<LipsyncGenerationResult> {
  const key = process.env.SYNC_LABS_API_KEY ?? ''
  const submitRes = await fetch('https://api.synclabs.so/lipsync', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl: req.videoUri, audioUrl: req.audioUri, model: 'sync-2.0' }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!submitRes.ok) throw new Error(`Sync Labs submit failed: ${submitRes.status} ${await submitRes.text()}`)
  const { id: jobId } = await submitRes.json() as { id?: string }
  if (!jobId) throw new Error('Sync Labs submit returned no id')

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const pollRes = await fetch(`https://api.synclabs.so/lipsync/${jobId}`, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(15_000),
    })
    if (!pollRes.ok) throw new Error(`Sync Labs poll failed: ${pollRes.status}`)
    const status = await pollRes.json() as { status?: string; videoUrl?: string; error?: string }
    if (status.status === 'COMPLETED') {
      if (!status.videoUrl) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
      return downloadResultVideo(status.videoUrl)
    }
    if (status.status === 'FAILED' || status.error) {
      return { refused: true, reason: status.error ?? 'LIPSYNC_FAILED' }
    }
  }
  throw new LipsyncTimeoutError(`Sync Labs job ${jobId} did not complete within ${POLL_TIMEOUT_MS}ms`)
}

export async function generateLipsync(req: LipsyncGenerationRequest): Promise<LipsyncGenerationResult> {
  if (!LIPSYNC_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedLipsyncModelError(`Unsupported lipsync model: ${req.model}`)
  }
  if (req.model === 'sync-2.0') return callSyncLabs(req)
  return callFalLatentsync(req)
}

export async function handleLipsyncGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: LipsyncGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await generateLipsync(payload)
    latency.observe({ adapter: 'lipsync' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'lipsync', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'lipsync' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'lipsync', status: 'failure' })
    if (err instanceof UnsupportedLipsyncModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    if (err instanceof LipsyncTimeoutError) {
      res.writeHead(504, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'timeout_error' } }))
      return
    }
    console.error('[lipsync] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && npx vitest run src/lipsync.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the dispatch route into `index.ts`**

Add after the `/v1/video/generations` block:

```ts
  // Lip-sync (talking-head skill)
  if (req.method === 'POST' && req.url === '/v1/video/lipsync') {
    await handleLipsyncGenerations(req, res, readBody);
    return;
  }
```

Add the import:

```ts
import { handleLipsyncGenerations } from './lipsync.js';
```

- [ ] **Step 6: Commit**

```bash
git add apps/inference-gateway/src/lipsync.ts apps/inference-gateway/src/lipsync.test.ts apps/inference-gateway/src/index.ts
git commit -m "feat(gateway): add POST /v1/video/lipsync for fal.ai LatentSync / Sync Labs"
```

---

### Task 3: Credit-rate seed rows for narration, lip-sync, and assembly

**Files:**
- Modify: `packages/foundation/database/seeds/credit-rates.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `RATES` array.
- Produces: three rows queryable by `resolveRate('narration_generation', 'sonic-3.5')`, `resolveRate('lipsync_generation', 'fal-ai/latentsync')`, `resolveRate('clip_assembly', 'ffmpeg-local')` — these exact `resourceType`/`subject` pairs are the contract every later task's tool code and `GENERATION_APPROVAL_METADATA` entries must match verbatim.

- [ ] **Step 1: Add the three new rows**

Insert after the existing `video_generation` rows, before the `message`/`tool_call`/`skill_run` free rows:

```ts
  // Cartesia sonic-3.5: ~$0.02 per 30s ad script (per spec's cost research,
  // $40-42/1M characters, ~500 chars max script = ~$0.021). Priced with
  // margin at a flat per-call rate rather than per-character, matching this
  // codebase's existing flat-per-call convention for narration-sized clips.
  { resourceType: 'narration_generation', subject: 'sonic-3.5',
    pricingSchema: { per_call_micro: 30_000 } },
  // fal.ai LatentSync: flat $0.20 per generation for outputs <=40s (spec's
  // Gemini research). Priced with margin.
  { resourceType: 'lipsync_generation', subject: 'fal-ai/latentsync',
    pricingSchema: { per_call_micro: 250_000 } },
  // Sync Labs sync-2.0: $0.08/output-second; priced flat assuming a
  // worst-case ~30s ad (this skill's hard ceiling), same "flat per-call,
  // not metered" convention generateVideo.ts already uses for its own
  // duration-variable pricing.
  { resourceType: 'lipsync_generation', subject: 'sync-2.0',
    pricingSchema: { per_call_micro: 2_500_000 } },
  // assemble_clips is pure local ffmpeg compute — no vendor cost. Priced at
  // a small flat rate rather than zero, per the spec's open question:
  // resolveRate() finding no rate at all makes shouldRequireApproval() skip
  // the approval card silently (treated as "free, no charge" rather than
  // "no card, but still gated") — a tiny non-zero rate keeps this tool on
  // the same charge/approval code path as every other generation tool
  // instead of carving out a new no-approval code path for one tool.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-local',
    pricingSchema: { per_call_micro: 1_000 } },
```

- [ ] **Step 2: Run the seed script against local Postgres to verify it applies cleanly**

Run: `cd packages/foundation/database && pnpm exec tsx -e "import { seedCreditRates } from './seeds/credit-rates.js'; import { db } from './index.js'; await seedCreditRates(db); process.exit(0)"`
Expected: no error; log line `seeding credit rates` with no thrown exception. (Requires a local `DATABASE_URL` — if none is configured in this environment, skip live execution and instead run `pnpm type-check` in `packages/foundation/database` to confirm the file is syntactically and type-valid; note in the commit message that live seeding was not run.)

- [ ] **Step 3: Commit**

```bash
git add packages/foundation/database/seeds/credit-rates.ts
git commit -m "feat(credits): seed rates for narration, lip-sync, and clip assembly"
```

---

### Task 4: `generate_narration` orchestrator tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/generateNarration.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/generateNarration.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/narrationCredits.ts`

**Interfaces:**
- Consumes: `costMicro, isUnlimited, resolveRate, spendCredits` from `@serverless-saas/credits`; `uploadGeneratedFile` from `../../persistence.js`; `shouldRequireApproval` from `./generationApproval.js`.
- Produces: `export const generateNarration = createTool({ id: 'generate-narration', ... })` with `inputSchema: z.object({ script: z.string().max(500), voiceId: z.string() })` and `outputSchema` fields `fileId?, durationSeconds?, refused?, refusalReason?, insufficientCredits?, creditsUsedMicro?, jobId?` — `durationSeconds` on the output is what Task 8 (directorAgent instructions) tells Director to read and lock into working memory. `export async function refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion): Promise<void>` from `narrationCredits.ts`.

- [ ] **Step 1: Write `narrationCredits.ts` (refund helper) first — it's a dependency of the tool's test mocks**

```ts
// apps/agent-orchestrator/src/mastra/tools/narrationCredits.ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

// Mirrors refundVideoCharge/refundImageCharge exactly — see those files'
// comments for why the amount/expiry are always read back from the ledger
// rather than trusted from in-memory state, and why the refund inherits the
// shortest expiry among the grants the original debit drew from.
export async function refundNarrationCharge(
  tenantId: string, agentId: string | undefined, chargeKey: string,
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
        actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'narration_generation',
        grantType: 'refund', expiresAt,
      })
    } catch (err) {
      console.error(
        `[credits] UNREFUNDED NARRATION CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundNarrationCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Write the failing test for the tool**

```ts
// apps/agent-orchestrator/src/mastra/tools/generateNarration.test.ts
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

import { generateNarration } from './generateNarration.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 30_000 } })
  shouldRequireApproval.mockResolvedValue(false)
})

describe('generateNarration tool', () => {
  it('charges credits BEFORE calling the gateway, then uploads and returns fileId + durationSeconds', async () => {
    const callOrder: string[] = []
    ;(spendCredits as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('charge') })
    global.fetch = vi.fn(async () => {
      callOrder.push('gateway')
      return new Response(JSON.stringify({ audioBase64: 'QUJD', mimeType: 'audio/wav', durationSeconds: 12.5 }), { status: 200 })
    }) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'narration.wav', type: 'audio/wav', size: 3 })

    const result = await generateNarration.execute!({ script: 'Hello world', voiceId: 'v1' } as never, baseCtx())

    expect(callOrder).toEqual(['charge', 'gateway'])
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', amountMicro: -30_000n, kind: 'debit', jobType: 'narration_generation' }))
    expect(result).toMatchObject({ fileId: 'f1', durationSeconds: 12.5 })
  })

  it('refuses a script over 500 characters via the schema before any charge', async () => {
    const longScript = 'a'.repeat(501)
    // Zod validation happens at the Mastra tool-call boundary, not inside
    // execute() — this test calls execute() directly (bypassing that
    // boundary, same as every other tool test in this codebase), so assert
    // the schema itself rejects the input rather than expecting execute()
    // to re-validate.
    const parseResult = generateNarration.inputSchema!.safeParse({ script: longScript, voiceId: 'v1' })
    expect(parseResult.success).toBe(false)
  })

  it('refunds the charge when the gateway call fails after a successful charge', async () => {
    ;(spendCredits as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    global.fetch = vi.fn(async () => { throw new Error('network error') }) as unknown as typeof fetch
    ;(getPool as ReturnType<typeof vi.fn>).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-30000', expires_at: null }] }) })

    const result = await generateNarration.execute!({ script: 'Hello', voiceId: 'v1' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'GENERATION_FAILED' })
    // refund path re-calls spendCredits with kind: 'refund'
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refund', jobType: 'narration_generation' }))
  })

  it('does not default agentId to empty string when absent from requestContext', async () => {
    ;(spendCredits as ReturnType<typeof vi.fn>).mockImplementation(async (args) => {
      expect(args.actorId).toBeUndefined()
    })
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ audioBase64: 'QUJD', mimeType: 'audio/wav', durationSeconds: 5 }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f1', name: 'n.wav', type: 'audio/wav', size: 3 })

    await generateNarration.execute!({ script: 'Hi', voiceId: 'v1' } as never, ctx({ tenantId: 't1', conversationId: 'c1', idToken: 'tok' }))
    expect(spendCredits).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateNarration.test.ts`
Expected: FAIL — `Cannot find module './generateNarration.js'`

- [ ] **Step 4: Write the tool implementation**

```ts
// apps/agent-orchestrator/src/mastra/tools/generateNarration.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { refundNarrationCharge } from './narrationCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const SPEECH_MODEL = 'sonic-3.5'

const outputSchema = z.object({
  fileId: z.string().optional(),
  durationSeconds: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

const inputSchema = z.object({
  script: z.string().max(500).describe(
    'The full narration script — one continuous read, not pre-split into clip-sized segments. ~500 characters is roughly 30-35 seconds of speech at typical ad pacing, matching this skill\'s 30s ceiling.'
  ),
  voiceId: z.string().describe('A Cartesia voice id, from the existing curated voice list.'),
})

export const generateNarration = createTool({
  id: 'generate-narration',
  description: 'Generates a full narration/voiceover audio clip from a script using Cartesia. Use for the talking-head skill\'s single continuous narration track — not for per-beat dialogue, which uses generate_video\'s native speech instead.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'narration_generation', subject: SPEECH_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { script, voiceId } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    // Left undefined, never '' — see generateVideo.ts's identical comment:
    // spendCredits' actorId does `?? null` internally so undefined casts
    // cleanly to ::uuid, but '' hits Postgres as ''::uuid and throws.
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    // Charge BEFORE the vendor call — same settled rule generateVideo.ts
    // follows. generateSong.ts charges after and is a known-divergent tool,
    // not a template.
    const attempt = 0
    const chargeKey = `narration:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('narration_generation', SPEECH_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED NARRATION GENERATION: no active narration_generation rate for model=${SPEECH_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'narration_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let genResult: { audioBase64?: string; mimeType?: string; durationSeconds?: number; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: SPEECH_MODEL, transcript: script, voiceId }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateNarration gateway call failed:`, (err as Error).message)
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.audioBase64 !== 'string' || typeof genResult.durationSeconds !== 'number') {
      console.error(`[session:${sessionId}] generateNarration: gateway returned a non-refused response with no audioBase64/durationSeconds`)
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (!conversationId || !idToken) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = Buffer.from(genResult.audioBase64, 'base64')
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Generated Narration', content: buffer,
      contentType: genResult.mimeType ?? 'audio/wav', extension: 'wav',
    })

    if (!attachment) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId,
      durationSeconds: genResult.durationSeconds,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generateNarration.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateNarration.ts apps/agent-orchestrator/src/mastra/tools/generateNarration.test.ts apps/agent-orchestrator/src/mastra/tools/narrationCredits.ts
git commit -m "feat(orchestrator): add generate_narration tool"
```

---

### Task 5: `lipsync` orchestrator tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/lipsync.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/lipsync.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/lipsyncCredits.ts`

**Interfaces:**
- Consumes: `fetchPresignedUrl` from `./mediaCache.js` (to resolve `videoFileId`/`audioFileId` into gateway-reachable URLs — the gateway's `/v1/video/lipsync` route takes `videoUri`/`audioUri`, not file ids, same as `generateVideo.ts` resolves `startImageFileId` into `imageUri` before calling the gateway).
- Produces: `export const lipsync = createTool({ id: 'lipsync', ... })`, `inputSchema: z.object({ videoFileId: z.string(), audioFileId: z.string(), model: z.string().default('fal-ai/latentsync') })`, same `outputSchema` shape as `generateNarration` minus `durationSeconds`. `export async function refundLipsyncCharge(...)` from `lipsyncCredits.ts`.

- [ ] **Step 1: Write `lipsyncCredits.ts`**

```ts
// apps/agent-orchestrator/src/mastra/tools/lipsyncCredits.ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

export async function refundLipsyncCharge(
  tenantId: string, agentId: string | undefined, chargeKey: string,
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
        actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'lipsync_generation',
        grantType: 'refund', expiresAt,
      })
    } catch (err) {
      console.error(
        `[credits] UNREFUNDED LIPSYNC CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundLipsyncCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/tools/lipsync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(), getPool: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))
const { fetchPresignedUrl } = vi.hoisted(() => ({ fetchPresignedUrl: vi.fn() }))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl }))
const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))

import { lipsync } from './lipsync.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 250_000 } })
  shouldRequireApproval.mockResolvedValue(false)
  fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
})

describe('lipsync tool', () => {
  it('resolves both file ids to URIs, charges before the gateway call, and returns the synced clip', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f2', name: 'synced.mp4', type: 'video/mp4', size: 3 })

    const result = await lipsync.execute!({ videoFileId: 'v1', audioFileId: 'a1' } as never, baseCtx())

    expect(fetchPresignedUrl).toHaveBeenCalledWith('v1', 'tok')
    expect(fetchPresignedUrl).toHaveBeenCalledWith('a1', 'tok')
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'lipsync_generation' }))
    expect(result).toMatchObject({ fileId: 'f2' })
  })

  it('defaults model to fal-ai/latentsync when not specified', async () => {
    let sentBody: Record<string, unknown> = {}
    global.fetch = vi.fn(async (_url, opts: RequestInit) => {
      sentBody = JSON.parse(opts.body as string)
      return new Response(JSON.stringify({ videoBase64: 'QUJD', mimeType: 'video/mp4' }), { status: 200 })
    }) as unknown as typeof fetch
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'f2', name: 'synced.mp4', type: 'video/mp4', size: 3 })

    await lipsync.execute!({ videoFileId: 'v1', audioFileId: 'a1' } as never, baseCtx())
    expect(sentBody.model).toBe('fal-ai/latentsync')
  })

  it('refuses with SOURCE_UNAVAILABLE if a file id cannot be resolved, before any charge', async () => {
    fetchPresignedUrl.mockRejectedValueOnce(new Error('not found'))

    const result = await lipsync.execute!({ videoFileId: 'missing', audioFileId: 'a1' } as never, baseCtx())

    expect(spendCredits).not.toHaveBeenCalled()
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/lipsync.test.ts`
Expected: FAIL — `Cannot find module './lipsync.js'`

- [ ] **Step 4: Write the tool implementation**

```ts
// apps/agent-orchestrator/src/mastra/tools/lipsync.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { refundLipsyncCharge } from './lipsyncCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const DEFAULT_LIPSYNC_MODEL = 'fal-ai/latentsync'

const outputSchema = z.object({
  fileId: z.string().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

const inputSchema = z.object({
  videoFileId: z.string(),
  audioFileId: z.string(),
  model: z.string().default(DEFAULT_LIPSYNC_MODEL).describe(
    'A gateway-allowlisted lip-sync model id. Default is cheaper and fully managed; relative output quality against the alternate (sync-2.0) is untested.'
  ),
})

export const lipsync = createTool({
  id: 'lipsync',
  description: 'Matches a silent video\'s mouth motion to a separate audio track. Use once, on the fully assembled silent video, against the full narration track — never per-clip.',
  inputSchema,
  outputSchema,
  requireApproval: async (input, ctx) => {
    const { model } = input as z.infer<typeof inputSchema>
    return shouldRequireApproval({ resourceType: 'lipsync_generation', subject: model ?? DEFAULT_LIPSYNC_MODEL }, ctx)
  },
  execute: async (inputData, execContext) => {
    const { videoFileId, audioFileId, model } = inputData as z.infer<typeof inputSchema>
    const resolvedModel = model ?? DEFAULT_LIPSYNC_MODEL

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    let videoUri: string, audioUri: string
    try {
      ;[videoUri, audioUri] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(audioFileId, idToken),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] lipsync: failed to resolve source files:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `lipsync:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('lipsync_generation', resolvedModel)
      if (!rate) {
        console.error(`[credits] UNBILLED LIPSYNC GENERATION: no active lipsync_generation rate for model=${resolvedModel} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'lipsync_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let genResult: { videoBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/video/lipsync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: resolvedModel, videoUri, audioUri }),
        // Strictly larger than the gateway's own 270s poll budget for the
        // same reason generateVideo.ts's 270s must exceed the gateway's 240s
        // Gemini timeout — this clock starts first and must not abort before
        // the gateway's own internal timeout could.
        signal: AbortSignal.timeout(290_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] lipsync gateway call failed:`, (err as Error).message)
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.videoBase64 !== 'string') {
      console.error(`[session:${sessionId}] lipsync: gateway returned a non-refused response with no videoBase64`)
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = Buffer.from(genResult.videoBase64, 'base64')
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Lip-Synced Video', content: buffer,
      contentType: genResult.mimeType ?? 'video/mp4', extension: 'mp4',
    })

    if (!attachment) {
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/lipsync.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/lipsync.ts apps/agent-orchestrator/src/mastra/tools/lipsync.test.ts apps/agent-orchestrator/src/mastra/tools/lipsyncCredits.ts
git commit -m "feat(orchestrator): add lipsync tool"
```

---

### Task 6: `assemble_clips` orchestrator tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts`

**Interfaces:**
- Consumes: `downloadToSessionCache, fetchPresignedUrl` from `./mediaCache.js`; `promisify(execFile)` pattern from `node:child_process`/`node:util`, matching `media.ts`'s existing use.
- Produces: `export const assembleClips = createTool({ id: 'assemble-clips', ... })`, `inputSchema: z.object({ clipFileIds: z.array(z.string()).min(1).max(3), targetDurationSeconds: z.number().optional(), aspectRatio: z.enum(['16:9', '9:16']) })`, `outputSchema` with `fileId?, refused?, refusalReason?, jobId?` (no `insufficientCredits`/`creditsUsedMicro` fields required by callers, but keep them for consistency with the credit-rate row from Task 3 — this tool does charge a small flat rate per Task 3's design).

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))
const { fetchPresignedUrl, downloadToSessionCache } = vi.hoisted(() => ({
  fetchPresignedUrl: vi.fn(), downloadToSessionCache: vi.fn(),
}))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl, downloadToSessionCache }))
const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile }))

import { assembleClips } from './assembleClips.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
  shouldRequireApproval.mockResolvedValue(false)
  fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
  downloadToSessionCache.mockImplementation(async (_scope: string, fileId: string) => ({
    filePath: `/tmp/${fileId}.mp4`, buf: Buffer.from('x'), mimeType: 'video/mp4',
  }))
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' })
  })
})

describe('assembleClips tool', () => {
  it('downloads every clip, runs ffmpeg, and uploads the concatenated result', async () => {
    const fs = await import('node:fs')
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2', 'c3'], aspectRatio: '9:16' } as never, baseCtx())

    expect(downloadToSessionCache).toHaveBeenCalledTimes(3)
    expect(execFile).toHaveBeenCalled()
    expect(result).toMatchObject({ fileId: 'assembled1' })
  })

  it('rejects more than 3 clip file ids at the schema level', () => {
    const parsed = assembleClips.inputSchema!.safeParse({ clipFileIds: ['a', 'b', 'c', 'd'], aspectRatio: '9:16' })
    expect(parsed.success).toBe(false)
  })

  it('refuses with SOURCE_UNAVAILABLE if a clip cannot be downloaded, before running ffmpeg', async () => {
    downloadToSessionCache.mockRejectedValueOnce(new Error('too large'))

    const result = await assembleClips.execute!({ clipFileIds: ['c1'], aspectRatio: '9:16' } as never, baseCtx())

    expect(execFile).not.toHaveBeenCalled()
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/assembleClips.test.ts`
Expected: FAIL — `Cannot find module './assembleClips.js'`

- [ ] **Step 3: Write `assemblyCredits.ts` (refund helper) — written first since the tool implementation in Step 4 imports it directly**

```ts
// apps/agent-orchestrator/src/mastra/tools/assemblyCredits.ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

// Mirrors refundVideoCharge/refundImageCharge/refundNarrationCharge/
// refundLipsyncCharge exactly — see refundVideoCharge's comments (in
// videoCredits.ts) for why the amount/expiry are always read back from the
// ledger rather than trusted from in-memory state.
export async function refundAssemblyCharge(
  tenantId: string, agentId: string | undefined, chargeKey: string,
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
        actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'clip_assembly',
        grantType: 'refund', expiresAt,
      })
    } catch (err) {
      console.error(
        `[credits] UNREFUNDED ASSEMBLY CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundAssemblyCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 4: Write the tool implementation**

```ts
// apps/agent-orchestrator/src/mastra/tools/assembleClips.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundAssemblyCharge } from './assemblyCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const ASSEMBLY_SUBJECT = 'ffmpeg-local'
// Matches media.ts's FFMPEG_TIMEOUT_MS pattern, sized generously for a
// 3-clip concat rather than the single-clip frame-extraction case that file
// times out at 60s.
const FFMPEG_TIMEOUT_MS = 60_000
// Matches analyzeVideo.ts's MAX_VIDEO_BYTES cap — same class of input.
const MAX_CLIP_BYTES = 200 * 1024 * 1024

const outputSchema = z.object({
  fileId: z.string().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

const inputSchema = z.object({
  clipFileIds: z.array(z.string()).min(1).max(3),
  targetDurationSeconds: z.number().optional().describe(
    'When set, the assembled video is trimmed (extra tail dropped) or the final frame held (tpad) to match this length — used to align the silent clip total to the narration track length.'
  ),
  aspectRatio: z.enum(['16:9', '9:16']),
})

export const assembleClips = createTool({
  id: 'assemble-clips',
  description: 'Concatenates an ordered list of silent video clips into one video, normalized to a constant frame rate and fixed aspect ratio. Shared infra for talking-head and short-drama-stitch — not talking-head-specific.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: ASSEMBLY_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { clipFileIds, targetDurationSeconds, aspectRatio } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    const localPaths: string[] = []
    try {
      for (const fileId of clipFileIds) {
        const presignedUrl = await fetchPresignedUrl(fileId, idToken)
        const { filePath } = await downloadToSessionCache(scopeId, fileId, presignedUrl, MAX_CLIP_BYTES)
        localPaths.push(filePath)
      }
    } catch (err) {
      console.error(`[session:${sessionId}] assembleClips: failed to download a clip:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Charge BEFORE running ffmpeg — same settled ordering as every other
    // generation tool, even though this is local compute, not a vendor call:
    // consistent charge-before-work ordering means a crash mid-ffmpeg-run
    // behaves the same way (refund path, not a silent free run) as a crash
    // mid-vendor-call elsewhere.
    const attempt = 0
    const chargeKey = `assembly:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', ASSEMBLY_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED CLIP ASSEMBLY: no active clip_assembly rate tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'clip_assembly',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    const workDir = mkdtempSync(join(tmpdir(), 'assemble-'))
    const outputPath = join(workDir, 'assembled.mp4')
    try {
      // Normalizes every clip to CFR 30fps, a fixed aspect ratio, and strips
      // any audio stream (-an on each input leg) before concatenating — the
      // lip-sync step supplies the only audio that matters downstream, and
      // concat fails outright if inputs disagree on stream presence.
      const [w, h] = aspectRatio === '9:16' ? ['1080', '1920'] : ['1920', '1080']
      const filterParts = localPaths.map((_, i) =>
        `[${i}:v]fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      )
      const concatInputs = localPaths.map((_, i) => `[v${i}]`).join('')
      const filterComplex = `${filterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=0[outv]`

      const args: string[] = ['-y']
      for (const p of localPaths) args.push('-i', p)
      args.push('-filter_complex', filterComplex, '-map', '[outv]', '-an')
      if (targetDurationSeconds !== undefined) {
        args.push('-vf', `tpad=stop_mode=clone:stop_duration=${Math.max(0, targetDurationSeconds)}`, '-t', String(targetDurationSeconds))
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outputPath)

      await execFile('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] assembleClips: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'ASSEMBLY_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = readFileSync(outputPath)
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Assembled Video', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/assembleClips.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/assembleClips.ts apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts apps/agent-orchestrator/src/mastra/tools/assemblyCredits.ts
git commit -m "feat(orchestrator): add assemble_clips tool"
```

---

### Task 7: Register all three tools' approval metadata

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: three new entries added to the existing `GENERATION_APPROVAL_METADATA` export — this is the exact map `chatStream.ts` reads by `toolName` to rebuild an approval card's display fields; Task 8's directorAgent wiring depends on these keys existing before any of the three tools can be called under Director-as-delegate without crashing on resume.

- [ ] **Step 1: Add the three new resource constants and metadata entries**

Find:

```ts
const IMAGE_MODEL = 'gemini-3-pro-image-preview'
const VIDEO_MODEL = 'google/gemini-omni-1.1-flash'
const MUSIC_MODEL = 'lyria-002'
```

Replace with:

```ts
const IMAGE_MODEL = 'gemini-3-pro-image-preview'
const VIDEO_MODEL = 'google/gemini-omni-1.1-flash'
const MUSIC_MODEL = 'lyria-002'
const NARRATION_MODEL = 'sonic-3.5'
const LIPSYNC_MODEL = 'fal-ai/latentsync'
const ASSEMBLY_SUBJECT = 'ffmpeg-local'
```

Find:

```ts
const imageGen = { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Generate image' }
const videoGen = { resourceType: 'video_generation', subject: VIDEO_MODEL, label: 'Generate video' }
const songGen = { resourceType: 'music_generation', subject: MUSIC_MODEL, label: 'Generate song' }
const imageEdit = { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Edit image' }
```

Replace with:

```ts
const imageGen = { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Generate image' }
const videoGen = { resourceType: 'video_generation', subject: VIDEO_MODEL, label: 'Generate video' }
const songGen = { resourceType: 'music_generation', subject: MUSIC_MODEL, label: 'Generate song' }
const imageEdit = { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Edit image' }
const narrationGen = { resourceType: 'narration_generation', subject: NARRATION_MODEL, label: 'Generate narration' }
const lipsyncGen = { resourceType: 'lipsync_generation', subject: LIPSYNC_MODEL, label: 'Lip-sync video' }
const assemblyGen = { resourceType: 'clip_assembly', subject: ASSEMBLY_SUBJECT, label: 'Assemble clips' }
```

Find:

```ts
  'edit-image': imageEdit,
  'edit_image': imageEdit,
  'save_skill': {
```

Replace with:

```ts
  'edit-image': imageEdit,
  'edit_image': imageEdit,
  'generate-narration': narrationGen,
  'generate_narration': narrationGen,
  'lipsync': lipsyncGen,
  'assemble-clips': assemblyGen,
  'assemble_clips': assemblyGen,
  'save_skill': {
```

(`lipsync` has no hyphenated/underscored variant since its `createTool` id and the directorAgent tool-map key are both the bare word `lipsync` — only one entry is needed for it, matching how a single-word tool id needs no dual registration.)

- [ ] **Step 2: Write a test asserting all three new entries exist under both required key forms**

```ts
// Append to the existing generationApproval test file, or create
// apps/agent-orchestrator/src/mastra/tools/generationApproval.test.ts if none exists yet
import { describe, it, expect } from 'vitest'
import { GENERATION_APPROVAL_METADATA } from './generationApproval.js'

describe('GENERATION_APPROVAL_METADATA — talking-head tools', () => {
  it('registers generate_narration under both hyphenated and underscored keys', () => {
    expect(GENERATION_APPROVAL_METADATA['generate-narration']).toBeDefined()
    expect(GENERATION_APPROVAL_METADATA['generate_narration']).toBeDefined()
    expect(GENERATION_APPROVAL_METADATA['generate-narration'].resourceType).toBe('narration_generation')
  })

  it('registers lipsync', () => {
    expect(GENERATION_APPROVAL_METADATA['lipsync']).toBeDefined()
    expect(GENERATION_APPROVAL_METADATA['lipsync'].resourceType).toBe('lipsync_generation')
  })

  it('registers assemble_clips under both hyphenated and underscored keys', () => {
    expect(GENERATION_APPROVAL_METADATA['assemble-clips']).toBeDefined()
    expect(GENERATION_APPROVAL_METADATA['assemble_clips']).toBeDefined()
    expect(GENERATION_APPROVAL_METADATA['assemble-clips'].resourceType).toBe('clip_assembly')
  })
})
```

Check first whether `apps/agent-orchestrator/src/mastra/tools/generationApproval.test.ts` already exists — if it does, append this `describe` block to the end of the existing file rather than creating a new one.

- [ ] **Step 3: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/generationApproval.test.ts`
Expected: PASS (3 tests, plus any pre-existing tests in the file still passing)

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generationApproval.ts apps/agent-orchestrator/src/mastra/tools/generationApproval.test.ts
git commit -m "feat(orchestrator): register approval metadata for narration/lipsync/assembly tools"
```

---

### Task 8: Wire the three tools into Director + add `TALKING_HEAD_SECTION`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts`

**Interfaces:**
- Consumes: `generateNarration` from `../tools/generateNarration.js`, `lipsync` from `../tools/lipsync.js`, `assembleClips` from `../tools/assembleClips.js` (Tasks 4-6's exports).
- Produces: `directorAgent.tools` and `directorAgentDelegate.tools` both gain `generate_narration`, `lipsync`, `assemble_clips` keys — this is the exact shape `chatStream.ts`'s `normalizedToolName` and the approval-card rebuild in Task 7 depend on.

- [ ] **Step 1: Add the three tool imports**

Find:

```ts
import { analyzeImageTool } from '../tools/analyzeImage.js'
```

Add immediately after:

```ts
import { generateNarration } from '../tools/generateNarration.js'
import { lipsync } from '../tools/lipsync.js'
import { assembleClips } from '../tools/assembleClips.js'
```

- [ ] **Step 2: Add `TALKING_HEAD_SECTION`**

Find:

```ts
  const base = (override || defaultInstructions) + TEMPLATE_CLONING_SECTION + UGC_CHARACTER_SECTION + MOTION_CRAFT_SECTION
```

Replace with:

```ts
  const TALKING_HEAD_SECTION = `\n\n## Talking-head generation — one continuous presenter, narration-first pipeline
When Olmo delegates a talking-head ad build (single continuous presenter speaking to camera, script-driven, not a multi-beat storyboard):
- Cast sheet: same as UGC character generation above — one generate_image call with referenceFileIds set to the product photo's fileId if one exists, otherwise no reference. Do not pass identityAnchor on this call.
- Narration: call generate_narration ONCE with the full script and the user's chosen voiceId — never split the script into per-clip segments. As soon as it succeeds, tell Olmo the returned fileId and durationSeconds so Olmo can lock both into working memory's Locked Reference Artifact IDs alongside the cast sheet. Every later step in this flow must use that locked fileId and durationSeconds — never call generate_narration again for the same ad unless the user has explicitly changed the script.
- Clip count: compute clipCount = Math.ceil(durationSeconds / 10), capped at 3. If clipCount would exceed 3 (more than 30 seconds of narration), tell Olmo the script needs to be shorter rather than proceeding.
- Clip durations: split the narration's total duration across clipCount clips as whole-second durations that sum to Math.ceil(durationSeconds), front-loaded toward 10 seconds each (for example a 22-second narration renders as 10+9+3 seconds, not 10+10+10 with 8 seconds discarded). Each individual clip's durationSeconds must stay within generate_video's own 3-10 second range.
- Per-clip stills: generate_image per clip, referenceFileIds set to the cast sheet's fileId, identityAnchor set with the terseTag/styleLock Olmo gives you. Every still must show the presenter's face clearly visible, front-facing or near-front-facing, and alone in frame — never turned away, never out of frame, never replaced by a product-only shot. If a product photo exists, the product may appear alongside the presenter, never in place of them.
- Per-clip silent video: generate_video, mode "animate_frame", off each approved still, at that clip's computed duration. Do not pass approvedDialogue and do not write any quoted dialogue in the prompt — these renders are silent; the narration audio is added later via lip-sync, not native speech. Apply the Motion craft section's rules with one exception here: only the LAST clip should pin to a final held state. Every other clip should end on sustained motion, not a hold, so the cut between clips reads as a continuation under the continuous narration track rather than a series of separate paused shots.
- Assembly: after all clips in this ad are generated and approved, call assemble_clips ONCE with clipFileIds in order and targetDurationSeconds set to the locked narration duration from working memory.
- Lip-sync: call lipsync ONCE — videoFileId set to the assembled clip's fileId, audioFileId set to the locked narration fileId. Do not call lipsync per-clip; it runs exactly once per ad, after assembly, never before.
- QA: call analyze_audio (mode "deep") on the lip-synced result and compare its transcript to the original script, same as template cloning and UGC character generation — flag any meaningful mismatch rather than presenting it as matching.
- Tell Olmo plainly that this ad has a deliberate visible cut where clips join (per the motion-craft exception above), since the narration itself stays continuous across it — this is expected, not a defect to explain away.`

  const base = (override || defaultInstructions) + TEMPLATE_CLONING_SECTION + UGC_CHARACTER_SECTION + MOTION_CRAFT_SECTION + TALKING_HEAD_SECTION
```

- [ ] **Step 3: Add the three tools to both agents' tool maps**

Find (appears twice — once for `directorAgent`, once for `directorAgentDelegate`):

```ts
  tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo, retrieve_template: retrieveTemplate, analyze_video: analyzeVideoTool, analyze_audio: analyzeAudioTool, analyze_image: analyzeImageTool },
```

Replace both occurrences with:

```ts
  tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo, retrieve_template: retrieveTemplate, analyze_video: analyzeVideoTool, analyze_audio: analyzeAudioTool, analyze_image: analyzeImageTool, generate_narration: generateNarration, lipsync: lipsync, assemble_clips: assembleClips },
```

- [ ] **Step 4: Extend the existing override-survival test**

Find in `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts`:

```ts
    expect(text).toContain('## Motion craft')
```

Replace with:

```ts
    expect(text).toContain('## Motion craft')
    expect(text).toContain('## Talking-head generation')
```

- [ ] **Step 5: Add a tool-registration assertion, matching the existing pattern in the same file**

Find:

```ts
describe('directorAgent tool registration', () => {
  it('has analyze_video and analyze_audio registered, needed for template-video-generation', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(directorTools)).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
    expect(Object.keys(delegateTools)).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
  })
})
```

Add immediately after (new `it` inside the same `describe` block):

```ts
  it('has generate_narration, lipsync, and assemble_clips registered, needed for talking-head', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(directorTools)).toEqual(
      expect.arrayContaining(['generate_narration', 'lipsync', 'assemble_clips']),
    )
    expect(Object.keys(delegateTools)).toEqual(
      expect.arrayContaining(['generate_narration', 'lipsync', 'assemble_clips']),
    )
  })
```

- [ ] **Step 6: Run the full directorAgent test file**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: PASS (4 tests total: 2 pre-existing + 2 new/extended)

- [ ] **Step 7: Run the orchestrator's full type-check**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts
git commit -m "feat(orchestrator): wire talking-head tools and instructions into Director"
```

---

### Task 9: End-to-end type-check and full test suite

**Files:** none new — verification only.

- [ ] **Step 1: Run the full orchestrator test suite**

Run: `cd apps/agent-orchestrator && npx vitest run`
Expected: all tests pass, including every test file added in Tasks 4-8.

- [ ] **Step 2: Run the full orchestrator type-check**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: no errors.

- [ ] **Step 3: Run the gateway's test suite and type-check**

Run: `cd apps/inference-gateway && npx vitest run && pnpm type-check`
Expected: all tests pass, no type errors.

- [ ] **Step 4: Run the foundation database package's type-check**

Run: `cd packages/foundation/database && pnpm type-check`
Expected: no errors (confirms Task 3's seed-file edit is valid).

- [ ] **Step 5: Manually confirm ffmpeg is installed on the target VM (prerequisite the spec names but does not itself verify)**

Run on the GCP VM (or note in the PR description if this cannot be checked from this environment): `which ffmpeg && which ffprobe`
Expected: both resolve to a path. If either is missing, this blocks Phase 1 from working in production even though all tests above pass locally — flag it, do not silently proceed assuming it's fine, since `analyze_video`'s existing ffmpeg dependency already relies on this being true and swallows the failure silently (`media.ts`'s catch-and-return-empty-array behavior) if it isn't.

- [ ] **Step 6: No commit for this task — verification only, already covered by prior commits**

---

## Deferred, not part of this plan

- **`lipsync`'s approval-card price preview can undershoot for the non-default model.** `GENERATION_APPROVAL_METADATA['lipsync']` (Task 7) has one static `subject` (the fal.ai default) used to rebuild the approval card's displayed price from a bare `tool-call-approval` chunk — the actual charge in `lipsync.ts` (Task 5) correctly resolves the rate against whichever `model` was really passed, but if Director calls it with `sync-2.0` (the pricier alternate), the pre-approval card the user sees still reflects fal.ai's cheaper rate, while the real charge afterward is Sync Labs' higher one. The charge itself is correct; only the pre-approval estimate can be wrong. Fixing this needs a dynamic `subject` resolution in the approval-metadata rebuild path (the existing `buildPreview` callback shape only covers preview *text*, not `resourceType`/`subject` swapping) — out of scope for this plan; Director's instructions default to the cheaper model precisely so this mismatch is rare in practice.

Per the spec's own Open Questions, explicitly not solved by this plan:
- Single long-shot render feasibility test (would need a live Seedance/equivalent render, evaluated manually).
- Real-world lip-sync provider quality comparison (`fal-ai/latentsync` vs `sync-2.0` against actual generated footage).
- `Cartesia-Version` header reconciliation in `apps/web`'s two existing call sites.
- The platform-wide async job-layer gap (`lipsync`'s poll loop runs in-turn as a stopgap, matching `generate_video`'s existing shape, not a real fix).
- `analyzeAudio.ts`'s 15MB cap potentially rejecting a full assembled 30s clip during QA (named as a known limit in the spec, not fixed here).

# animation-character (skill 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship skill 5 — a stylized, 4-beat, story-arc animated ad (3D Pixar-like / 2D flat / claymation), board-gated stills-first pipeline, one lip-synced hook beat, captioned via a new Gemini-based transcription route.

**Architecture:** Phase 0 adds six new/modified pieces of infra (one gateway route, one modified tool, four new tools) that let the orchestrator mux per-beat audio, transcribe a master with word timings, burn captions, composite a real product photo as the end card, and mix a music bed last. Phase 1 wires all of it into `directorAgent`/`platformAgent` as a new skill section/contract, reusing skill 1/4's existing tools for everything else (image chaining, silent clips, VO, lip-sync, music generation).

**Tech Stack:** Mastra (`@mastra/core`), Zod, `node:child_process` execFile for ffmpeg, Gemini API (`generativelanguage.googleapis.com`) for both video/image (existing) and the new transcription call, Drizzle ORM + Postgres for credits.

**Spec:** `docs/superpowers/specs/2026-09-21-animation-character-design.md`

## Global Constraints

- Every vendor/gateway call is charge-BEFORE-call, refund-AFTER-failure. `chargeKey` is always derived from `execContext.agent.toolCallId`, never `randomUUID()` or a bare sessionId. `generateVideo.ts`/`lipsync.ts`/`generateNarration.ts` are the canonical good pattern; `generateSong.ts` (charges after) is the known-bad counter-example — never copy it.
- `agentId` is read as `execContext?.requestContext?.get('agentId') as string | undefined` and left `undefined` when absent — never defaulted to `''` (breaks a Postgres `::uuid` cast in `spendCredits`).
- ALL vendor calls route through `apps/inference-gateway` — never called directly from an orchestrator tool. The new Gemini transcription call is a gateway route (`POST /v1/audio/transcribe`), not a direct call from `transcribe_audio.ts`.
- Every `createTool`'s `inputSchema` must also be exported as a raw, separately-importable `const inputSchema = z.object({...})` — Mastra's `createTool` wraps it in a type with no `.safeParse`, and a test importing only the wrapped tool cannot type-check a `.safeParse()`/`.parse()` call. This bit skill 4's Task 4 and must not repeat here.
- Any ffmpeg filter-graph change or new ffmpeg invocation needs a task step that actually RUNS ffmpeg locally to verify the graph, not just a mocked-`execFile` unit test. Skill 4's `tpad`/`-filter_complex` bug shipped invisibly past mocked tests and was only caught by live execution.
- `GENERATION_APPROVAL_METADATA` (`generationApproval.ts`) needs BOTH the hyphenated (tool `id`) and underscored (delegate-map key) forms registered for every multi-word tool id — omitting one crashes `chatStream.ts`'s resume logic with "resumeStream() cannot resume tool call ... because it is not suspended."
- 4 fixed beats, 30 seconds total ad length max. Beat roles are fixed: 1) Hook (lip-synced), 2) Low point (VO), 3) Turn (VO), 4) Payoff (VO, composited end card). Style is one of exactly three enum values: `3d_pixar`, `2d_flat`, `claymation` — no freeform style text. Doctrine C only (product recreated in-style, real photo composited only on the end card). Pipeline order is fixed: composite end card BEFORE assembly; music bed laid LAST, after captions, never before.

---

### Task 1: Credits schema — new `audio_transcription` resourceType + seed rows

**Files:**
- Modify: `packages/foundation/database/schema/credits.ts:17-19`
- Modify: `packages/foundation/database/seeds/credit-rates.ts`
- Create: a new Drizzle migration (generated, not hand-written)

**Interfaces:**
- Produces: a `resourceType` enum that includes `'audio_transcription'`, and active rate rows for `('audio_transcription', 'gemini-transcribe')` and four new `('clip_assembly', <new subject>)` rows — `ffmpeg-mux-audio`, `ffmpeg-composite-end-card`, `ffmpeg-burn-captions`, `ffmpeg-mix-music-bed` — that every later task's `resolveRate(...)` call depends on.

- [ ] **Step 1: Widen the `resourceType` enum**

Edit `packages/foundation/database/schema/credits.ts` line 17-19:

```ts
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation', 'music_generation', 'video_generation', 'narration_generation', 'lipsync_generation', 'clip_assembly', 'audio_transcription'],
  }).notNull(),
```

- [ ] **Step 2: Generate the migration**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit generate`

Expected: a new migration file appears under `packages/foundation/database/migrations/` altering the `resource_type` check constraint/enum to include `audio_transcription`. Read the generated SQL to confirm it only adds the new value and does not touch existing rows.

- [ ] **Step 3: Add the five new seed rows**

Edit `packages/foundation/database/seeds/credit-rates.ts`, inserting these rows into the `RATES` array, after the existing `clip_assembly`/`ffmpeg-local` row and before the `message`/`*` row:

```ts
  // Gemini transcription for animation-character's caption pipeline: short
  // (<=30s) audio/video, inline-base64 request, structured JSON output.
  // Priced flat per call, matching every other row's per_call_micro shape —
  // no existing row uses per-token/per-duration pricing and this does not
  // introduce one either. $0.02-ish estimate at Gemini 2.5 Flash rates for
  // a 30s clip plus margin.
  { resourceType: 'audio_transcription', subject: 'gemini-transcribe',
    pricingSchema: { per_call_micro: 15_000 } },
  // animation-character's four new local-ffmpeg steps. Same "pure local
  // compute, small flat non-zero rate" reasoning as the clip_assembly/
  // ffmpeg-local row above — keeps each tool on the normal charge/approval
  // code path instead of a silent no-charge/no-approval carve-out.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-mux-audio',
    pricingSchema: { per_call_micro: 1_000 } },
  { resourceType: 'clip_assembly', subject: 'ffmpeg-composite-end-card',
    pricingSchema: { per_call_micro: 1_000 } },
  { resourceType: 'clip_assembly', subject: 'ffmpeg-burn-captions',
    pricingSchema: { per_call_micro: 1_000 } },
  { resourceType: 'clip_assembly', subject: 'ffmpeg-mix-music-bed',
    pricingSchema: { per_call_micro: 1_000 } },
```

- [ ] **Step 4: Type-check and run the seed**

Run: `cd packages/foundation/database && pnpm type-check`
Expected: PASS (the enum widen must not break any existing typed usage).

Run: `pnpm exec tsx -e "import { seedCreditRates } from './seeds/credit-rates'; import { db } from './index'; seedCreditRates(db).then(() => process.exit(0))"` against a real `DATABASE_URL` if one is available in this environment; if not, leave this step's execution to deployment and note in the commit message that the seed still needs to run once against a live DB.

- [ ] **Step 5: Commit**

```bash
git add packages/foundation/database/schema/credits.ts packages/foundation/database/seeds/credit-rates.ts packages/foundation/database/migrations/
git commit -m "feat(credits): add audio_transcription resourceType + animation-character ffmpeg rate rows"
```

---

### Task 2: Gateway route — `POST /v1/audio/transcribe` (Gemini-based)

**Files:**
- Create: `apps/inference-gateway/src/transcribe.ts`
- Create: `apps/inference-gateway/src/transcribe.test.ts`
- Modify: `apps/inference-gateway/src/index.ts` (add route dispatch)
- Modify: `apps/inference-gateway/.env.example` (no new key needed — reuses `GEMINI_API_KEY`, already present; add a comment noting the new consumer)

**Interfaces:**
- Consumes: `process.env.GEMINI_API_KEY` (already used by `images.ts`/`video.ts`), the existing `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...` call shape.
- Produces: `POST /v1/audio/transcribe` accepting `{ fileUri: string, mimeType: string }`, returning `{ text: string, words: [{ word: string, startSeconds: number, endSeconds: number }] }` on success or `{ refused: true, reason: string }` — this exact shape is what `transcribe_audio.ts` (Task 5) parses.

- [ ] **Step 1: Write the failing test**

Create `apps/inference-gateway/src/transcribe.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio, UnsupportedTranscribeModelError } from './transcribe.js'

describe('transcribeAudio', () => {
  const origKey = process.env.GEMINI_API_KEY
  beforeEach(() => { process.env.GEMINI_API_KEY = 'test-key' })
  afterEach(() => {
    if (origKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = origKey
    vi.restoreAllMocks()
  })

  it('sends the source bytes to Gemini generateContent with a structured JSON responseSchema', async () => {
    const sourceFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'audio/wav' },
      arrayBuffer: async () => new TextEncoder().encode('fake-audio-bytes').buffer,
    })
    const geminiFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          text: 'hello world',
          words: [
            { word: 'hello', startSeconds: 0.1, endSeconds: 0.4 },
            { word: 'world', startSeconds: 0.5, endSeconds: 0.9 },
          ],
        }) }] } }],
      }),
    })
    let call = 0
    global.fetch = vi.fn().mockImplementation((url: string) => {
      call += 1
      return call === 1 ? sourceFetch(url) : geminiFetch(url)
    }) as unknown as typeof fetch

    const result = await transcribeAudio({ fileUri: 'https://example.com/master.mp4', mimeType: 'video/mp4' })

    expect(result).toEqual({
      text: 'hello world',
      words: [
        { word: 'hello', startSeconds: 0.1, endSeconds: 0.4 },
        { word: 'world', startSeconds: 0.5, endSeconds: 0.9 },
      ],
    })
    const geminiCallArgs = geminiFetch.mock.calls[0]
    expect(geminiCallArgs[0]).toContain('generativelanguage.googleapis.com/v1beta/models/')
    expect(geminiCallArgs[0]).toContain(':generateContent')
    const body = JSON.parse(geminiCallArgs[1].body)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseSchema.required).toEqual(['text', 'words'])
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe('video/mp4')
  })

  it('returns refused when Gemini responds with text that fails schema validation', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: { get: () => 'audio/wav' }, arrayBuffer: async () => new ArrayBuffer(8) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"text":"oops"}' }] } }] }),
      }) as unknown as typeof fetch

    const result = await transcribeAudio({ fileUri: 'https://example.com/master.mp4', mimeType: 'video/mp4' })
    expect(result).toEqual({ refused: true, reason: expect.stringContaining('schema') })
  })

  it('throws UnsupportedTranscribeModelError for an unlisted model override', async () => {
    await expect(
      transcribeAudio({ fileUri: 'https://example.com/x.mp4', mimeType: 'video/mp4', model: 'not-a-real-model' }),
    ).rejects.toThrow(UnsupportedTranscribeModelError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/inference-gateway && pnpm vitest run src/transcribe.test.ts`
Expected: FAIL — `Cannot find module './transcribe.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/inference-gateway/src/transcribe.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'http'
import { requestsTotal, latency } from './metrics.js'

const TRANSCRIBE_MODEL_ALLOWLIST = new Set(['gemini-2.5-flash'])
const DEFAULT_TRANSCRIBE_MODEL = 'gemini-2.5-flash'

// Same "matches the caption-length ad" size class as MAX_CLIP_BYTES in
// assembleClips.ts, but this call sends the file inline as base64 rather
// than staging it via the Files API (video.ts's stageImageForOmni does
// that for the image-conditioning path) — inline is simpler and this
// skill's masters are at most a 30-second animated ad, well under Gemini's
// inline-request size ceiling.
const MAX_TRANSCRIBE_SOURCE_BYTES = 20 * 1024 * 1024

export interface TranscribeRequest {
  fileUri: string
  mimeType: string
  model?: string
}

export interface TranscribeWord {
  word: string
  startSeconds: number
  endSeconds: number
}

export type TranscribeResult =
  | { text: string; words: TranscribeWord[] }
  | { refused: true; reason: string }

export class UnsupportedTranscribeModelError extends Error {}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    words: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          startSeconds: { type: 'NUMBER' },
          endSeconds: { type: 'NUMBER' },
        },
        required: ['word', 'startSeconds', 'endSeconds'],
      },
    },
  },
  required: ['text', 'words'],
}

function isValidTranscribePayload(value: unknown): value is { text: string; words: TranscribeWord[] } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.text !== 'string' || !Array.isArray(v.words)) return false
  return v.words.every((w) => {
    if (typeof w !== 'object' || w === null) return false
    const word = w as Record<string, unknown>
    return typeof word.word === 'string' && typeof word.startSeconds === 'number' && typeof word.endSeconds === 'number'
  })
}

export async function transcribeAudio(req: TranscribeRequest): Promise<TranscribeResult> {
  const model = req.model ?? DEFAULT_TRANSCRIBE_MODEL
  if (!TRANSCRIBE_MODEL_ALLOWLIST.has(model)) {
    throw new UnsupportedTranscribeModelError(`Unsupported transcribe model: ${model}`)
  }

  const sourceRes = await fetch(req.fileUri)
  if (!sourceRes.ok) throw new Error(`source fetch failed: HTTP ${sourceRes.status}`)
  const buf = Buffer.from(await sourceRes.arrayBuffer())
  if (buf.length > MAX_TRANSCRIBE_SOURCE_BYTES) {
    return { refused: true, reason: 'Source file exceeds transcription size limit' }
  }

  const key = process.env.GEMINI_API_KEY ?? ''
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: req.mimeType, data: buf.toString('base64') } },
          { text: 'Transcribe the spoken audio in this file exactly as spoken, word for word. Return strict JSON matching the response schema: text is the full transcript, words is every spoken word in order with its start and end time in seconds as decimals. Do not include any commentary outside the JSON.' },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!geminiRes.ok) throw new Error(`Gemini transcription failed: ${geminiRes.status} ${await geminiRes.text()}`)

  const data = await geminiRes.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof rawText !== 'string') {
    return { refused: true, reason: 'Gemini returned no transcript text' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { refused: true, reason: 'Gemini response failed schema validation: not valid JSON' }
  }

  if (!isValidTranscribePayload(parsed)) {
    return { refused: true, reason: 'Gemini response failed schema validation: shape mismatch' }
  }

  return parsed
}

export async function handleTranscribeGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: TranscribeRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await transcribeAudio(payload)
    latency.observe({ adapter: 'transcribe' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'transcribe', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'transcribe' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'transcribe', status: 'failure' })
    if (err instanceof UnsupportedTranscribeModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[transcribe] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/inference-gateway && pnpm vitest run src/transcribe.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the route into `index.ts`**

In `apps/inference-gateway/src/index.ts`, add the import near the other handler imports (alongside `handleSpeechGenerations`) and add the dispatch block right after the existing `/v1/video/lipsync` block:

```ts
import { handleTranscribeGenerations } from './transcribe.js'
```

```ts
  // Transcription with word timings (animation-character skill)
  if (req.method === 'POST' && req.url === '/v1/audio/transcribe') {
    await handleTranscribeGenerations(req, res, readBody)
    return
  }
```

- [ ] **Step 6: Note the reused env var**

In `apps/inference-gateway/.env.example`, add a one-line comment above the existing `GEMINI_API_KEY` entry noting the new consumer (do not add a new key — this reuses the existing one):

```
# Also used by transcribe.ts (animation-character skill's caption pipeline)
```

- [ ] **Step 7: Run the full gateway test suite**

Run: `cd apps/inference-gateway && pnpm type-check && pnpm vitest run`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add apps/inference-gateway/src/transcribe.ts apps/inference-gateway/src/transcribe.test.ts apps/inference-gateway/src/index.ts apps/inference-gateway/.env.example
git commit -m "feat(inference-gateway): add POST /v1/audio/transcribe (Gemini structured word timings)"
```

---

### Task 3: `assemble_clips` — raise clip cap to 4, add `preserveAudio` + `perClipTrimSeconds`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/__tests__/assembleClips.test.ts` (path may differ slightly — locate the existing test file next to `assembleClips.ts` and extend it)

**Interfaces:**
- Consumes: nothing new from earlier tasks in this plan.
- Produces: `inputSchema` gains `clipFileIds: z.array(z.string()).min(1).max(4)` (was `.max(3)`), an optional `preserveAudio: z.boolean().default(false)`, and an optional `perClipTrimSeconds: z.array(z.number().positive()).optional()` (parallel to `clipFileIds` when set). Task 9 (`ANIMATION_CHARACTER_SECTION`) calls this tool with `preserveAudio: true` and 4 clip ids; skill 4/7 callers pass neither new field and keep today's exact behavior.

- [ ] **Step 1: Write the failing tests**

Locate the existing test file (run `find apps/agent-orchestrator/src -iname 'assembleClips.test.ts'` if the exact path isn't obvious) and add these cases, matching its existing `execFile`-mocking style:

```ts
it('accepts 4 clip ids (raised from the old max of 3)', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b', 'c', 'd'],
    aspectRatio: '9:16',
  })
  expect(result.success).toBe(true)
})

it('rejects a 5th clip id', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b', 'c', 'd', 'e'],
    aspectRatio: '9:16',
  })
  expect(result.success).toBe(false)
})

it('builds a v=1:a=1 concat filter and omits -an when preserveAudio is true', async () => {
  // Mirrors this file's existing execFile-mock pattern for asserting the
  // constructed ffmpeg args array, not just that execFile was called.
  const execFileMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
  vi.doMock('node:child_process', () => ({ execFile: execFileMock }))
  // ... invoke assembleClips.execute with preserveAudio: true, clipFileIds
  // length 4, perClipTrimSeconds: [4.5, 5.2, 6.0, 5.5] (mocking
  // fetchPresignedUrl/downloadToSessionCache the same way this file's
  // existing tests do) ...
  const args: string[] = execFileMock.mock.calls[0][1]
  const filterComplexIdx = args.indexOf('-filter_complex')
  expect(args[filterComplexIdx + 1]).toContain('concat=n=4:v=1:a=1')
  expect(args).not.toContain('-an')
})

it('defaults preserveAudio to false and keeps -an when omitted (skill 4/7 backward compat)', async () => {
  const execFileMock = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
  vi.doMock('node:child_process', () => ({ execFile: execFileMock }))
  // ... invoke with 2 clips, no preserveAudio, no perClipTrimSeconds ...
  const args: string[] = execFileMock.mock.calls[0][1]
  expect(args).toContain('-an')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/assembleClips.test.ts` (adjust path to the file found in Step 1)
Expected: FAIL on the 4-clip-id and `preserveAudio` assertions (schema still caps at 3, no such field exists).

- [ ] **Step 3: Implement the schema and filter-graph changes**

In `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts`, change the `inputSchema` (lines 39-45):

```ts
export const inputSchema = z.object({
  clipFileIds: z.array(z.string()).min(1).max(4),
  targetDurationSeconds: z.number().positive().optional().describe(
    'When set, the assembled video is trimmed (extra tail dropped) or the final frame held (tpad) to match this length — used to align this clip total to a separate audio track\'s length. Ignored when perClipTrimSeconds is set.'
  ),
  perClipTrimSeconds: z.array(z.number().positive()).optional().describe(
    'When set, must have exactly one entry per clipFileIds entry — each clip is individually trimmed/padded to its own duration BEFORE concatenation, instead of one shared targetDurationSeconds applied to the whole output. Used by animation-character, where each beat is already muxed to its own audio length.'
  ),
  preserveAudio: z.boolean().default(false).describe(
    'When true, concatenates with each input\'s audio stream preserved (v=1:a=1) instead of stripping all audio (-an). Every input must already carry an audio stream. Default false keeps talking-head/short-drama-stitch\'s existing silent-concat-then-lipsync behavior unchanged.'
  ),
  aspectRatio: z.enum(['16:9', '9:16']),
}).refine(
  (v) => v.perClipTrimSeconds === undefined || v.perClipTrimSeconds.length === v.clipFileIds.length,
  { message: 'perClipTrimSeconds, when set, must have exactly one entry per clipFileIds entry' },
)
```

Replace the destructure at the top of `execute` (line 55):

```ts
    const { clipFileIds, targetDurationSeconds, perClipTrimSeconds, preserveAudio, aspectRatio } = inputData as z.infer<typeof inputSchema>
```

Replace the ffmpeg filter-graph construction block (lines 122-153) with:

```ts
      // Normalizes every clip to CFR 30fps and a fixed aspect ratio. Audio
      // is stripped (-an) unless preserveAudio is set, matching talking-head/
      // short-drama-stitch's existing silent-concat-then-lipsync flow by
      // default.
      const [w, h] = aspectRatio === '9:16' ? ['1080', '1920'] : ['1920', '1080']

      // perClipTrimSeconds pads/truncates EACH clip individually via its own
      // tpad+trim stage before the shared concat — same tpad-then-truncate
      // trick assembleClips already uses for the single shared
      // targetDurationSeconds case (tpad pads BY the amount, trim -t
      // truncates TO it; both must stay present together or the padded
      // clip silently over-runs). When unset, falls back to this file's
      // existing single-target/no-target behavior, unchanged.
      const videoFilterParts = localPaths.map((_, i) => {
        const scaleChain = `fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`
        if (perClipTrimSeconds) {
          const clipTarget = perClipTrimSeconds[i]
          return `[${i}:v]${scaleChain},tpad=stop_mode=clone:stop_duration=${clipTarget},trim=duration=${clipTarget},setpts=PTS-STARTPTS[v${i}]`
        }
        return `[${i}:v]${scaleChain}[v${i}]`
      })

      const concatFlag = preserveAudio ? 'v=1:a=1' : 'v=1:a=0'
      const concatInputs = preserveAudio
        ? localPaths.map((_, i) => `[v${i}][${i}:a]`).join('')
        : localPaths.map((_, i) => `[v${i}]`).join('')

      const concatLabel = (!perClipTrimSeconds && targetDurationSeconds !== undefined) ? '[cat]' : preserveAudio ? '[outv][outa]' : '[outv]'
      let filterComplex = `${videoFilterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:${concatFlag}${concatLabel}`
      if (!perClipTrimSeconds && targetDurationSeconds !== undefined) {
        filterComplex += `; [cat]tpad=stop_mode=clone:stop_duration=${Math.max(0, targetDurationSeconds)}[outv]`
      }

      const args: string[] = ['-y']
      for (const p of localPaths) args.push('-i', p)
      args.push('-filter_complex', filterComplex, '-map', '[outv]')
      if (preserveAudio) args.push('-map', '[outa]')
      if (!perClipTrimSeconds && !preserveAudio) args.push('-an')
      if (!perClipTrimSeconds && targetDurationSeconds !== undefined) {
        args.push('-t', String(targetDurationSeconds))
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
      if (preserveAudio) args.push('-c:a', 'aac')
      args.push(outputPath)
```

Note: when `preserveAudio` is true, `concat=n=N:v=1:a=1` requires each `[v${i}]` to be immediately followed by its matching `[${i}:a]` in the concat input list — the `concatInputs` line above builds exactly that interleaving.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/assembleClips.test.ts`
Expected: PASS, including the two new schema tests and two new filter-graph tests.

- [ ] **Step 5: Live ffmpeg verification (mandatory per Global Constraints)**

Write a throwaway Node script (not committed) that generates 2 short silent test clips with `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -f lavfi -i sine=frequency=1000:duration=2 test1.mp4` (and a second with a different duration), then runs `assembleClips`'s actual constructed ffmpeg args (copy them from the implementation, do not re-derive) with `preserveAudio: true, perClipTrimSeconds: [1.5, 2.5]` against those two clips. Confirm the real `ffmpeg` binary accepts the filter graph (exit code 0) and the output file's audio duration (via `ffprobe -show_entries format=duration`) matches the sum of the two trim targets. Also run the `preserveAudio: false` (default) path against the same inputs and confirm it still produces a silent output — negative control proving the default path is unchanged.

Delete the throwaway script and test clips after confirming both cases pass; do not commit them.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/assembleClips.ts apps/agent-orchestrator/src/mastra/tools/__tests__/assembleClips.test.ts
git commit -m "feat(orchestrator): assemble_clips gains 4-clip cap, preserveAudio, perClipTrimSeconds"
```

---

### Task 4: `mux_beat_audio` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/muxBeatAudio.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/muxBeatAudioCredits.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/__tests__/muxBeatAudio.test.ts`

**Interfaces:**
- Consumes: `fetchPresignedUrl`/`downloadToSessionCache` from `mediaCache.ts` (Task 3's siblings), `shouldRequireApproval` from `generationApproval.ts`, `uploadGeneratedFile` from `persistence.js`.
- Produces: tool id `mux-beat-audio`, delegate key `mux_beat_audio`, raw exported `inputSchema = z.object({ videoFileId: z.string(), audioFileId: z.string() })`, output `{ fileId, name, fileType, size, refused, refusalReason, insufficientCredits, creditsUsedMicro, jobId }` — consumed by Task 9's `ANIMATION_CHARACTER_SECTION` for beats 2-4.

- [ ] **Step 1: Write the credits helper**

Create `apps/agent-orchestrator/src/mastra/tools/muxBeatAudioCredits.ts`, copying `assemblyCredits.ts`'s exact shape:

```ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

// Mirrors refundAssemblyCharge/refundVideoCharge/refundNarrationCharge/
// refundLipsyncCharge exactly — see refundVideoCharge's comments (in
// videoCredits.ts) for why the amount/expiry are always read back from the
// ledger rather than trusted from in-memory state.
export async function refundMuxBeatAudioCharge(
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
        `[credits] UNREFUNDED MUX-BEAT-AUDIO CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundMuxBeatAudioCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/__tests__/muxBeatAudio.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inputSchema } from '../muxBeatAudio.js'

describe('muxBeatAudio inputSchema', () => {
  it('requires videoFileId and audioFileId', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', audioFileId: 'a1' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1' })
    expect(missing.success).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/muxBeatAudio.test.ts`
Expected: FAIL — `Cannot find module '../muxBeatAudio.js'`.

- [ ] **Step 4: Implement the tool**

Create `apps/agent-orchestrator/src/mastra/tools/muxBeatAudio.ts`:

```ts
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
import { refundMuxBeatAudioCharge } from './muxBeatAudioCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const MUX_SUBJECT = 'ffmpeg-mux-audio'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// Matches the source spec's trim rule: each beat's clip is trimmed to its
// own narration length plus this much air, never the reverse.
const TRIM_PAD_SECONDS = 0.5

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw (not just wrapped in the tool) so a test can call .safeParse
// on it directly — see this plan's Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('A silent beat clip from generate_video.'),
  audioFileId: z.string().describe('That beat\'s narration line from generate_narration.'),
})

export const muxBeatAudio = createTool({
  id: 'mux-beat-audio',
  description: 'Muxes one narration audio line onto one silent beat clip, trimming the clip to the audio\'s length plus 0.5s. Used per-beat in animation-character for beats that carry VO rather than lip-synced dialogue — never for the hook beat, which uses lipsync instead.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: MUX_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, audioFileId } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string, audioPath: string
    try {
      const [videoUrl, audioUrl] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(audioFileId, idToken),
      ])
      ;[{ filePath: videoPath }, { filePath: audioPath }] = await Promise.all([
        downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES),
        downloadToSessionCache(scopeId, audioFileId, audioUrl, MAX_SOURCE_BYTES),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Charge BEFORE running ffmpeg — same settled ordering as every other
    // generation tool.
    const attempt = 0
    const chargeKey = `mux-beat-audio:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', MUX_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED MUX-BEAT-AUDIO: no active clip_assembly/${MUX_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'mux-beat-'))
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'MUX_FAILED', jobId }
    }
    const outputPath = join(workDir, 'muxed.mp4')
    try {
      const { stdout: durationOut } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const audioDurationSeconds = parseFloat(durationOut.trim())
      if (!(audioDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${durationOut}`)
      const targetSeconds = audioDurationSeconds + TRIM_PAD_SECONDS

      // Same tpad-then-truncate trick assembleClips.ts already validated
      // live: tpad pads BY targetSeconds (not TO it), so the trailing -t
      // is what truncates to the actual target — both must stay present.
      const filterComplex = `[0:v]fps=30,tpad=stop_mode=clone:stop_duration=${targetSeconds}[v]`
      await execFile('ffmpeg', [
        '-y', '-i', videoPath, '-i', audioPath,
        '-filter_complex', filterComplex,
        '-map', '[v]', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-t', String(targetSeconds), '-shortest',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MUX_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: failed to read output:`, (err as Error).message)
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MUX_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Beat with Audio', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/muxBeatAudio.test.ts`
Expected: PASS.

- [ ] **Step 6: Live ffmpeg verification**

Using the same `testsrc`/`sine` lavfi-generated throwaway clips as Task 3 Step 5, run the exact ffprobe+ffmpeg command sequence from `muxBeatAudio.ts`'s `execute` (copy the args verbatim) against a real silent video and a real short audio file. Confirm: (a) output duration equals audio duration + 0.5s within 0.1s tolerance, (b) output has both video and audio streams (`ffprobe -show_streams`). Delete the throwaway files after.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/muxBeatAudio.ts apps/agent-orchestrator/src/mastra/tools/muxBeatAudioCredits.ts apps/agent-orchestrator/src/mastra/tools/__tests__/muxBeatAudio.test.ts
git commit -m "feat(orchestrator): add mux_beat_audio tool"
```

---

### Task 5: `transcribe_audio` tool (orchestrator wrapper for Task 2's gateway route)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/transcribeAudio.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/transcribeAudioCredits.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/__tests__/transcribeAudio.test.ts`

**Interfaces:**
- Consumes: Task 2's `POST /v1/audio/transcribe`, `fetchPresignedUrl` from `mediaCache.ts`.
- Produces: tool id `transcribe-audio`, delegate key `transcribe_audio`, raw exported `inputSchema = z.object({ fileId: z.string(), mimeType: z.string() })`, output `{ text, words: [{word,startSeconds,endSeconds}], refused, refusalReason, insufficientCredits, creditsUsedMicro, jobId }` — `words` is consumed directly by Task 7's `burn_captions` and by the caption/brand-name verification step in `ANIMATION_CHARACTER_SECTION` (Task 9).

- [ ] **Step 1: Write the credits helper**

Create `apps/agent-orchestrator/src/mastra/tools/transcribeAudioCredits.ts`, mirroring `narrationCredits.ts`'s / `lipsyncCredits.ts`'s shape exactly (same structure as Task 4's `muxBeatAudioCredits.ts`, with `jobType: 'audio_transcription'`):

```ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

export async function refundTranscribeAudioCharge(
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
        actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'audio_transcription',
        grantType: 'refund', expiresAt,
      })
    } catch (err) {
      console.error(
        `[credits] UNREFUNDED TRANSCRIBE-AUDIO CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundTranscribeAudioCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/__tests__/transcribeAudio.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inputSchema } from '../transcribeAudio.js'

describe('transcribeAudio inputSchema', () => {
  it('requires fileId and mimeType', () => {
    const ok = inputSchema.safeParse({ fileId: 'f1', mimeType: 'video/mp4' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ fileId: 'f1' })
    expect(missing.success).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/transcribeAudio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the tool**

Create `apps/agent-orchestrator/src/mastra/tools/transcribeAudio.ts`:

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { fetchPresignedUrl } from './mediaCache.js'
import { refundTranscribeAudioCharge } from './transcribeAudioCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const TRANSCRIBE_SUBJECT = 'gemini-transcribe'

const outputSchema = z.object({
  text: z.string().optional(),
  words: z.array(z.object({
    word: z.string(),
    startSeconds: z.number(),
    endSeconds: z.number(),
  })).optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  fileId: z.string().describe('The voice-mixed master (video or audio) to transcribe with word-level timings.'),
  mimeType: z.string().describe('The source file\'s MIME type, e.g. video/mp4 or audio/wav.'),
})

export const transcribeAudio = createTool({
  id: 'transcribe-audio',
  description: 'Transcribes a video or audio file into text plus per-word start/end timings, via Gemini. Used to burn word-accurate captions and to verify brand names weren\'t garbled — distinct from analyze_audio, which returns a plain transcript with no word timings.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'audio_transcription', subject: TRANSCRIBE_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { fileId, mimeType } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    let fileUri: string
    try {
      fileUri = await fetchPresignedUrl(fileId, idToken)
    } catch (err) {
      console.error(`[session:${sessionId}] transcribeAudio: failed to resolve source file:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `transcribe-audio:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('audio_transcription', TRANSCRIBE_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED TRANSCRIBE-AUDIO: no active audio_transcription/${TRANSCRIBE_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'audio_transcription',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let genResult: { text?: string; words?: Array<{ word: string; startSeconds: number; endSeconds: number }>; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ fileUri, mimeType }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] transcribeAudio gateway call failed:`, (err as Error).message)
      if (charged) await refundTranscribeAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundTranscribeAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.text !== 'string' || !Array.isArray(genResult.words)) {
      console.error(`[session:${sessionId}] transcribeAudio: gateway returned a non-refused response with no text/words`)
      if (charged) await refundTranscribeAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    return {
      text: genResult.text,
      words: genResult.words,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/transcribeAudio.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/transcribeAudio.ts apps/agent-orchestrator/src/mastra/tools/transcribeAudioCredits.ts apps/agent-orchestrator/src/mastra/tools/__tests__/transcribeAudio.test.ts
git commit -m "feat(orchestrator): add transcribe_audio tool wrapping POST /v1/audio/transcribe"
```

---

### Task 6: `composite_end_card` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/compositeEndCardCredits.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/__tests__/compositeEndCard.test.ts`

**Interfaces:**
- Consumes: `fetchPresignedUrl`/`downloadToSessionCache`, `shouldRequireApproval`, `uploadGeneratedFile`.
- Produces: tool id `composite-end-card`, delegate key `composite_end_card`, raw exported `inputSchema = z.object({ videoFileId: z.string(), productPhotoFileId: z.string(), aspectRatio: z.enum(['16:9','9:16']) })`, same output shape as Task 4/5 — consumed by `ANIMATION_CHARACTER_SECTION` on beat 4's muxed clip, before assembly.

- [ ] **Step 1: Write the credits helper**

Create `apps/agent-orchestrator/src/mastra/tools/compositeEndCardCredits.ts`, same shape as Task 4's, with `jobType: 'clip_assembly'` (reuses the `clip_assembly` resourceType, `ffmpeg-composite-end-card` subject — see Task 1):

```ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

export async function refundCompositeEndCardCharge(
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
        `[credits] UNREFUNDED COMPOSITE-END-CARD CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundCompositeEndCardCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/__tests__/compositeEndCard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inputSchema } from '../compositeEndCard.js'

describe('compositeEndCard inputSchema', () => {
  it('requires videoFileId, productPhotoFileId, and aspectRatio', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '9:16' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1' })
    expect(missing.success).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/compositeEndCard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the tool**

Create `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts`:

```ts
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
import { refundCompositeEndCardCharge } from './compositeEndCardCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const COMPOSITE_SUBJECT = 'ffmpeg-composite-end-card'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// How long before the clip's own end the real photo dissolves in — a
// fixed value for v1 rather than scene-cut detection (the spec's
// pseudocode scene-detects the cut; this simplifies to "the last N
// seconds of the beat" which is safe because animation-character's beat
// 4 is always the payoff/CTA beat, always ends on a hold).
const DISSOLVE_WINDOW_SECONDS = 1.5
const DISSOLVE_DURATION_SECONDS = 0.4

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('Beat 4\'s muxed (audio-bearing) clip.'),
  productPhotoFileId: z.string().describe('The real, unedited product photo — never an AI-rendered one, to avoid wordmark garbling.'),
  aspectRatio: z.enum(['16:9', '9:16']),
})

export const compositeEndCard = createTool({
  id: 'composite-end-card',
  description: 'Overlays the real product photo onto the last beat\'s clip, dissolving in over its final second and a half — the end card is always composited from the real photo, never AI-rendered, to avoid wordmark/brand-name garbling. Run BEFORE assemble_clips, on beat 4 only.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: COMPOSITE_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, productPhotoFileId, aspectRatio } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string, photoPath: string
    try {
      const [videoUrl, photoUrl] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(productPhotoFileId, idToken),
      ])
      ;[{ filePath: videoPath }, { filePath: photoPath }] = await Promise.all([
        downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES),
        downloadToSessionCache(scopeId, productPhotoFileId, photoUrl, MAX_SOURCE_BYTES),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `composite-end-card:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', COMPOSITE_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED COMPOSITE-END-CARD: no active clip_assembly/${COMPOSITE_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'end-card-'))
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'COMPOSITE_FAILED', jobId }
    }
    const outputPath = join(workDir, 'carded.mp4')
    try {
      const { stdout: durationOut } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const clipDurationSeconds = parseFloat(durationOut.trim())
      if (!(clipDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${durationOut}`)
      const dissolveStart = Math.max(0, clipDurationSeconds - DISSOLVE_WINDOW_SECONDS)

      const [w, h] = aspectRatio === '9:16' ? ['1080', '1920'] : ['1920', '1080']
      const filterComplex =
        `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,format=rgba,` +
        `fade=t=in:st=${dissolveStart}:d=${DISSOLVE_DURATION_SECONDS}:alpha=1[card];` +
        `[0:v][card]overlay=(W-w)/2:(H-h)/2:enable='gte(t,${dissolveStart})'`

      await execFile('ffmpeg', [
        '-y', '-i', videoPath, '-i', photoPath,
        '-filter_complex', filterComplex,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'COMPOSITE_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: failed to read output:`, (err as Error).message)
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'COMPOSITE_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Beat with End Card', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/compositeEndCard.test.ts`
Expected: PASS.

- [ ] **Step 6: Live ffmpeg verification**

Generate a throwaway 3-second `testsrc` clip and a small solid-color PNG (e.g. `ffmpeg -f lavfi -i color=c=red:s=200x200:d=1 photo.png`), run `compositeEndCard.ts`'s exact ffprobe+ffmpeg args against them, confirm the output plays (exit 0) and that a frame pulled from the last 0.5s (`ffmpeg -ss <t> -i output.mp4 -frames:v 1 frame.png`) visibly differs from a frame pulled at t=0 (the overlay has not started yet) — a cheap way to confirm the `enable='gte(t,...)'` gate is actually gating. Delete throwaway files after.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCardCredits.ts apps/agent-orchestrator/src/mastra/tools/__tests__/compositeEndCard.test.ts
git commit -m "feat(orchestrator): add composite_end_card tool"
```

---

### Task 7: `burn_captions` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/burnCaptions.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/burnCaptionsCredits.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/__tests__/burnCaptions.test.ts`

**Interfaces:**
- Consumes: Task 5's `transcribe_audio` output shape (`words: [{word,startSeconds,endSeconds}]`) as this tool's own input.
- Produces: tool id `burn-captions`, delegate key `burn_captions`, raw exported `inputSchema = z.object({ videoFileId: z.string(), words: z.array(z.object({ word: z.string(), startSeconds: z.number(), endSeconds: z.number() })) })`, same output shape as prior tasks.

- [ ] **Step 1: Write the credits helper**

Create `apps/agent-orchestrator/src/mastra/tools/burnCaptionsCredits.ts`, same shape as Task 4's, `jobType: 'clip_assembly'`:

```ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

export async function refundBurnCaptionsCharge(
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
        `[credits] UNREFUNDED BURN-CAPTIONS CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundBurnCaptionsCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/__tests__/burnCaptions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inputSchema, groupWordsIntoPhrases, escapeDrawtext } from '../burnCaptions.js'

describe('burnCaptions inputSchema', () => {
  it('requires videoFileId and a non-empty words array', () => {
    const ok = inputSchema.safeParse({
      videoFileId: 'v1',
      words: [{ word: 'hi', startSeconds: 0, endSeconds: 0.3 }],
    })
    expect(ok.success).toBe(true)
    const empty = inputSchema.safeParse({ videoFileId: 'v1', words: [] })
    expect(empty.success).toBe(false)
  })
})

describe('groupWordsIntoPhrases', () => {
  it('groups words into phrases of up to 4, spanning first-word-start to last-word-end', () => {
    const words = [
      { word: 'the', startSeconds: 0.0, endSeconds: 0.2 },
      { word: 'quick', startSeconds: 0.2, endSeconds: 0.5 },
      { word: 'brown', startSeconds: 0.5, endSeconds: 0.8 },
      { word: 'fox', startSeconds: 0.8, endSeconds: 1.0 },
      { word: 'jumps', startSeconds: 1.1, endSeconds: 1.4 },
    ]
    const phrases = groupWordsIntoPhrases(words, 4)
    expect(phrases).toEqual([
      { text: 'the quick brown fox', startSeconds: 0.0, endSeconds: 1.0 },
      { text: 'jumps', startSeconds: 1.1, endSeconds: 1.4 },
    ])
  })
})

describe('escapeDrawtext', () => {
  it('escapes colons, single quotes, and backslashes for ffmpeg drawtext text=', () => {
    expect(escapeDrawtext("it's 3:30")).toBe("it\\'s 3\\:30")
    expect(escapeDrawtext('back\\slash')).toBe('back\\\\slash')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/burnCaptions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the tool**

Create `apps/agent-orchestrator/src/mastra/tools/burnCaptions.ts`:

```ts
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
import { refundBurnCaptionsCharge } from './burnCaptionsCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const CAPTIONS_SUBJECT = 'ffmpeg-burn-captions'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// Phrase-grouped, not word-by-word — matches the genre look the spec
// describes (novoads' "changing per phrase rather than per word").
const WORDS_PER_PHRASE = 4

export interface TranscribedWord {
  word: string
  startSeconds: number
  endSeconds: number
}

export interface CaptionPhrase {
  text: string
  startSeconds: number
  endSeconds: number
}

export function groupWordsIntoPhrases(words: TranscribedWord[], groupSize: number): CaptionPhrase[] {
  const phrases: CaptionPhrase[] = []
  for (let i = 0; i < words.length; i += groupSize) {
    const chunk = words.slice(i, i + groupSize)
    phrases.push({
      text: chunk.map((w) => w.word).join(' '),
      startSeconds: chunk[0].startSeconds,
      endSeconds: chunk[chunk.length - 1].endSeconds,
    })
  }
  return phrases
}

// ffmpeg drawtext's text= value treats backslash, single-quote, colon, and
// percent as special — escape order matters (backslash first, or the
// escapes added for the others get re-escaped).
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
}

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('The voice-mixed master to caption.'),
  words: z.array(z.object({
    word: z.string(),
    startSeconds: z.number(),
    endSeconds: z.number(),
  })).min(1).describe('Word-level timings from transcribe_audio — captions are burned from these, not from the original script.'),
})

export const burnCaptions = createTool({
  id: 'burn-captions',
  description: 'Burns phrase-grouped captions onto a video, timed from transcribe_audio\'s real word timings — never from the original script, since the render can drop or add a word. One fixed style: heavy sans-serif, white fill, dark outline, lower third.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: CAPTIONS_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, words } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string
    try {
      const videoUrl = await fetchPresignedUrl(videoFileId, idToken)
      ;({ filePath: videoPath } = await downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES))
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: failed to download source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `burn-captions:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', CAPTIONS_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED BURN-CAPTIONS: no active clip_assembly/${CAPTIONS_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'captions-'))
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'CAPTION_FAILED', jobId }
    }
    const outputPath = join(workDir, 'captioned.mp4')
    try {
      const phrases = groupWordsIntoPhrases(words, WORDS_PER_PHRASE)
      // Lower-third band, white fill, thick dark outline — matches the
      // genre look novoads' caption presets describe. h*0.78 keeps the
      // band clear of most safe-area UI overlays at any resolution.
      const drawtextFilters = phrases.map((p) =>
        `drawtext=text='${escapeDrawtext(p.text)}':fontcolor=white:fontsize=h*0.055:` +
        `borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.78:` +
        `enable='between(t,${p.startSeconds},${p.endSeconds})'`
      )
      await execFile('ffmpeg', [
        '-y', '-i', videoPath,
        '-vf', drawtextFilters.join(','),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'CAPTION_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: failed to read output:`, (err as Error).message)
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'CAPTION_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Captioned Video', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/burnCaptions.test.ts`
Expected: PASS.

- [ ] **Step 6: Live ffmpeg verification**

Generate a throwaway 3-second `testsrc` clip, run `burnCaptions.ts`'s exact `-vf` drawtext chain against it with 2-3 short test phrases, confirm ffmpeg exits 0 and that frames pulled at each phrase's `startSeconds`/`endSeconds` midpoint visibly show the burned text (spot-check by reading a frame at, e.g., 0.5s into a phrase whose window covers it). Delete throwaway files after.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/burnCaptions.ts apps/agent-orchestrator/src/mastra/tools/burnCaptionsCredits.ts apps/agent-orchestrator/src/mastra/tools/__tests__/burnCaptions.test.ts
git commit -m "feat(orchestrator): add burn_captions tool"
```

---

### Task 8: `mix_music_bed` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/mixMusicBed.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/mixMusicBedCredits.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/__tests__/mixMusicBed.test.ts`

**Interfaces:**
- Consumes: `generate_song`'s output fileId (existing skill 1 tool, unchanged).
- Produces: tool id `mix-music-bed`, delegate key `mix_music_bed`, raw exported `inputSchema = z.object({ videoFileId: z.string(), musicFileId: z.string() })`, output adds `loudnessIntegratedLufs: z.number().optional()` alongside the standard fields — consumed only for logging/QA, applied LAST in `ANIMATION_CHARACTER_SECTION`'s pipeline, after captions.

- [ ] **Step 1: Write the credits helper**

Create `apps/agent-orchestrator/src/mastra/tools/mixMusicBedCredits.ts`, same shape as Task 4's, `jobType: 'clip_assembly'`:

```ts
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

export async function refundMixMusicBedCharge(
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
        `[credits] UNREFUNDED MIX-MUSIC-BED CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundMixMusicBedCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/agent-orchestrator/src/mastra/tools/__tests__/mixMusicBed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inputSchema, parseIntegratedLoudness } from '../mixMusicBed.js'

describe('mixMusicBed inputSchema', () => {
  it('requires videoFileId and musicFileId', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', musicFileId: 'm1' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1' })
    expect(missing.success).toBe(false)
  })
})

describe('parseIntegratedLoudness', () => {
  it('extracts the Integrated LUFS value from ebur128 stderr output', () => {
    const stderr = [
      '[Parsed_ebur128_0 @ 0x1] t: 3.0 TARGET:-23 M:-27.3 S:-27.1 I: -26.4 LUFS',
      'Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -26.4 LUFS',
      '    Threshold: -36.5 LUFS',
    ].join('\n')
    expect(parseIntegratedLoudness(stderr)).toBe(-26.4)
  })

  it('returns null when no Integrated loudness line is present', () => {
    expect(parseIntegratedLoudness('garbage output with no match')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/mixMusicBed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the tool**

Create `apps/agent-orchestrator/src/mastra/tools/mixMusicBed.ts`:

```ts
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
import { refundMixMusicBedCharge } from './mixMusicBedCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const MIX_SUBJECT = 'ffmpeg-mix-music-bed'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// Bed sits well under the voice — matches the spec's "ducked under the
// voice" requirement; refined from novoads' own measured failure of a
// flat 0.10 multiplier landing at -33 to -40 dB (inaudible).
const BED_VOLUME = 0.18
// Below this, treat the mixed bed as effectively inaudible and refuse
// rather than ship it — same "measure, don't guess" discipline the spec
// calls out from novoads' music_mix.py.
const MIN_ACCEPTABLE_INTEGRATED_LUFS = -30

export function parseIntegratedLoudness(stderr: string): number | null {
  const match = stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/)
  return match ? parseFloat(match[1]) : null
}

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  loudnessIntegratedLufs: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('The captioned master — already has the mixed voice track. Music is applied LAST, after captions.'),
  musicFileId: z.string().describe('The music bed from generate_song.'),
})

export const mixMusicBed = createTool({
  id: 'mix-music-bed',
  description: 'Ducks a music bed under the existing voice track, masters the mix, and refuses to finalize a bed measured too quiet to hear rather than shipping one nobody would notice. Applied LAST in animation-character\'s pipeline, after captions are burned — never before.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: MIX_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, musicFileId } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string, musicPath: string
    try {
      const [videoUrl, musicUrl] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(musicFileId, idToken),
      ])
      ;[{ filePath: videoPath }, { filePath: musicPath }] = await Promise.all([
        downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES),
        downloadToSessionCache(scopeId, musicFileId, musicUrl, MAX_SOURCE_BYTES),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `mix-music-bed:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', MIX_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED MIX-MUSIC-BED: no active clip_assembly/${MIX_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'music-bed-'))
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }
    const outputPath = join(workDir, 'mixed.mp4')
    let integratedLufs: number | null = null
    try {
      const { stdout: durationOut } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const videoDurationSeconds = parseFloat(durationOut.trim())
      if (!(videoDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${durationOut}`)

      const filterComplex =
        `[1:a]volume=${BED_VOLUME}[bed];` +
        `[0:a][bed]amix=inputs=2:duration=longest:normalize=0[premaster];` +
        `[premaster]loudnorm=I=-14:TP=-1.5:LRA=11[outa]`
      await execFile('ffmpeg', [
        '-y', '-i', videoPath, '-i', musicPath,
        '-filter_complex', filterComplex,
        '-map', '0:v', '-map', '[outa]',
        '-c:v', 'copy', '-c:a', 'aac',
        '-t', String(videoDurationSeconds),
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })

      // Verification pass: measure the mastered output's integrated
      // loudness and refuse rather than ship a bed nobody would hear —
      // novoads' own documented failure mode ("-33 to -40 dB, a bed paid
      // for and never heard").
      const { stderr: loudnessStderr } = await execFile('ffmpeg', [
        '-i', outputPath, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-',
      ], { timeout: FFMPEG_TIMEOUT_MS })
      integratedLufs = parseIntegratedLoudness(loudnessStderr)
      if (integratedLufs === null || integratedLufs < MIN_ACCEPTABLE_INTEGRATED_LUFS) {
        console.error(`[session:${sessionId}] mixMusicBed: measured loudness ${integratedLufs} LUFS is below the ${MIN_ACCEPTABLE_INTEGRATED_LUFS} LUFS floor — refusing rather than shipping an inaudible bed`)
        if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
        rmSync(workDir, { recursive: true, force: true })
        return { refused: true, refusalReason: 'MUSIC_BED_INAUDIBLE', jobId }
      }
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: failed to read output:`, (err as Error).message)
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Final Video', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      loudnessIntegratedLufs: integratedLufs ?? undefined,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/mixMusicBed.test.ts`
Expected: PASS.

- [ ] **Step 6: Live ffmpeg verification**

Generate a throwaway silent `testsrc` clip with a 440Hz sine "voice" track and a separate 220Hz sine "music" track (via `-f lavfi -i sine=frequency=...`), run `mixMusicBed.ts`'s exact filter_complex + loudnorm + ebur128 sequence against them, confirm: (a) the output has both frequencies present (spot-check via `ffprobe`/a quick spectral read is optional — confirming non-silent audio via `volumedetect` is sufficient), (b) `parseIntegratedLoudness` correctly extracts a number from the real ffmpeg stderr output (not just the hand-written test fixture in Step 2 — run the actual command and feed its real stderr through the function). Also run a negative control: mix at `volume=0.001` and confirm the tool's refusal path actually triggers (`MUSIC_BED_INAUDIBLE`). Delete throwaway files after.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/mixMusicBed.ts apps/agent-orchestrator/src/mastra/tools/mixMusicBedCredits.ts apps/agent-orchestrator/src/mastra/tools/__tests__/mixMusicBed.test.ts
git commit -m "feat(orchestrator): add mix_music_bed tool"
```

---

### Task 9: Approval-gate registration + `lipsync.ts` description edit

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/lipsync.ts:39`
- Modify: `apps/agent-orchestrator/src/mastra/tools/__tests__/generationApproval.test.ts` (locate the existing test file; extend it)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GENERATION_APPROVAL_METADATA` entries for all five Task 4-8 tools (both hyphenated and underscored forms each) — required before Task 10 wires any of these tools into `directorAgent`, since an unregistered tool crashes approval-resume.

- [ ] **Step 1: Write the failing test**

Find the existing `generationApproval.test.ts` (or equivalent) and add:

```ts
it('registers both hyphenated and underscored forms for every animation-character tool', () => {
  const pairs: [string, string][] = [
    ['mux-beat-audio', 'mux_beat_audio'],
    ['transcribe-audio', 'transcribe_audio'],
    ['composite-end-card', 'composite_end_card'],
    ['burn-captions', 'burn_captions'],
    ['mix-music-bed', 'mix_music_bed'],
  ]
  for (const [hyphenated, underscored] of pairs) {
    expect(GENERATION_APPROVAL_METADATA[hyphenated]).toBeDefined()
    expect(GENERATION_APPROVAL_METADATA[underscored]).toBeDefined()
    expect(GENERATION_APPROVAL_METADATA[hyphenated]).toEqual(GENERATION_APPROVAL_METADATA[underscored])
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/generationApproval.test.ts`
Expected: FAIL — all five entries `undefined`.

- [ ] **Step 3: Add the entries**

In `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts`, add new subject constants near `ASSEMBLY_SUBJECT` (line 61):

```ts
const MUX_BEAT_AUDIO_SUBJECT = 'ffmpeg-mux-audio'
const TRANSCRIBE_SUBJECT = 'gemini-transcribe'
const COMPOSITE_END_CARD_SUBJECT = 'ffmpeg-composite-end-card'
const BURN_CAPTIONS_SUBJECT = 'ffmpeg-burn-captions'
const MIX_MUSIC_BED_SUBJECT = 'ffmpeg-mix-music-bed'
```

Add the metadata objects near `assemblyGen` (line 86):

```ts
const muxBeatAudioGen = { resourceType: 'clip_assembly', subject: MUX_BEAT_AUDIO_SUBJECT, label: 'Mux beat audio' }
const transcribeAudioGen = { resourceType: 'audio_transcription', subject: TRANSCRIBE_SUBJECT, label: 'Transcribe audio' }
const compositeEndCardGen = { resourceType: 'clip_assembly', subject: COMPOSITE_END_CARD_SUBJECT, label: 'Composite end card' }
const burnCaptionsGen = { resourceType: 'clip_assembly', subject: BURN_CAPTIONS_SUBJECT, label: 'Burn captions' }
const mixMusicBedGen = { resourceType: 'clip_assembly', subject: MIX_MUSIC_BED_SUBJECT, label: 'Mix music bed' }
```

Add the ten entries into `GENERATION_APPROVAL_METADATA` (after the `'assemble_clips': assemblyGen,` line, before `'save_skill'`):

```ts
  'mux-beat-audio': muxBeatAudioGen,
  'mux_beat_audio': muxBeatAudioGen,
  'transcribe-audio': transcribeAudioGen,
  'transcribe_audio': transcribeAudioGen,
  'composite-end-card': compositeEndCardGen,
  'composite_end_card': compositeEndCardGen,
  'burn-captions': burnCaptionsGen,
  'burn_captions': burnCaptionsGen,
  'mix-music-bed': mixMusicBedGen,
  'mix_music_bed': mixMusicBedGen,
```

- [ ] **Step 4: Edit `lipsync.ts`'s description**

In `apps/agent-orchestrator/src/mastra/tools/lipsync.ts` line 39, replace:

```ts
  description: 'Matches a silent video\'s mouth motion to a separate audio track. Use once, on the fully assembled silent video, against the full narration track — never per-clip.',
```

with:

```ts
  description: 'Matches a silent video\'s mouth motion to a separate audio track. For talking-head, use once on the fully assembled silent video against the full narration track — never per-clip. For animation-character, use on exactly one beat clip (the hook beat) against that beat\'s single narration line — never on more than one beat in the same ad.',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/generationApproval.test.ts`
Expected: PASS.

Run: `cd apps/agent-orchestrator && pnpm vitest run` (full suite)
Expected: PASS, no regressions from the `lipsync.ts` description change (no test asserts the old string verbatim — if one does, update it to match).

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generationApproval.ts apps/agent-orchestrator/src/mastra/tools/lipsync.ts apps/agent-orchestrator/src/mastra/tools/__tests__/generationApproval.test.ts
git commit -m "feat(orchestrator): register animation-character tools in GENERATION_APPROVAL_METADATA"
```

---

### Task 10: `directorAgent.ts` — `ANIMATION_CHARACTER_SECTION`, style-lock templates, tool wiring

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`

**Interfaces:**
- Consumes: `mux_beat_audio` (Task 4), `transcribe_audio` (Task 5), `composite_end_card` (Task 6), `burn_captions` (Task 7), `mix_music_bed` (Task 8), plus existing `generate_image`, `generate_video`, `generate_narration`, `lipsync`, `assemble_clips`, `generate_song`.
- Produces: `ANIMATION_CHARACTER_SECTION` text appended to `directorAgent`/`directorAgentDelegate`'s instructions; both agents' `tools:` maps gain the five new underscored keys.

- [ ] **Step 1: Add the five new tool imports**

Near the existing imports (`import { lipsync } from '../tools/lipsync.js'` etc.), add:

```ts
import { muxBeatAudio } from '../tools/muxBeatAudio.js'
import { transcribeAudio } from '../tools/transcribeAudio.js'
import { compositeEndCard } from '../tools/compositeEndCard.js'
import { burnCaptions } from '../tools/burnCaptions.js'
import { mixMusicBed } from '../tools/mixMusicBed.js'
```

- [ ] **Step 2: Write the `ANIMATION_CHARACTER_SECTION` constant**

Add this constant right after the existing `TALKING_HEAD_SECTION` constant (immediately before `const base = ...`):

```ts
  const ANIMATION_CHARACTER_SECTION = `\n\n## Animation-character generation — 4-beat stylized story arc
When Olmo delegates an animation-character ad build (stylized/animated story-driven ad, fixed 4 beats, one of three styles):

Style-lock templates — Olmo will tell you which of these three styles was chosen. Paste the matching block verbatim, character for character, into every still and clip prompt for this ad, alongside the terseTag Olmo gives you:

STYLE "3d_pixar":
Stylized 3D animated feature film look. Soft volumetric golden-hour lighting from a large window, warm cosy palette of cream, butter yellow, dusty pink and soft sage. Subsurface scattering on skin, painterly background, shallow depth of field with creamy bokeh. Characters have large expressive eyes with multiple specular catchlights, stylized but believable proportions, smooth simplified hands, soft hair strands with subsurface glow. Every character reads mid-emotion, caught a moment before a smile or a sigh, never blank-staring. Vertical 9:16 composition.
NEGATIVE: no live-action footage, no photorealistic humans, no uncanny faces, no dead eyes, no anime style, no 2D cel-shaded look, no flat illustration, no named or copyrighted animated film characters, no harsh fluorescent lighting, no extra fingers, no melted features, no morphing between frames, no warped product labels, no on-screen text, no subtitles, no captions.

STYLE "2d_flat":
Flat 2D vector illustration look. Bold simplified shapes, solid flat color fills with no gradients, clean geometric character design, limited 5-6 color palette per scene, thick uniform outline weight, minimal shading via flat color blocks only. Characters have simplified geometric proportions, expressive but minimal facial features (dot eyes, simple curved mouths), confident graphic-design-poster energy. Vertical 9:16 composition.
NEGATIVE: no photorealistic rendering, no 3D shading or depth, no gradients, no photorealistic humans, no anime style, no named or copyrighted animated film characters, no textured/painterly background, no on-screen text, no subtitles, no captions.

STYLE "claymation":
Stop-motion claymation look. Visible clay/plasticine texture on every surface with soft matte finish, subtle fingerprint and tool-mark imperfections in the material, warm practical studio lighting with visible soft shadows, handmade set-built environments with visible seams and physical props. Characters have slightly asymmetric hand-sculpted proportions, small subtle per-frame jitter/wobble implied in the texture description (not literal motion — the LOOK of stop-motion). Vertical 9:16 composition.
NEGATIVE: no smooth CGI rendering, no photorealistic humans, no 2D flat illustration, no anime style, no named or copyrighted animated film characters, no glossy/plastic sheen, no on-screen text, no subtitles, no captions.

- Gate 0 (before any generation): only proceed if the product's pain point is emotional/relational (not a spec/feature pitch), visible on a face or a mechanism, involves a relationship or another character (not just the buyer alone), and is impulse-priced. If the product fails this filter, tell Olmo plainly rather than building a charming ad for a product that needs a demo.
- Cast sheet: one generate_image call, referenceFileIds set to the product photo's fileId if one exists, identityAnchor set with the terseTag/styleLock Olmo gives you (styleLock is the matching STYLE block above, verbatim). The prompt must show the lead character in 2-3 emotional states, the product in 2-3 views, and a scale line-up — this single image is what keeps all 4 beats looking like the same character.
- 4 beat stills: generate_image per beat, referenceFileIds set to [cast sheet fileId, previous beat's still fileId] (the cast sheet plus the PREVIOUS still, not just the cast sheet alone — chaining only off the cast sheet is how the character visibly changes between beats), identityAnchor set with the same terseTag/styleLock. Beat 1 is the hook (the character states its want/problem, framed for a close-up since it will be lip-synced). Beat 2 is the low point (the shortest, most private moment). Beat 3 is the turn (the product arrives and is used — Doctrine C only: the product is recreated in-style exactly as the reference shows it, same shape/colour/proportions/finish, never redesigned). Beat 4 is the payoff (warmth, then the CTA framing that will receive the end card).
- BOARD GATE: once the cast sheet and all 4 beat stills exist, show all 5 images together and wait for one approval covering the whole set — never approve stills one at a time, the operator is judging beat-to-beat continuity. Only board-approved stills proceed to video.
- 4 silent beat clips: generate_video, mode "animate_frame", off each approved still, one call per beat. Do not pass approvedDialogue and do not write quoted dialogue into any of these prompts — every beat's speech is added afterward (lip-sync for beat 1, VO mux for beats 2-4), never native to the render.
- Beat 1 (hook) audio: generate_narration with the hook's one short line and the user's chosen voiceId, then lipsync with videoFileId set to beat 1's clip and audioFileId set to that narration's fileId. This is the ONE beat in this ad that gets lip-sync — do not call lipsync again for any other beat.
- Beats 2-4 audio: generate_narration with each beat's one VO line (same voiceId as beat 1, for one continuous voice across the ad), then mux_beat_audio with videoFileId set to that beat's silent clip and audioFileId set to that VO line's fileId.
- End card: after beat 4's audio is muxed, call composite_end_card with videoFileId set to beat 4's muxed clip, productPhotoFileId set to the real product photo's fileId (never an AI-generated one), and the ad's aspectRatio. This must run BEFORE assembly.
- Assembly: call assemble_clips ONCE with clipFileIds set to [beat 1's lip-synced clip, beat 2's muxed clip, beat 3's muxed clip, beat 4's carded clip] in that exact order, preserveAudio set to true, and aspectRatio matching the per-clip renders. Do not set targetDurationSeconds or perClipTrimSeconds here — every clip is already individually trimmed by lipsync/mux_beat_audio/composite_end_card.
- Transcription: call transcribe_audio on the assembled master's fileId and mimeType "video/mp4".
- Captions: call burn_captions with videoFileId set to the assembled master's fileId and words set to exactly what transcribe_audio returned.
- Brand-name check: compare transcribe_audio's text against the script's brand/product name and any spoken price. If either was garbled, tell Olmo plainly rather than presenting a broken caption as finished — the fix is to re-run transcribe_audio/burn_captions, or (Olmo's call) keep the brand name off narration entirely and rely on the end card, per the spec's preferred fix.
- Music: call generate_song for the bed, then mix_music_bed with videoFileId set to the CAPTIONED master (not the pre-caption one) and musicFileId set to the bed. This is the LAST call in the pipeline — never generate or mix the bed earlier.
- If mix_music_bed returns refusalReason "MUSIC_BED_INAUDIBLE", tell Olmo the bed could not be mixed audibly and ask whether to retry generate_song for a different bed or deliver without one.`

  const base = (override || defaultInstructions) + TEMPLATE_CLONING_SECTION + UGC_CHARACTER_SECTION + MOTION_CRAFT_SECTION + TALKING_HEAD_SECTION + ANIMATION_CHARACTER_SECTION
```

Note: this replaces the existing `const base = (override || defaultInstructions) + TEMPLATE_CLONING_SECTION + UGC_CHARACTER_SECTION + MOTION_CRAFT_SECTION + TALKING_HEAD_SECTION` line — append `+ ANIMATION_CHARACTER_SECTION` to it, do not duplicate the line.

- [ ] **Step 3: Wire the five new tools into both `tools:` maps**

Find the two `tools: { generate_image: generateImage, ... assemble_clips: assembleClips },` lines (one on `directorAgent`, one on `directorAgentDelegate`) and add the five new entries to both:

```ts
  tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo, retrieve_template: retrieveTemplate, analyze_video: analyzeVideoTool, analyze_audio: analyzeAudioTool, analyze_image: analyzeImageTool, generate_narration: generateNarration, lipsync: lipsync, assemble_clips: assembleClips, mux_beat_audio: muxBeatAudio, transcribe_audio: transcribeAudio, composite_end_card: compositeEndCard, burn_captions: burnCaptions, mix_music_bed: mixMusicBed },
```

- [ ] **Step 4: Run the director agent tests**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: the two EXISTING tests still pass unchanged (this task doesn't touch their assertions yet — Task 12 adds new ones).

- [ ] **Step 5: Type-check**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): wire animation-character tools + section into directorAgent"
```

---

### Task 11: `platformAgent.ts` — `ANIMATION_CHARACTER_CONTRACT`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`

**Interfaces:**
- Consumes: nothing new — this is Olmo-facing prose, mirroring `TALKING_HEAD_CONTRACT`'s and `UGC_CHARACTER_CONTRACT`'s pattern.
- Produces: `ANIMATION_CHARACTER_CONTRACT` concatenated into the final `return composed + ...` line, and a routing-disambiguation clause added to `UGC_CHARACTER_CONTRACT`'s and `TALKING_HEAD_CONTRACT`'s own trigger lines so all three storyboard-shaped contracts stay mutually exclusive.

- [ ] **Step 1: Add a routing clause to the two existing contracts**

In `UGC_CHARACTER_CONTRACT`'s opening line (currently: `When the user wants a UGC-style ad built from scratch (no template to clone), with MULTIPLE distinct beats/shots in a storyboard — if the user instead wants a SINGLE continuous presenter speaking to camera for one continuous script, use the Talking-head ad contract below instead, not this one:`), append a clause naming the new contract:

```
When the user wants a UGC-style ad built from scratch (no template to clone), with MULTIPLE distinct beats/shots in a storyboard, PHOTOREAL not stylized — if the user instead wants a SINGLE continuous presenter speaking to camera for one continuous script, use the Talking-head ad contract below instead; if the user wants a STYLIZED/animated/cartoon-look story ad, use the Animation-character ad contract below instead — not this one:
```

In `TALKING_HEAD_CONTRACT`'s opening line, append a similar clause after "Signals: ...":

```
This contract applies when the user wants a SINGLE continuous PHOTOREAL presenter/spokesperson speaking to camera for one continuous script — not a multi-beat storyboard with distinct shots (that's the UGC character ad contract above), and not a stylized/animated look (that's the Animation-character ad contract below). Signals: "talking head", "presenter video", "spokesperson ad", "someone reading this script to camera".
```

- [ ] **Step 2: Write `ANIMATION_CHARACTER_CONTRACT`**

Add this constant immediately after `TALKING_HEAD_CONTRACT`'s closing backtick, before `THINKING_STYLE_CONTRACT`:

```ts
    const ANIMATION_CHARACTER_CONTRACT = `\n\n## Animation-character ad — style pick, board gate, delivery
This contract applies when the user wants a stylized/animated/cartoon-look story ad — a 3D-animated, flat-illustration, or claymation-style short film selling a product across a 4-beat arc, NOT a photoreal ad (that's the UGC character or Talking-head contracts above). Signals: "animated ad", "cartoon ad", "Pixar-style ad", "stylized character ad", "claymation ad".
1. Intake: get a product photo (required — Doctrine C recreates it in-style, the real photo is only used for the end card and Gate 0's fit check). Ask which of exactly three styles the user wants: 3D animated (Pixar-like, warm and expressive), 2D flat/vector illustration (bold flat colors, simple shapes), or claymation (stop-motion clay look). If the user doesn't know, briefly describe all three and let them pick — never assume one.
2. Gate 0 fit check: before any cost estimate, tell the user plainly if the product doesn't fit this style — this format needs an emotional/relational pain point visible on a face, not a technical spec pitch. If it doesn't fit, say so and suggest a different skill (UGC character or talking-head) instead of building a charming ad for a product that needs a demo.
3. Tell the user plainly, before delegating: this flow involves roughly 12-14 separate cost confirmations across the cast sheet, 4 beat stills, 4 silent clips, narration/VO calls, lip-sync, muxing, end-card compositing, assembly, transcription, captions, and the music mix — there is no single approval that covers the whole flow.
4. Delegate to agent-director to generate the cast sheet (same pattern as the UGC character contract's step 3 — derive a terseTag and a matching STYLE block's styleLock from the chosen style). Write the cast sheet's fileId and the chosen style into working memory's Locked Reference Artifact IDs field.
5. Delegate to agent-director to generate each of the 4 beat stills, per its fixed beat-role rules (hook/low-point/turn/payoff).
6. Board gate: once the cast sheet and all 4 beat stills exist, present them together and ask the user to approve the set as a whole for continuity — not each one individually. Only board-approved stills proceed to video. If the user rejects a still, regenerating it is a new paid call and needs its own fresh approval.
7. Delegate to agent-director to render each approved still into a silent clip, generate the hook beat's narration and lip-sync it, generate beats 2-4's VO lines and mux each, composite the end card onto beat 4, assemble all 4 clips with audio preserved, transcribe the result, burn captions, generate the music bed, and mix it in last.
8. If transcribe_audio's brand-name check flags a mismatch, tell the user plainly and ask whether to retry the transcription/caption step or keep the brand name off narration and rely on the end card only.
9. Delivery: present the final captioned, scored video as ONE continuous 4-beat story ad. Tell the user plainly that this character exists only in this conversation — it isn't saved to a reusable library, same as the UGC character contract's own characters.`
```

- [ ] **Step 3: Splice it into the final return statement**

In the final `return composed + ...` line (currently ending `... + UGC_CHARACTER_CONTRACT + TALKING_HEAD_CONTRACT + THINKING_STYLE_CONTRACT + invokedSkillsInstruction(invokedThisTurn)`), insert the new contract between `TALKING_HEAD_CONTRACT` and `THINKING_STYLE_CONTRACT`:

```ts
    return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT
      + DELEGATION_CONTRACT + ROUTING_CONTRACT + COST_CONFIRMATION_CONTRACT + TEMPLATE_VIDEO_CONTRACT + UGC_CHARACTER_CONTRACT + TALKING_HEAD_CONTRACT + ANIMATION_CHARACTER_CONTRACT + THINKING_STYLE_CONTRACT + invokedSkillsInstruction(invokedThisTurn)
```

- [ ] **Step 4: Run the platform agent tests**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/agents/__tests__/platformAgent.test.ts` (locate the exact test file name if it differs)
Expected: PASS, no regressions from the two routing-clause edits (if an existing test asserts the OLD exact trigger-line text of `UGC_CHARACTER_CONTRACT`/`TALKING_HEAD_CONTRACT`, update that assertion to the new text rather than reverting the edit).

- [ ] **Step 5: Type-check**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(orchestrator): add ANIMATION_CHARACTER_CONTRACT to platformAgent, disambiguate routing"
```

---

### Task 12: `directorAgent.test.ts` — tool registration + section content assertions

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts`

**Interfaces:**
- Consumes: `directorAgent`/`directorAgentDelegate` from Task 10.
- Produces: no new production code — this task closes out the plan's testing coverage for the section text and tool wiring.

- [ ] **Step 1: Write the new tests**

Add to the existing `describe('directorAgent tool registration', ...)` block:

```ts
  it('has mux_beat_audio, transcribe_audio, composite_end_card, burn_captions, and mix_music_bed registered, needed for animation-character', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    const expected = ['mux_beat_audio', 'transcribe_audio', 'composite_end_card', 'burn_captions', 'mix_music_bed']
    expect(Object.keys(directorTools)).toEqual(expect.arrayContaining(expected))
    expect(Object.keys(delegateTools)).toEqual(expect.arrayContaining(expected))
  })
```

Add a new `describe` block for the section content:

```ts
describe('directorAgent animation-character instructions', () => {
  it('appends the animation-character section with all three style-lock templates', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('## Animation-character generation')
    expect(text).toContain('STYLE "3d_pixar"')
    expect(text).toContain('STYLE "2d_flat"')
    expect(text).toContain('STYLE "claymation"')
  })

  it('never calls lipsync more than once and confines it to the hook beat', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## Animation-character generation')
    const section = text.slice(sectionStart)
    expect(section).toContain('This is the ONE beat in this ad that gets lip-sync')
  })

  it('places mix_music_bed after burn_captions in the section text (music bed is last, never before captions)', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const sectionStart = text.indexOf('## Animation-character generation')
    const section = text.slice(sectionStart)
    const captionsIdx = section.indexOf('Captions: call burn_captions')
    const musicIdx = section.indexOf('Music: call generate_song')
    expect(captionsIdx).toBeGreaterThanOrEqual(0)
    expect(musicIdx).toBeGreaterThan(captionsIdx)
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/agents/__tests__/directorAgent.test.ts`
Expected: PASS, all tests (existing + new) green.

- [ ] **Step 3: Run the full orchestrator + gateway suites**

Run: `cd apps/agent-orchestrator && pnpm type-check && pnpm vitest run`
Run: `cd apps/inference-gateway && pnpm type-check && pnpm vitest run`
Expected: both PASS, zero regressions across the whole plan's changes.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts
git commit -m "test(orchestrator): cover animation-character section content and tool wiring"
```

---

## Self-review notes (per writing-plans skill)

**Spec coverage:** every spec section has a task — Task 1 (schema/seed), Task 2 (gateway route), Task 3 (assemble_clips changes), Tasks 4/6/7/8 (the four new ffmpeg tools), Task 5 (transcribe_audio), Task 9 (approval registration + lipsync description), Tasks 10-11 (directorAgent/platformAgent wiring), Task 12 (tests). The spec's fixed pipeline order (composite end card before assembly, music bed after captions) is encoded directly in `ANIMATION_CHARACTER_SECTION`'s step ordering and asserted by Task 12's ordering test.

**Placeholder scan:** no TBD/TODO; every ffmpeg command, every credits-helper file, and both style-lock/contract text blocks are written out in full, not described.

**Type consistency:** `mux_beat_audio`'s `videoFileId`/`audioFileId` naming matches `lipsync.ts`'s existing field names for the same concepts; `transcribe_audio`'s `words: [{word,startSeconds,endSeconds}]` output shape matches Task 2's gateway response shape and Task 7's `burn_captions` input shape exactly (checked field-for-field across Tasks 2, 5, and 7); `composite_end_card` and `assemble_clips` both take `aspectRatio: z.enum(['16:9','9:16'])`, matching `generateVideo.ts`'s existing enum values.

## Execution

**Subagent-Driven (recommended)** — fresh subagent per task, task review (spec + quality) after each, one whole-branch review at the end on the most capable model, matching skill 4's process exactly (worktree, Opus reviews, fix loops).

**Inline Execution** — batch execution in this session with checkpoints.

# Social video clone — Phase 3b: clips, joining, music, final checks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the user approves the free preview, the `video-remake` workflow animates every look with checked clips, joins them frame-exact at 30fps, adds new music in the reference's mood, runs the final checks against the reference, and delivers the remake with a plain "what differs" note and the full cost meter.

**Architecture:** 3a's workflow gains a pause at the preview (`preview_review`) and three steps: `clips` (per look: a Veo 3.1 first+last clip when the look has an end still, otherwise an Omni clip from the start still; prompt gate → generate → trim to exact frames → measured checks → one retry), `finish` (join, music, final checks, upload). The inference gateway gains a real Veo 3.1 backend (first+last frame, inline images, `fetchPredictOperation` polling) for an explicit model id; there is no silent cross-model fallback inside the gateway. The orchestrator's clip code chooses Omni only when Veo refuses (spec rule 11). Every paid call goes through the same money rules as 3a.

**Tech Stack:** Mastra 1.64 workflows; Vertex AI Veo 3.1 Fast `veo-3.1-fast-generate-001` (`predictLongRunning` + `fetchPredictOperation`); Gemini Omni Flash (existing path); Lyria (`generate_song`); ffmpeg; ai-service `/media/pose` and `/media/brightness-jumps`; vitest; real-ffmpeg tests.

**Spec:** `docs/superpowers/specs/2026-10-14-social-video-clone-design.md` (§3, §5.4, §7 rules 5, 8–12, §8, §8a, §9a, §10). Builds on `docs/superpowers/plans/2026-10-15-social-video-clone-phase3a-preview.md` (main `e522eeb5`).

## Global Constraints

- **Money safety (§8a):**
  - every paid call (each clip attempt, the Omni fallback, the music) is preceded by the prompt gate; `fail` or `unknown` blocks it;
  - one automatic retry per failed clip, with the check's reasons added; never retry on `unknown`;
  - every attempt goes in the ledger.
- **Approval:** clips are the expensive step, so `approve_preview` is a paid stage with its own approval card (`video_generation`), and the preview pause shows a clips + music estimate first.
- **Veo first+last proven in the spike** (`clone-spike/gen.py`, 2026-10-13):
  - body: `instances: [{ prompt, image: { bytesBase64Encoded, mimeType }, lastFrame: { bytesBase64Encoded, mimeType } }]`;
  - parameters: `{ aspectRatio, durationSeconds, sampleCount: 1, generateAudio: false, resolution: '720p', personGeneration: 'allow_adult' }`;
  - poll with `POST …/models/veo-3.1-fast-generate-001:fetchPredictOperation {operationName}`; location `us-central1`;
  - durations 4, 6 or 8 seconds;
  - inline base64 works (no GCS bucket needed for Veo 3.1). This supersedes the older GCS-only note.
- **Fallback chain (rule 11):** Veo refused (content block) → Omni `animate_frame` from the start still, decided in the orchestrator and recorded in the ledger. Never inside the gateway.
- **Frame-exact (rule 12):** every clip is converted to 30fps, then trimmed by frame count. The look frame counts come from cumulative edges, so the total is exactly `round(duration × 30)`.
- **Never copy the music (§9a):** the music is always generated (Lyria), instrumental, in the reference's mood, genre, instruments and tempo. The reference audio never enters our file.
- **Add nothing (rule 7.1):** clip prompts are built from plan lines and measured moves; directions are image-left/right (7.6); the camera holds still unless a camera move was measured.
- **Unknown is never a pass; evidence for every claim:** the final checks reuse `compare_to_reference`'s checks.
- **User-facing text:**
  - plain outcome words; never "Veo", "Omni", "Gemini", "Lyria", "download", "server", "gateway", "ai-service";
  - remind the user to label the video as AI-generated when posting (§11).
- **Rates:** add `video_generation` / `google/veo-3.1-fast-generate-001` at true cost (Gemini API Standard pricing, as for every Google row): $0.10/s at 720p, flat per call at the longest clip (8s) = $0.80 = 80 credits (1 credit = 1 US cent). Same per-second price as Omni. The seed comment says to verify it against the first Google invoice.
- **Why Veo 3.1 Fast, not standard (tested 2026-10-15):**
  - Standard Veo 3.1 is $0.40/s, 4× Omni.
  - Fast on the spike's exact fan-reel look 1 pair and prompt (`clone-spike/fast/`): it accepted image + lastFrame, returned in 62s at 720x1280 24fps 6s, and its last frame matched the end still.
  - Its measured start and end bodies were identical to standard Veo's.
  - Its move times were closer to the prompt (hand down 1.25s, legs 2.75s, vs standard's 0.67s/1.92s).
  - The face stayed the same with the mouth closed, and there was one remote.
- **No silent spend on restart:** a run mid-clips is lost on an orchestrator restart (as in 3a). The deploy note and the `working` stage carry over.
- `*.md` is gitignored: plans, docs and skill files are committed with `git add -f`.
- **Mastra pitfall:** a `Workflow` is a thenable. Never return one from an async function; use `(await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)`.

## Review Focus

1. **A look longer than one clip** (more than 8s with an end still, or more than 10s without): expect a plain "this part is too long to animate yet", and that look is kept as its still in the final video. Never a paid clip that is then cut short in the middle of a move (Task 4 test).
2. **A square (1:1) reel:** the video models make only 9:16 or 16:9. Expect the preview pause to say plainly that square videos can be previewed but not animated yet, and `approve_preview` to refuse with no spend (Task 9 test).
3. **Veo refuses the content:** expect exactly one Omni attempt from the start still, its cost in the ledger, and the clip marked as a fallback in the note. Never Veo again with the same prompt (Task 6 test).
4. **Music shorter than the video** (Lyria gives about 30s; reels run up to 90s): expect the music looped with a 1s crossfade to the exact video length and faded out over the last 1s. No silence at the end (Task 7 real-ffmpeg test).
5. **The final checks are unavailable:** expect the video still delivered, with the note saying the comparison couldn't be run this time. Never a claim that it matches (Task 8 test).

---

## File Structure

Gateway (`apps/inference-gateway/src/`):

| File | Change |
|---|---|
| `veo.ts` (new) | `veoTransitionBody`, `callVeoTransition` (start + poll + parse), `VEO_31_MODEL` |
| `video.ts` | allow `veo-3.1-fast-generate-001`; route it to `callVeoTransition`; `VideoGenerationRequest.lastFrameUri` |

Orchestrator (`apps/agent-orchestrator/src/mastra/`):

| File | Responsibility |
|---|---|
| `tools/veoClip.ts` (new) | `generateVeoClipItem`: charge first, gateway `veo-3.1-fast-generate-001`, upload, refund on failure |
| `remake/looks.ts` | adds `moveLines` (measured and described moves, with times relative to the look) |
| `remake/clipSpec.ts` (new) | `clipSpecs(plan, stills)`: engine, seconds and frames per look; `clipPrompt`; `clipGateInput` |
| `remake/clipCheck.ts` (new) | measured pose of the clip vs the reference look, same person, empty hand |
| `remake/paidClip.ts` (new) | `makeClip`: gate → generate → (Veo refused → Omni once) → trim to 30fps → check → one retry → ledger |
| `remake/compose.ts` (new) | `trimToFrames`, `joinSegments`, `fitMusic`, `muxMusic` (ffmpeg) |
| `remake/music.ts` (new) | `musicPrompt(plan)` |
| `remake/finalNote.ts` (new) | `differenceNote(plan, stills, clips, checks)`: plain words |
| `remake/cost.ts` | `estimateClipsCost` |
| `remake/deps.ts` | adds `generateVeoClip`, `generateOmniClip`, `generateMusic`, `poseClip`, `compare`, `clipRateMicro`, `musicRateMicro`, `probeDuration` |
| `remake/workflow.ts` | preview step suspends `preview_review`; new `clips` and `finish` steps |
| `remake/remakeVideoTool.ts` | `approve_preview` action, `final_ready` stage, approval on `approve_preview` |
| `tools/generationApproval.ts` | the `remake_video` card names the `approve_preview` stage and prices it as video |
| `tools/videoBreakdown/compareToReference.ts` | accepts a known breakdown (no repeat paid breakdown) |

Other:
- `packages/foundation/database/seeds/credit-rates.ts`: the Veo 3.1 row.
- `products/agent-platform/packages/api/seeds/official-skills/template-video.md`: step 9.
- The DEPLOY doc: a Phase 3b section.

Test commands:
- orchestrator: `cd apps/agent-orchestrator && npx vitest run <path>`
- gateway: `cd apps/inference-gateway && npx vitest run <path>`

---

### Task 1: Gateway — Veo 3.1 first+last frame backend

**Files:**
- Create: `apps/inference-gateway/src/veo.ts`
- Modify: `apps/inference-gateway/src/video.ts` (allowlist, request field, dispatch)
- Test: `apps/inference-gateway/src/veo.test.ts`

**Interfaces:**
- Produces:
  - `VideoGenerationRequest.lastFrameUri?: string` (a presigned URL of the end still);
  - `generateVideo({ model: 'veo-3.1-fast-generate-001', task: 'image_to_video', imageUri, lastFrameUri?, durationSeconds: 4|6|8, aspectRatio, prompt })` returns `{ videoBase64, mimeType }`, or `{ refused: true, reason: 'CONTENT_BLOCKED' }` when Veo returns no video or reports filtered media;
  - `export const VEO_31_MODEL = 'veo-3.1-fast-generate-001'`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/inference-gateway/src/veo.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  geminiVideoBreaker: { isAvailable: vi.fn(() => true), onSuccess: vi.fn(), onFailure: vi.fn() },
  vertexVideoBreaker: { isAvailable: vi.fn(() => true), onSuccess: vi.fn(), onFailure: vi.fn() },
}))
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function GoogleAuth() {
    return { getClient: vi.fn().mockResolvedValue({ getAccessToken: vi.fn().mockResolvedValue({ token: 'fake-token' }) }) }
  }),
}))

import { veoTransitionBody, VEO_31_MODEL } from './veo'
import { generateVideo } from './video'

const img = (s: string) => new Response(Buffer.from(s), { headers: { 'content-type': 'image/jpeg' } })

describe('veoTransitionBody', () => {
  it('matches the body proven in the spike: inline start and last frame, no audio, 720p', () => {
    const b = veoTransitionBody({ prompt: 'P', start: { data: 'AAA', mime: 'image/jpeg' }, last: { data: 'BBB', mime: 'image/png' }, seconds: 6, aspectRatio: '9:16' })
    expect(b).toEqual({
      instances: [{ prompt: 'P', image: { bytesBase64Encoded: 'AAA', mimeType: 'image/jpeg' }, lastFrame: { bytesBase64Encoded: 'BBB', mimeType: 'image/png' } }],
      parameters: { aspectRatio: '9:16', durationSeconds: 6, sampleCount: 1, generateAudio: false, resolution: '720p', personGeneration: 'allow_adult' },
    })
  })
  it('a start-only clip has no lastFrame', () => {
    const b = veoTransitionBody({ prompt: 'P', start: { data: 'A', mime: 'image/jpeg' }, last: null, seconds: 4, aspectRatio: '16:9' })
    expect(b.instances[0]).not.toHaveProperty('lastFrame')
  })
})

describe('generateVideo with veo-3.1-fast-generate-001', () => {
  beforeEach(() => { process.env.VERTEX_PROJECT = 'p'; vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('fetches both stills, starts the operation, polls fetchPredictOperation, returns the video', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (url === 'https://s3/start.jpg') return img('start')
      if (url === 'https://s3/end.jpg') return img('end')
      if (url.endsWith(':predictLongRunning')) {
        const body = JSON.parse(String(init!.body))
        expect(body.instances[0].image.bytesBase64Encoded).toBe(Buffer.from('start').toString('base64'))
        expect(body.instances[0].lastFrame.bytesBase64Encoded).toBe(Buffer.from('end').toString('base64'))
        return Response.json({ name: 'projects/p/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op1' })
      }
      if (url.endsWith(':fetchPredictOperation')) return Response.json({ done: true, response: { videos: [{ bytesBase64Encoded: 'VID', mimeType: 'video/mp4' }] } })
      throw new Error(`unexpected ${url}`)
    }))
    const r = await generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 6, imageUri: 'https://s3/start.jpg', lastFrameUri: 'https://s3/end.jpg' })
    expect(r).toEqual({ videoBase64: 'VID', mimeType: 'video/mp4' })
    expect(calls.some((u) => u.includes('us-central1-aiplatform.googleapis.com') && u.includes('veo-3.1-fast-generate-001:predictLongRunning'))).toBe(true)
  })

  it('a done operation with no video (filtered) is a content block, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://s3/')) return img('x')
      if (url.endsWith(':predictLongRunning')) return Response.json({ name: 'op' })
      return Response.json({ done: true, response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['person'] } })
    }))
    const r = await generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 4, imageUri: 'https://s3/a.jpg' })
    expect(r).toEqual({ refused: true, reason: 'CONTENT_BLOCKED' })
  })

  it('rejects durations Veo 3.1 does not take and a missing start image', async () => {
    await expect(generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 5, imageUri: 'https://s3/a.jpg' })).rejects.toThrow(/4, 6 or 8/)
    await expect(generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 4 })).rejects.toThrow(/start image/)
  })

  it('an operation error surfaces as a backend error, never a video', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://s3/')) return img('x')
      if (url.endsWith(':predictLongRunning')) return Response.json({ name: 'op' })
      return Response.json({ done: true, error: { message: 'quota' } })
    }))
    await expect(generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 4, imageUri: 'https://s3/a.jpg' })).rejects.toThrow(/quota/)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/inference-gateway && npx vitest run src/veo.test.ts`
Expected: FAIL with `Failed to resolve import "./veo"`.

- [ ] **Step 3: Implement `veo.ts`**

```ts
// apps/inference-gateway/src/veo.ts
// Veo 3.1 first+last frame on Vertex AI (spec §5.4; proven in the clone spike
// 2026-10-13): inline images, no audio, 720p, polled with fetchPredictOperation.
import { GoogleAuth } from 'google-auth-library'

export const VEO_31_MODEL = 'veo-3.1-fast-generate-001'
const LOCATION = 'us-central1'
const TIMEOUT_MS = 200_000 // under the gateway's 240s
const POLL_MS = 6_000
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })
const project = () => process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''

export interface InlineImage { data: string; mime: string }

export function veoTransitionBody(o: { prompt: string; start: InlineImage; last: InlineImage | null; seconds: number; aspectRatio: '16:9' | '9:16' }) {
  return {
    instances: [{
      prompt: o.prompt,
      image: { bytesBase64Encoded: o.start.data, mimeType: o.start.mime },
      ...(o.last ? { lastFrame: { bytesBase64Encoded: o.last.data, mimeType: o.last.mime } } : {}),
    }],
    parameters: { aspectRatio: o.aspectRatio, durationSeconds: o.seconds, sampleCount: 1, generateAudio: false, resolution: '720p', personGeneration: 'allow_adult' },
  }
}

export async function fetchInline(url: string): Promise<InlineImage> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`)
  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: mime.startsWith('image/') ? mime : 'image/jpeg' }
}

async function token(): Promise<string> {
  const t = await (await _auth.getClient()).getAccessToken()
  if (!t.token) throw new Error('no Vertex access token')
  return t.token
}

export type VeoResult = { videoBase64: string; mimeType: string } | { refused: true; reason: string }

export async function callVeoTransition(o: { prompt: string; startUri: string; lastUri?: string; seconds: number; aspectRatio: '16:9' | '9:16' }): Promise<VeoResult> {
  const [start, last] = await Promise.all([fetchInline(o.startUri), o.lastUri ? fetchInline(o.lastUri) : Promise.resolve(null)])
  const base = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project()}/locations/${LOCATION}/publishers/google/models/${VEO_31_MODEL}`
  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`Veo ${res.status} ${await res.text()}`)
    return res.json() as Promise<Record<string, unknown>>
  }
  const started = await post(`${base}:predictLongRunning`, veoTransitionBody({ prompt: o.prompt, start, last, seconds: o.seconds, aspectRatio: o.aspectRatio }))
  const operationName = started.name as string | undefined
  if (!operationName) throw new Error('Veo: no operation name')
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const op = await post(`${base}:fetchPredictOperation`, { operationName }) as { done?: boolean; error?: { message?: string }; response?: { videos?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> } }
    if (op.done) {
      if (op.error) throw new Error(`Veo operation error: ${op.error.message}`)
      const v = op.response?.videos?.[0]
      if (!v?.bytesBase64Encoded) return { refused: true, reason: 'CONTENT_BLOCKED' }
      return { videoBase64: v.bytesBase64Encoded, mimeType: v.mimeType ?? 'video/mp4' }
    }
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('Veo generation timed out')
}
```

In `video.ts`:
1. Add `lastFrameUri?: string` to `VideoGenerationRequest`, with the doc comment `/** veo-3.1-fast-generate-001 only: the last frame (presigned URL) for first+last frame motion. */`.
2. Change the allowlist to `new Set(['gemini-omni-1.1-flash', VEO_31_MODEL])` (import `VEO_31_MODEL` and `callVeoTransition` from `./veo.js`).
3. At the top of `generateVideo`, before `validateOmniDuration`, add the Veo branch:

```ts
  if (req.model === VEO_31_MODEL) {
    if (![4, 6, 8].includes(req.durationSeconds)) throw new UnsupportedVideoModelError(`Veo 3.1 takes 4, 6 or 8 seconds, got ${req.durationSeconds}`)
    if (!req.imageUri) throw new UnsupportedVideoModelError('Veo 3.1 here needs a start image')
    try {
      const r = await callVeoTransition({ prompt: req.prompt, startUri: req.imageUri, lastUri: req.lastFrameUri, seconds: req.durationSeconds, aspectRatio: req.aspectRatio })
      vertexVideoBreaker.onSuccess()
      return r
    } catch (err) {
      if (isContentBlocked((err as Error).message)) return { refused: true, reason: 'CONTENT_BLOCKED' }
      vertexVideoBreaker.onFailure()
      throw new VideoBackendUnavailableError(`Veo 3.1 failed: ${(err as Error).message}`)
    }
  }
```

Update the `selectBackend` comment block to say that Veo 3.1 is routed by its own explicit model id before Omni's dispatch, and that it never falls back to another model.

- [ ] **Step 4: Run the tests to verify they pass, plus the existing gateway video tests**

Run: `cd apps/inference-gateway && npx vitest run src/veo.test.ts src/video.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/inference-gateway/src/veo.ts apps/inference-gateway/src/veo.test.ts apps/inference-gateway/src/video.ts
git commit -m "feat(gateway): Veo 3.1 first+last frame (inline images, no audio, 720p) for an explicit model id"
```

---

### Task 2: Orchestrator Veo clip item + rate row

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/veoClip.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/veoClip.test.ts`
- Modify: `packages/foundation/database/seeds/credit-rates.ts` (Veo row)

**Interfaces:**
- Consumes: `fetchPresignedUrl` (`mediaCache.ts`), `uploadGeneratedFile` (`persistence.ts`), `refundVideoCharge` (`videoCredits.ts`), `stableToolCallId` (`../../credits.js`), `costMicro`/`resolveRate`/`spendCredits`/`isUnlimited` (`@serverless-saas/credits`), `MediaExecContext`.
- Produces:
  - `export const VEO_CLIP_MODEL = 'google/veo-3.1-fast-generate-001'` (the rate subject);
  - `export async function generateVeoClipItem(input: { prompt: string; startImageFileId: string; endImageFileId?: string; durationSeconds: 4 | 6 | 8; aspectRatio: '9:16' | '16:9'; title: string }, exec: MediaExecContext, itemIndex: number): Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }>`;
  - charge key: `veo:${conversationId}:${stableToolCallId(toolCallId)}:${itemIndex}`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/tools/veoClip.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@serverless-saas/credits', () => ({
  isUnlimited: vi.fn(async () => false),
  resolveRate: vi.fn(async () => ({ id: 'r1', version: 1, schema: { per_call_micro: 80_000_000 } })),
  costMicro: vi.fn(() => 80_000_000n),
  spendCredits: vi.fn(async () => undefined),
}))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async (id: string) => `https://s3/${id}`) }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn(async () => ({ fileId: 'clip-1', name: 'c.mp4', type: 'video/mp4', size: 3 })) }))
vi.mock('./videoCredits.js', () => ({ refundVideoCharge: vi.fn(async () => undefined) }))

const { generateVeoClipItem, VEO_CLIP_MODEL } = await import('./veoClip.js')
const credits = await import('@serverless-saas/credits')
const { refundVideoCharge } = await import('./videoCredits.js')

const rc = (o: Record<string, string> = {}) => ({ get: (k: string) => ({ tenantId: 't1', conversationId: 'c1', idToken: 'tok', ...o } as Record<string, string>)[k] })
const exec = { requestContext: rc(), agent: { toolCallId: 'remake:run1' } }
const input = { prompt: 'P', startImageFileId: 's1', endImageFileId: 'e1', durationSeconds: 6 as const, aspectRatio: '9:16' as const, title: 'Remake look 1 clip' }

beforeEach(() => vi.clearAllMocks())

describe('generateVeoClipItem', () => {
  it('charges first under a per-item key, sends both stills to the Veo model, uploads the clip', async () => {
    const fetchMock = vi.fn(async () => Response.json({ videoBase64: Buffer.from('mp4').toString('base64'), mimeType: 'video/mp4' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await generateVeoClipItem(input, exec, 7)
    expect(r).toMatchObject({ fileId: 'clip-1', creditsUsedMicro: '80000000' })
    expect(credits.resolveRate).toHaveBeenCalledWith('video_generation', VEO_CLIP_MODEL)
    const spend = vi.mocked(credits.spendCredits).mock.calls[0][0] as { key: string }
    expect(spend.key).toMatch(/^veo:c1:[0-9a-f]{64}:7$/)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body))
    expect(body).toMatchObject({ model: 'veo-3.1-fast-generate-001', task: 'image_to_video', imageUri: 'https://s3/s1', lastFrameUri: 'https://s3/e1', durationSeconds: 6, aspectRatio: '9:16' })
  })
  it('refunds and reports a content block', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ refused: true, reason: 'CONTENT_BLOCKED' })))
    const r = await generateVeoClipItem(input, exec, 0)
    expect(r).toMatchObject({ refused: true, refusalReason: 'CONTENT_BLOCKED' })
    expect(refundVideoCharge).toHaveBeenCalled()
  })
  it('refunds when the gateway fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })))
    const r = await generateVeoClipItem(input, exec, 0)
    expect(r).toMatchObject({ refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(refundVideoCharge).toHaveBeenCalled()
  })
  it('says insufficient credits without calling the model', async () => {
    vi.mocked(credits.spendCredits).mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'InsufficientCreditsError' }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await generateVeoClipItem(input, exec, 0)).toEqual({ insufficientCredits: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/veoClip.test.ts`
Expected: FAIL with `Failed to resolve import "./veoClip.js"`.

- [ ] **Step 3: Implement `veoClip.ts`**

```ts
// apps/agent-orchestrator/src/mastra/tools/veoClip.ts
// One Veo 3.1 clip between two stills (spec §5.4). Charge-first, refund on every failure
// (same settled rule as generateVideo.ts). Not an agent tool: only the remake workflow
// calls it, after its own prompt gate and approval.
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { stableToolCallId } from '../../credits.js'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { refundVideoCharge } from './videoCredits.js'
import type { MediaExecContext } from './batchRunner.js'

export const VEO_CLIP_MODEL = 'google/veo-3.1-fast-generate-001'
const GATEWAY_MODEL_ID = 'veo-3.1-fast-generate-001'
const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'

export async function generateVeoClipItem(
  input: { prompt: string; startImageFileId: string; endImageFileId?: string; durationSeconds: 4 | 6 | 8; aspectRatio: '9:16' | '16:9'; title: string },
  exec: MediaExecContext, itemIndex: number,
): Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }> {
  const rc = exec.requestContext
  const tenantId = (rc?.get('tenantId') as string | undefined) ?? ''
  const agentId = rc?.get('agentId') as string | undefined
  const conversationId = (rc?.get('conversationId') as string | undefined) ?? 'unknown'
  const idToken = rc?.get('idToken') as string | undefined
  if (!idToken) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
  const chargeKey = `veo:${conversationId}:${stableToolCallId(exec.agent?.toolCallId ?? 'unknown')}:${itemIndex}`

  let imageUri: string, lastFrameUri: string | undefined
  try {
    imageUri = await fetchPresignedUrl(input.startImageFileId, idToken)
    lastFrameUri = input.endImageFileId ? await fetchPresignedUrl(input.endImageFileId, idToken) : undefined
  } catch {
    return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
  }

  let charged = false, rateId: string | null = null, rateVersion: number | null = null, amount = 0n
  if (!(await isUnlimited(tenantId))) {
    const rate = await resolveRate('video_generation', VEO_CLIP_MODEL)
    if (!rate) {
      console.error(`[credits] UNBILLED VIDEO GENERATION: no active video_generation rate for model=${VEO_CLIP_MODEL} tenantId=${tenantId}`)
    } else {
      rateId = rate.id; rateVersion = rate.version; amount = costMicro(rate.schema, { count: 1 })
      try {
        await spendCredits({ tenantId, amountMicro: -amount, key: chargeKey, kind: 'debit', actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'video_generation' })
        charged = true
      } catch (err) {
        if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
        throw err
      }
    }
  }
  const refund = async () => { if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion) }

  let out: { videoBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/video/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({ model: GATEWAY_MODEL_ID, prompt: input.prompt, task: 'image_to_video', aspectRatio: input.aspectRatio, durationSeconds: input.durationSeconds, imageUri, lastFrameUri }),
      signal: AbortSignal.timeout(270_000),
    })
    if (!res.ok) throw new Error(`gateway returned ${res.status}`)
    out = await res.json()
  } catch (err) {
    console.error('[veoClip] gateway call failed:', (err as Error).message)
    await refund()
    return { refused: true, refusalReason: 'GENERATION_FAILED' }
  }
  if (out.refused || typeof out.videoBase64 !== 'string') {
    await refund()
    return { refused: true, refusalReason: out.refused ? (out.reason ?? 'CONTENT_BLOCKED') : 'GENERATION_FAILED' }
  }
  const att = await uploadGeneratedFile(idToken, { name: `${input.title}.mp4`, content: Buffer.from(out.videoBase64, 'base64'), contentType: out.mimeType ?? 'video/mp4' } as never)
  if (!att) { await refund(); return { refused: true, refusalReason: 'UPLOAD_FAILED' } }
  return { fileId: att.fileId, creditsUsedMicro: String(amount) }
}
```

Before writing the upload call, read `uploadGeneratedFile`'s exact parameter shape in `src/persistence.ts:568` and match it (the `as never` above is only a placeholder; type it properly). If its signature differs, ledger the ruling. Also confirm `INFERENCE_GATEWAY_URL` is the env name `generateVideo.ts` uses for `GATEWAY_URL` (`grep -n "GATEWAY_URL =" src/mastra/tools/generateVideo.ts`) and use the same expression.

In `credit-rates.ts`, add after the Omni row:

```ts
  // Veo 3.1 Fast (veo-3.1-fast-generate-001) first+last frame, 720p, no audio, used only by
  // the remake workflow: $0.10 per second on the Gemini API (same as Omni); flat per call at
  // the longest clip we make (8s) = $0.80 = 80 credits, so a shorter clip is overcharged
  // rather than undercharged. Standard Veo 3.1 is $0.40/s and is not used. Verify against
  // the first Google invoice.
  { resourceType: 'video_generation', subject: 'google/veo-3.1-fast-generate-001',
    pricingSchema: { per_call_micro: 80_000_000 } },
```

- [ ] **Step 4: Run the tests to verify they pass; type-check**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/tools/veoClip.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/veoClip.ts apps/agent-orchestrator/src/mastra/tools/veoClip.test.ts packages/foundation/database/seeds/credit-rates.ts
git commit -m "feat(remake): Veo 3.1 clip item, charge-first with refunds; Veo rate row"
```

---

### Task 3: Moves per look, and clip specs (`looks.ts`, `clipSpec.ts`)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/remake/types.ts` (`RemakeLook.moveLines`, `RemakeLook.cameraLines`)
- Modify: `apps/agent-orchestrator/src/mastra/remake/looks.ts`
- Create: `apps/agent-orchestrator/src/mastra/remake/clipSpec.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/clipSpec.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/remake/fixtures.testing.ts` (give look b a measured pose move and a camera move)

**Interfaces:**
- Produces:
  - `RemakeLook.moveLines: string[]`, plain lines with times relative to the look's start, for example `"at 1.2s: upper body moves up and right"` (measured) and `"at 1.9s: legs: stands up (image-up)"` (described);
  - `RemakeLook.cameraLines: string[]`, for example `"at 0.5s: the camera pans right"`;
  - `export const CLIP_FPS = 30`;
  - `export function lookFrames(plan: RemakePlan): Map<number, number>`: frames per look from cumulative edges;
  - `export interface ClipSpec { look: RemakeLook; engine: 'veo' | 'omni' | 'none'; seconds: number; frames: number; start: string | null; end: string | null; reason?: string }`;
  - `export function clipSpecs(plan: RemakePlan, stills: StillResult[]): ClipSpec[]`;
  - `export function clipPrompt(plan: RemakePlan, look: RemakeLook, brand: Brand, engine: 'veo' | 'omni'): string`;
  - `export function clipGateInput(plan: RemakePlan, look: RemakeLook, prompt: string)`, the same shape as `stillGateInput`, with `keyMoments` = the reference moments inside the look, as plain text.

Rules for `clipSpecs`:
- A start still is usable only when its status is `passed` or `unchecked`; same for the end still.
- No usable start still → `engine: 'none'`, reason `"its still wasn't made, so this part stays a still"`.
- Usable start and end, and the look is 8s or less → `veo`, with seconds = the smallest of 4/6/8 that is ≥ the look's length.
- Otherwise, a look of 10s or less → `omni`, with seconds = `min(10, max(3, ceil(length)))`.
- Otherwise (a look over 10s, or over 8s with no end still) → `none`, reason `"this part is too long to animate yet, so it stays a still"`.
- `frames` comes from `lookFrames`, always.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/clipSpec.test.ts
import { describe, it, expect, vi } from 'vitest'
import { clipSpecs, clipPrompt, clipGateInput, lookFrames, CLIP_FPS } from './clipSpec.js'
import { writePlan } from './plan.js'
import { breakdown } from './fixtures.testing.js'
import type { StillResult } from './types.js'

const brand = { name: 'B', product: 'p' }
const plan = () => writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
const ok = (look: number, kind: 'start' | 'end', status: StillResult['status'] = 'passed'): StillResult => ({ look, kind, fileId: `${look}${kind}`, status, reasons: [] })

describe('lookFrames', () => {
  it('sums to exactly round(total × 30)', async () => {
    const f = lookFrames(await plan())
    expect([...f.values()].reduce((a, b) => a + b, 0)).toBe(Math.round(10 * CLIP_FPS))
    expect(f.get(1)).toBe(123) // 4.1s
  })
})

describe('clipSpecs', () => {
  it('Veo between two good stills, at the smallest length that covers the look', async () => {
    const s = clipSpecs(await plan(), [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(s[1]).toMatchObject({ engine: 'veo', seconds: 6, start: '2start', end: '2end', frames: 177 })
  })
  it('Omni from the start still when there is no usable end still', async () => {
    const s = clipSpecs(await plan(), [ok(1, 'start'), ok(2, 'start'), ok(2, 'end', 'failed')])
    expect(s[0]).toMatchObject({ engine: 'omni', seconds: 5 })
    expect(s[1]).toMatchObject({ engine: 'omni', seconds: 6, end: null })
  })
  it('no usable start still keeps the part as a still, with a plain reason', async () => {
    const s = clipSpecs(await plan(), [ok(1, 'start', 'blocked'), ok(2, 'start'), ok(2, 'end')])
    expect(s[0]).toMatchObject({ engine: 'none' })
    expect(s[0].reason).toMatch(/stays a still/)
  })
  it('a part longer than one clip stays a still and is never paid for (Review Focus 1)', async () => {
    const p = await plan()
    p.looks[1] = { ...p.looks[1], endS: 15.5 }
    p.reference.durationS = 15.5
    const s = clipSpecs(p, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(s[1]).toMatchObject({ engine: 'none' })
    expect(s[1].reason).toMatch(/too long/)
  })
})

describe('clipPrompt', () => {
  it('carries the measured moves with look-relative times, holds the camera, adds nothing', async () => {
    const p = await plan()
    const s = clipPrompt(p, p.looks[1], brand, 'veo')
    expect(s).toMatch(/at 1\.9s: legs/)
    expect(s).toMatch(/image-up|up/)
    expect(s).toMatch(/The first image is the first frame and the second image is the last frame/)
    expect(s).toMatch(/Add nothing/)
    expect(s).not.toMatch(/smile/i) // look b's reference expression "smiles" is kept only as given
  })
  it('Omni prompts say the image is the first frame and there is no last frame', async () => {
    const p = await plan()
    expect(clipPrompt(p, p.looks[0], brand, 'omni')).toMatch(/The image is the exact first frame/)
  })
  it('the gate gets the moments inside the look', async () => {
    const p = await plan()
    expect(clipGateInput(p, p.looks[1], 'X').keyMoments).toEqual(['stands up'])
    expect(clipGateInput(p, p.looks[0], 'X').keyMoments).toEqual([])
  })
})
```

The `.not.toMatch(/smile/i)` line is wrong as written, because look b's kept expression IS "smiles" and the clip must keep it (rule 7.1 forbids adding, not keeping). Write that assertion instead as: the prompt contains `Expression: smiles` exactly once, and look a's prompt (expression "mouth closed") contains no smile word (use `precheckPrompt` from `scorers/video/promptCheck.ts` returning `[]`).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/clipSpec.test.ts`
Expected: FAIL with `Failed to resolve import "./clipSpec.js"`.

- [ ] **Step 3: Implement.** In `types.ts`, add to `RemakeLook`:

```ts
  moveLines: string[]     // "at 1.2s: upper body moves up and right" (times from the look's start)
  cameraLines: string[]   // "at 0.5s: the camera pans right"
```

In `looks.ts`, inside `remakeLooks`, compute (before the `return [{`):

```ts
    const rel = (t: number) => `at ${Math.max(0, t - startS).toFixed(1)}s`
    const AREA: Record<string, string> = { upper: 'upper body', lower: 'legs' }
    const say = (d: string) => d.split(' + ').map((x) => x.replace('image-', '')).join(' and ')
    const measuredMoves = (b.pose?.moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS)
      .map((x) => `${rel(x.t_s)}: ${AREA[x.area] ?? x.area} moves ${say(x.direction)}`)
    const describedMoves = (l.moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS)
      .map((x) => `${rel(x.t_s)}: ${x.limb}: ${x.how} (${x.direction})`)
    const cameraLines = (b.pose?.camera_moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS)
      .map((x) => `${rel(x.t_s)}: the camera ${x.direction.replace('-', 's ').replace('pans ', 'pans ')}`)
```

and add `moveLines: [...measuredMoves, ...describedMoves], cameraLines,` to the returned object. The camera wording maps `pan-left` → "pans left" and `tilt-up` → "tilts up"; write it as an explicit map: `{ 'pan-left': 'pans left', 'pan-right': 'pans right', 'tilt-up': 'tilts up', 'tilt-down': 'tilts down' }`.

In `fixtures.testing.ts`, set `pose.moves` to `[{ t_s: 5.3, from_s: 5.1, to_s: 5.6, area: 'upper', direction: 'image-up', strength: 0.05 }]` and look b's `moves[0].t_s` to `6`, so look b reads `at 1.2s: upper body moves up` and `at 1.9s: legs: stands up (up)`. Re-run all remake tests after the fixture change. Any 3a test that counted moves (`needsEndStill`) must still pass; look b already had a move.

Create `clipSpec.ts`:

```ts
// apps/agent-orchestrator/src/mastra/remake/clipSpec.ts
// Which model animates each look, for how long, and the prompt, all from the plan and
// the measured readings (spec §5.4, rules 5, 6, 7.1, 7.2, 12).
import { personWords } from '../tools/videoBreakdown/measuredLine.js'
import { personIn } from './looks.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan, StillResult } from './types.js'

export const CLIP_FPS = 30
const VEO_SECONDS = [4, 6, 8] as const

export interface ClipSpec { look: RemakeLook; engine: 'veo' | 'omni' | 'none'; seconds: number; frames: number; start: string | null; end: string | null; reason?: string }

export function lookFrames(plan: RemakePlan): Map<number, number> {
  const out = new Map<number, number>()
  let prev = 0
  for (const l of [...plan.looks].sort((a, b) => a.startS - b.startS)) {
    const edge = Math.round(l.endS * CLIP_FPS + 1e-9)
    out.set(l.n, edge - Math.round(l.startS * CLIP_FPS + 1e-9) + (Math.round(l.startS * CLIP_FPS + 1e-9) - prev))
    prev = edge
  }
  return out
}

const usable = (s: StillResult | undefined) => (s && s.fileId && (s.status === 'passed' || s.status === 'unchecked') ? s.fileId : null)

export function clipSpecs(plan: RemakePlan, stills: StillResult[]): ClipSpec[] {
  const frames = lookFrames(plan)
  return [...plan.looks].sort((a, b) => a.startS - b.startS).map((look): ClipSpec => {
    const len = look.endS - look.startS
    const start = usable(stills.find((s) => s.look === look.n && s.kind === 'start'))
    const end = usable(stills.find((s) => s.look === look.n && s.kind === 'end'))
    const base = { look, frames: frames.get(look.n) ?? Math.round(len * CLIP_FPS), start, end }
    if (!start) return { ...base, engine: 'none', seconds: 0, end: null, reason: 'its still wasn’t made, so this part stays a still' }
    const veo = VEO_SECONDS.find((s) => s >= len - 1e-9)
    if (end && veo) return { ...base, engine: 'veo', seconds: veo }
    if (len <= 10 + 1e-9) return { ...base, engine: 'omni', seconds: Math.min(10, Math.max(3, Math.ceil(len - 1e-9))), end: null }
    return { ...base, engine: 'none', seconds: 0, end: null, reason: 'this part is too long to animate yet, so it stays a still' }
  })
}

const lineOf = (plan: RemakePlan, ref: string): PlanLine | undefined => plan.lines.find((l) => l.ref === ref)
const shown = (plan: RemakePlan, ref: string, original: string): string | null => {
  const l = lineOf(plan, ref)
  if (!l || l.action === 'keep') return original.trim() || null
  return l.action === 'swap' ? l.to?.trim() || null : null
}

export function clipPrompt(plan: RemakePlan, look: RemakeLook, _brand: Brand, engine: 'veo' | 'omni'): string {
  const i = look.n - 1
  const parts: string[] = [engine === 'veo'
    ? 'The first image is the first frame and the second image is the last frame; move naturally from one to the other.'
    : 'The image is the exact first frame; continue from it.']
  if (personIn(look)) {
    parts.push('Keep the same person, face, outfit and setting the whole time.')
    if (look.start) parts.push(`At the start: ${personWords(look.start, null).join(', ')}.`)
    if (look.end && engine === 'veo') parts.push(`At the end: ${personWords(look.end, null).join(', ')}.`)
    const expression = shown(plan, `looks[${i}].expression`, look.expression)
    if (expression) parts.push(`Expression: ${expression}.`)
  }
  parts.push(look.moveLines.length ? `Movement (directions as the viewer sees the frame): ${look.moveLines.join('; ')}.` : 'Hold the pose with only small natural motion.')
  parts.push(look.cameraLines.length ? `Camera: ${look.cameraLines.join('; ')}.` : 'The camera stays still.')
  parts.push('Add nothing that is not described here: no extra people, objects, effects, text, logos or flicker; no change of lighting.')
  return parts.join(' ')
}

export function clipGateInput(plan: RemakePlan, look: RemakeLook, prompt: string) {
  const i = look.n - 1
  const mine = plan.lines.filter((l) => l.ref.startsWith(`looks[${i}].`) || l.ref === 'cast' || l.ref.startsWith('props['))
  return {
    prompt,
    planLine: [`clip of look ${look.n}`, ...mine.map((l) => `${l.ref}: ${l.action}${l.to ? ` to ${l.to}` : ''}`)].join('; '),
    look: { expression: shown(plan, `looks[${i}].expression`, look.expression) ?? undefined, start_pose: look.startPose, end_pose: look.endPose, measured: look.measured, moves: look.moveLines } as Record<string, unknown> & { expression?: string },
    startFrameObjects: plan.reference.props.flatMap((p, j) => shown(plan, `props[${j}]`, p.prop) ?? []),
    keyMoments: plan.reference.moments.filter((m) => m.t_s >= look.startS && m.t_s < look.endS).map((m) => m.what),
  }
}
```

Note: `lookFrames` must give per-look counts from cumulative END edges (as `segmentFrames` in `preview.ts`). Simplify the body to: sort looks; `edge = round(endS × 30)`; `count = edge − prev`; `prev = edge`, so that gaps or overlaps between measured spans are absorbed into the following look. The test pins the total.

- [ ] **Step 4: Run the tests to verify they pass, plus all remake tests**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/
git commit -m "feat(remake): per-look clip specs (Veo between stills, Omni from one, too-long stays a still) and clip prompts from measured moves"
```

---

### Task 4: Measured clip checks (`clipCheck.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/clipCheck.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/clipCheck.test.ts`

**Interfaces:**
- Consumes: `comparePose` (3a), `PoseResult` (`aiServiceClient.ts`), `samePersonScorer` and `emptyHandScorer` (`scorers/video/visionScorers.ts`), `runGate`, `CheckResult`, `Img`, `evenTimes`.
- Produces: `export async function checkClip(o: { clipPath: string; seconds: number; look: RemakeLook; portrait: Img | null; tenantId: string }, d: { poseClip: (path: string, seconds: number) => Promise<PoseResult>; sample: (path: string, times: number[]) => Promise<Img[]>; gate: typeof runGate }): Promise<CheckResult>`.

Rules:
- **Pose:** call `poseClip(path, seconds)`, which runs `/media/pose` with one look `{label:'clip', start_s:0, end_s:seconds}`. Turn `looks[0]` into the shape `comparePose` takes, `{ model, people: people ?? 0, no_person: !!no_person, main: main_start }` for the start and `main_end` for the end. Compare `look.start` with the start and `look.end` with the end. Each comparison returns pass, fail or unknown.
- **Same person:** only when the look has a person and a portrait exists. `runGate(samePersonScorer, 'same-person', { tenantId, reference: portrait, frames: sample(path, evenTimes(seconds, 4)) }, [...])`.
- **Empty hand:** `runGate(emptyHandScorer, 'empty-hand', { tenantId, frames }, [...])`.
- **Result:** any fail gives `fail` with every fail reason joined by `; `. Otherwise any unknown gives `unknown`. Otherwise `pass`.
- A throw anywhere gives `unknown`, with reason `"the clip could not be checked this time"`; the raw message goes to `console.error('[remake] clip check failed: …')`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/clipCheck.test.ts
import { describe, it, expect, vi } from 'vitest'
import { checkClip } from './clipCheck.js'
import { remakeLooks } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'

const look = remakeLooks(breakdown())[1] // start: knees bent; end: straight
const img = { data: 'AA', mime: 'image/jpeg' }
const poseLook = (start = body({ knees: 'bent' }), end = body(), people: number | null = 1) => ({ model: 'm', moves: [], camera_moves: [], looks: [{ label: 'clip', start_s: 0, end_s: 6, frames_used: 9, people, people_max: people, no_person: people === 0, main_start: start, main_end: end, leg_side_start: 'center' as const, leg_side_end: 'center' as const, body_angle_end: 0, key_frames: [] }] })
const pass = (name: string) => ({ name, status: 'pass' as const, reason: '', evidenceTimes: [] })
const deps = (o: Record<string, unknown> = {}) => ({ poseClip: vi.fn(async () => poseLook()), sample: vi.fn(async () => [img, img, img, img]), gate: vi.fn(async (_s: unknown, name: string) => pass(name)), ...o })

describe('checkClip', () => {
  it('passes a clip whose measured start and end bodies match the reference look', async () => {
    const d = deps()
    expect((await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, d as never)).status).toBe('pass')
    expect(d.gate).toHaveBeenCalledTimes(2) // same person + empty hand
  })
  it('fails when the clip ends in the wrong pose (rule 5: a move must reach its end pose)', async () => {
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, deps({ poseClip: vi.fn(async () => poseLook(body({ knees: 'bent' }), body({ knees: 'bent' }))) }) as never)
    expect(r.status).toBe('fail')
    expect(r.reason).toMatch(/knees/)
  })
  it('fails an empty hand and a different person', async () => {
    const gate = vi.fn(async (_s: unknown, name: string) => (name === 'empty-hand' ? { ...pass(name), status: 'fail' as const, reason: 'hand pinches empty air' } : pass(name)))
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, deps({ gate }) as never)
    expect(r).toMatchObject({ status: 'fail', reason: expect.stringMatching(/empty air/) })
  })
  it('a measurement outage is unknown with plain words, never a pass', async () => {
    const r = await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: img, tenantId: 't' }, deps({ poseClip: vi.fn(async () => { throw new Error('ai-service 500') }) }) as never)
    expect(r.status).toBe('unknown')
    expect(r.reason).not.toMatch(/ai-service/)
  })
  it('no portrait or no person: no same-person check', async () => {
    const d = deps()
    await checkClip({ clipPath: '/c.mp4', seconds: 6, look, portrait: null, tenantId: 't' }, d as never)
    expect(d.gate).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/clipCheck.test.ts`
Expected: FAIL with `Failed to resolve import "./clipCheck.js"`.

- [ ] **Step 3: Implement `clipCheck.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/clipCheck.ts
// A paid clip, checked before it is kept (spec §8, rule 10): the measured body at the
// clip's start and end against the reference look, the same person, no empty-hand action.
import type { PoseResult, BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
import { evenTimes, type Img } from '../tools/tvcChecks.js'
import { runGate, type CheckResult } from '../scorers/video/gate.js'
import { samePersonScorer, emptyHandScorer } from '../scorers/video/visionScorers.js'
import { comparePose } from './poseCompare.js'
import { personIn } from './looks.js'
import type { RemakeLook } from './types.js'

export interface ClipCheckDeps {
  poseClip: (path: string, seconds: number) => Promise<PoseResult>
  sample: (path: string, times: number[]) => Promise<Img[]>
  gate: typeof runGate
}

const asImage = (people: number | null, main: BodyReading | null) => ({ model: 'clip', people: people ?? 0, no_person: (people ?? 0) === 0, main })

export async function checkClip(o: { clipPath: string; seconds: number; look: RemakeLook; portrait: Img | null; tenantId: string }, d: ClipCheckDeps): Promise<CheckResult> {
  try {
    const times = evenTimes(o.seconds, 4)
    const [pose, frames] = await Promise.all([d.poseClip(o.clipPath, o.seconds), d.sample(o.clipPath, times)])
    const m = pose.looks[0]
    const results: CheckResult[] = [
      { ...comparePose(o.look.start, o.look.people, asImage(m?.people ?? null, m?.main_start ?? null)), name: 'start pose' },
      { ...comparePose(o.look.end, o.look.people, asImage(m?.people ?? null, m?.main_end ?? null)), name: 'end pose' },
    ]
    if (personIn(o.look) && o.portrait) results.push(await d.gate(samePersonScorer, 'same-person', { tenantId: o.tenantId, reference: o.portrait, frames }, times))
    results.push(await d.gate(emptyHandScorer, 'empty-hand', { tenantId: o.tenantId, frames }, times))
    const fails = results.filter((r) => r.status === 'fail')
    if (fails.length) return { name: 'clip', status: 'fail', reason: fails.map((r) => `${r.name}: ${r.reason}`).join('; '), evidenceTimes: times }
    if (results.some((r) => r.status === 'unknown')) return { name: 'clip', status: 'unknown', reason: 'part of the clip could not be checked', evidenceTimes: times }
    return { name: 'clip', status: 'pass', reason: 'passed every check', evidenceTimes: times }
  } catch (err) {
    console.error('[remake] clip check failed:', err instanceof Error ? err.message : String(err))
    return { name: 'clip', status: 'unknown', reason: 'the clip could not be checked this time', evidenceTimes: [] }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/clipCheck.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/clipCheck.ts apps/agent-orchestrator/src/mastra/remake/clipCheck.test.ts
git commit -m "feat(remake): clip checks: measured start/end body vs the reference look, same person, empty hand"
```

---

### Task 5: ffmpeg composition: trims, joins, music fit (`compose.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/compose.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/compose.realffmpeg.test.ts`

**Interfaces:**
- Produces:
  - `trimToFrames(input: string, frames: number, out: string, size: { width: number; height: number }): Promise<string>`: fits the clip to the frame size (scale to cover, then center-crop), converts to 30fps, keeps exactly `frames` frames (pads by cloning the last frame when the clip is short), no audio;
  - `stillToFrames(still: string | null, frames: number, out: string, size): Promise<string>`: a still or a grey card held for `frames` frames;
  - `joinSegments(parts: string[], out: string): Promise<string>`: hard cuts, no re-timing;
  - `fitMusic(music: string, seconds: number, out: string): Promise<string>`: loops with a 1s crossfade until it is long enough, trims to `seconds`, fades out over the last 1s;
  - `muxMusic(video: string, music: string, out: string): Promise<string>`: the video stream is copied and the audio is AAC from the music only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/remake/compose.realffmpeg.test.ts
import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trimToFrames, stillToFrames, joinSegments, fitMusic, muxMusic } from './compose.js'

const dir = mkdtempSync(join(tmpdir(), 'remake-compose-'))
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
const probe = (p: string, args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args, p]).toString().trim()
const frames = (p: string) => Number(probe(p, ['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0']))
const seconds = (p: string) => Number(probe(p, ['-show_entries', 'format=duration', '-of', 'csv=p=0']))
const size = { width: 720, height: 1280 }

it('trims a 24fps clip to exact 30fps frames, pads a short one, holds a still, joins with hard cuts', async () => {
  const c24 = join(dir, 'c24.mp4'); ff(['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=24:d=6', c24])
  const c2 = join(dir, 'c2.mp4'); ff(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=24:d=2', c2])
  const png = join(dir, 's.png'); ff(['-f', 'lavfi', '-i', 'color=c=red:s=540x960', '-frames:v', '1', png])
  const a = await trimToFrames(c24, 123, join(dir, 'a.mp4'), size)
  const b = await trimToFrames(c2, 90, join(dir, 'b.mp4'), size) // 2s clip, 3s look: padded
  const s = await stillToFrames(png, 37, join(dir, 's.mp4'), size)
  const g = await stillToFrames(null, 10, join(dir, 'g.mp4'), size)
  expect([frames(a), frames(b), frames(s), frames(g)]).toEqual([123, 90, 37, 10])
  expect(probe(b, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])).toBe('720,1280')
  const joined = await joinSegments([a, b, s, g], join(dir, 'joined.mp4'))
  expect(frames(joined)).toBe(260)
}, 120_000)

it('fits 3s of music to an 8s video with a loop and a fade, then muxes it as the only audio', async () => {
  const m = join(dir, 'm.mp3'); ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', m])
  const v = join(dir, 'v.mp4'); ff(['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=30:d=8', '-an', v])
  const fitted = await fitMusic(m, 8, join(dir, 'fit.m4a'))
  expect(seconds(fitted)).toBeCloseTo(8, 1)
  const out = await muxMusic(v, fitted, join(dir, 'out.mp4'))
  expect(probe(out, ['-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0'])).toBe('aac')
  expect(seconds(out)).toBeCloseTo(8, 1)
}, 120_000)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/compose.realffmpeg.test.ts`
Expected: FAIL with `Failed to resolve import "./compose.js"`.

- [ ] **Step 3: Implement `compose.ts`**

```ts
// apps/agent-orchestrator/src/mastra/remake/compose.ts
// Frame-exact composition (spec rule 12): every part is 30fps and exactly its frame count,
// so the joined remake is exactly as long as the reference. Hard cuts only (fades are 3c).
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLIP_FPS } from './clipSpec.js'

const execFile = promisify(execFileCb)
const run = (args: string[]) => execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 180_000 })
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(CLIP_FPS)]
const cover = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`

export async function trimToFrames(input: string, frames: number, out: string, size: { width: number; height: number }): Promise<string> {
  const pad = `tpad=stop_mode=clone:stop_duration=${(frames / CLIP_FPS + 1).toFixed(3)}`
  await run(['-i', input, '-an', '-vf', `${cover(size.width, size.height)},fps=${CLIP_FPS},${pad}`, '-frames:v', String(frames), ...X264, out])
  return out
}

export async function stillToFrames(still: string | null, frames: number, out: string, size: { width: number; height: number }): Promise<string> {
  const { width: W, height: H } = size
  const d = (frames / CLIP_FPS + 0.5).toFixed(3)
  if (!still) await run(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=${CLIP_FPS}`, '-frames:v', String(frames), ...X264, out])
  else await run(['-loop', '1', '-t', d, '-i', still, '-vf', `${cover(W, H)},fps=${CLIP_FPS}`, '-frames:v', String(frames), ...X264, out])
  return out
}

export async function joinSegments(parts: string[], out: string): Promise<string> {
  const list = join(dirname(out), 'join-list.txt')
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'))
  await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out])
  return out
}

export async function fitMusic(music: string, seconds: number, out: string): Promise<string> {
  const s = seconds.toFixed(3)
  const fadeAt = Math.max(0, seconds - 1).toFixed(3)
  await run(['-stream_loop', '-1', '-i', music, '-af', `atrim=0:${s},afade=t=out:st=${fadeAt}:d=1`, '-t', s, '-c:a', 'aac', out])
  return out
}

export async function muxMusic(video: string, music: string, out: string): Promise<string> {
  await run(['-i', video, '-i', music, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', out])
  return out
}
```

The Global Constraints and Review Focus 4 ask for a 1s crossfade at the loop point. `-stream_loop` gives a hard loop. If the real-ffmpeg test and a listen show an audible click at the loop, replace the loop with `acrossfade` chaining (copies of the music joined with `acrossfade=d=1`) and ledger the ruling. The test pins only length and codec.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/compose.realffmpeg.test.ts`
Expected: PASS (2 tests). If a pad or join is one frame off, fix the filter, not the expectation.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/compose.ts apps/agent-orchestrator/src/mastra/remake/compose.realffmpeg.test.ts
git commit -m "feat(remake): frame-exact 30fps trims, held stills, hard-cut join, music fitted to length"
```

---

### Task 6: A paid clip with gate, Veo→Omni fallback, trim, checks, one retry (`paidClip.ts`) + deps

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/paidClip.ts`
- Modify: `apps/agent-orchestrator/src/mastra/remake/deps.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/paidClip.test.ts`

**Interfaces:**
- Consumes: `ClipSpec`, `clipPrompt`, `clipGateInput` (Task 3); `checkClip` (Task 4); `trimToFrames` (Task 5); `generateVeoClipItem` (Task 2); `generateVideoItem` (`tools/generateVideo.ts`).
- Produces, in `RemakeDeps` (with real defaults):
  - `generateVeoClip: typeof generateVeoClipItem`;
  - `generateOmniClip: (input: { prompt: string; startImageFileId: string; durationSeconds: number; aspectRatio: '9:16' | '16:9'; title: string }, exec, index) => Promise<{ fileId?; refused?; refusalReason?; insufficientCredits?; creditsUsedMicro? }>`, which calls `generateVideoItem({ mode: 'animate_frame', ... }, exec, index)`;
  - `poseClip(path, seconds)` → `aiService<PoseResult>('/media/pose', { path, looks: [{ label: 'clip', start_s: 0, end_s: seconds }] })`;
  - `sample(path, times)` → `sampleFrames(path, times, mkdtempSync(...))`;
  - `clipRateMicro(engine: 'veo' | 'omni'): Promise<bigint | null>`;
  - `musicRateMicro(): Promise<bigint | null>`;
  - `generateMusic(prompt: string, exec): Promise<{ fileId?; refused?; insufficientCredits?; creditsUsedMicro? }>`;
  - `compare(breakdown, remakeFileId, ctx, tenantId)`;
  - `trimToFrames: typeof trimToFrames`.
- Also produces:
  - `export const clipSlot = (n: number, attempt: number, fallback: boolean) => 1000 + n * 8 + attempt * 2 + (fallback ? 1 : 0)`;
  - `export interface ClipResult { look: number; fileId: string | null; localPath: string | null; engine: 'veo' | 'omni' | 'none'; fallback: boolean; status: 'passed' | 'failed' | 'unchecked' | 'blocked' | 'still'; reasons: string[] }`;
  - `export async function makeClip(spec: ClipSpec, ctx: ClipCtx, deps: RemakeDeps): Promise<{ result: ClipResult; ledger: LedgerEntry[] }>`.

Behaviour:
1. `spec.engine === 'none'` → status `still`, `reasons: [spec.reason]`, no ledger entry, no spend.
2. Attempt loop, at most 2 attempts:
   - (a) Gate the prompt. `fail` or `unknown` blocks; an unknown gate gives plain words and logs the raw reason. This mirrors 3a's `paidStill`.
   - (b) Generate with the current engine. If Veo is refused with `CONTENT_BLOCKED` and this run has not fallen back yet, ledger the Veo attempt as `retried` (its credits are refunded by the item, so `creditsMicro` is `'0'`), switch to `engine = 'omni'` and `fallback = true`, rebuild the prompt with `clipPrompt(..., 'omni')`, gate it, and generate once with Omni. That Omni call does NOT use up the check retry.
   - (c) No fileId → `failed` (insufficient credits → "not enough credits"; else "the clip could not be made").
   - (d) `localFile` → `trimToFrames(local, spec.frames, out, size)`.
   - (e) `checkClip(...)`. pass → `passed`/kept; unknown → `unchecked`/kept, never retried; fail on attempt 0 → ledger `retried`, append `Fix: <reasons>` to the prompt and retry with the same engine; fail on attempt 1 → `failed`, keeping the trimmed clip path so the user sees it.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/paidClip.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeClip, clipSlot, type ClipCtx } from './paidClip.js'
import { clipSpecs } from './clipSpec.js'
import { writePlan } from './plan.js'
import { breakdown } from './fixtures.testing.js'
import type { RemakeDeps } from './deps.js'

const brand = { name: 'B', product: 'p' }
const pass = { name: 'x', status: 'pass' as const, reason: '', evidenceTimes: [] }
async function setup(o: Partial<RemakeDeps> = {}) {
  const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
  const specs = clipSpecs(plan, [
    { look: 1, kind: 'start', fileId: 's1', status: 'passed', reasons: [] },
    { look: 2, kind: 'start', fileId: 's2', status: 'passed', reasons: [] },
    { look: 2, kind: 'end', fileId: 'e2', status: 'passed', reasons: [] },
  ])
  let n = 0
  const deps = {
    promptGate: vi.fn(async () => pass),
    generateVeoClip: vi.fn(async () => ({ fileId: `veo-${++n}`, creditsUsedMicro: '160' })),
    generateOmniClip: vi.fn(async () => ({ fileId: `omni-${++n}`, creditsUsedMicro: '100' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    trimToFrames: vi.fn(async (_i: string, _f: number, out: string) => out),
    poseClip: vi.fn(), sample: vi.fn(),
    ...o,
  } as unknown as RemakeDeps
  const check = vi.fn(async () => pass)
  const ctx: ClipCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({}), portrait: null, plan, brand, size: { width: 720, height: 1280 }, workDir: '/tmp/x', check }
  return { plan, specs, deps, ctx, check }
}

describe('makeClip', () => {
  it('Veo between two stills, trimmed to the look frames, kept when checks pass', async () => {
    const { specs, deps, ctx } = await setup()
    const r = await makeClip(specs[1], ctx, deps)
    expect(r.result).toMatchObject({ look: 2, engine: 'veo', fallback: false, status: 'passed', fileId: 'veo-1' })
    expect(deps.generateVeoClip).toHaveBeenCalledWith(expect.objectContaining({ startImageFileId: 's2', endImageFileId: 'e2', durationSeconds: 6 }), expect.anything(), clipSlot(2, 0, false))
    expect(deps.trimToFrames).toHaveBeenCalledWith('/m/veo-1', specs[1].frames, expect.any(String), { width: 720, height: 1280 })
    expect(r.ledger).toEqual([{ item: 'look 2 clip', attempt: 0, creditsMicro: '160', outcome: 'kept' }])
  })
  it('Veo refused → exactly one Omni attempt from the start still, gated, marked fallback (Review Focus 3)', async () => {
    const { specs, deps, ctx } = await setup({ generateVeoClip: vi.fn(async () => ({ refused: true, refusalReason: 'CONTENT_BLOCKED' })) } as never)
    const r = await makeClip(specs[1], ctx, deps)
    expect(deps.generateVeoClip).toHaveBeenCalledTimes(1)
    expect(deps.generateOmniClip).toHaveBeenCalledWith(expect.objectContaining({ startImageFileId: 's2', durationSeconds: 6 }), expect.anything(), clipSlot(2, 0, true))
    expect(deps.promptGate).toHaveBeenCalledTimes(2)
    expect(r.result).toMatchObject({ engine: 'omni', fallback: true, status: 'passed' })
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'kept'])
  })
  it('retries a failed check once with the reasons, then stops', async () => {
    const { specs, deps, ctx, check } = await setup()
    check.mockResolvedValue({ ...pass, status: 'fail', reason: 'end pose: knees bent' } as never)
    const r = await makeClip(specs[0], ctx, deps)
    expect(deps.generateOmniClip).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.generateOmniClip).mock.calls[1][0].prompt).toMatch(/Fix: end pose: knees bent$/)
    expect(r.result.status).toBe('failed')
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'failed'])
  })
  it('never retries on unknown', async () => {
    const { specs, deps, ctx, check } = await setup()
    check.mockResolvedValue({ ...pass, status: 'unknown', reason: 'the clip could not be checked this time' } as never)
    const r = await makeClip(specs[0], ctx, deps)
    expect(deps.generateOmniClip).toHaveBeenCalledTimes(1)
    expect(r.result.status).toBe('unchecked')
  })
  it('a blocked gate pays nothing; a look with no clip pays nothing', async () => {
    const { specs, deps, ctx } = await setup({ promptGate: vi.fn(async () => ({ ...pass, status: 'unknown', reason: 'check unavailable: gateway 503' })) } as never)
    const r = await makeClip(specs[0], ctx, deps)
    expect(r.result.status).toBe('blocked')
    expect(r.result.reasons.join(' ')).not.toMatch(/gateway|503/)
    expect(deps.generateOmniClip).not.toHaveBeenCalled()
    const none = await makeClip({ ...specs[0], engine: 'none', reason: 'this part is too long to animate yet, so it stays a still' }, ctx, deps)
    expect(none.result.status).toBe('still')
    expect(none.ledger).toEqual([])
  })
})

it('clip slots never collide with each other or with still slots (< 1000)', () => {
  const all = [1, 2, 3, 40].flatMap((n) => [0, 1].flatMap((a) => [false, true].map((f) => clipSlot(n, a, f))))
  expect(new Set(all).size).toBe(all.length)
  expect(Math.min(...all)).toBeGreaterThanOrEqual(1000)
})
```

`ClipCtx` = `{ tenantId; idToken; scopeId; runId; exec(slot); portrait: Img | null; plan: RemakePlan; brand: Brand; size: { width; height }; workDir: string; check: (clipPath: string, spec: ClipSpec) => Promise<CheckResult> }`. The workflow binds `check` to `checkClip` with the real deps; the tests inject it.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/paidClip.test.ts`
Expected: FAIL with `Failed to resolve import "./paidClip.js"`.

- [ ] **Step 3: Implement `paidClip.ts`** and extend `deps.ts`.

```ts
// apps/agent-orchestrator/src/mastra/remake/paidClip.ts
// One paid clip, money-safe (spec §8a, rule 11): gate before every paid call; Veo refused →
// one Omni attempt from the start still; trim to exact frames; check; one retry; ledger.
import { join } from 'node:path'
import type { MediaExecContext } from '../tools/batchRunner.js'
import type { Img } from '../tools/tvcChecks.js'
import type { CheckResult } from '../scorers/video/gate.js'
import type { RemakeDeps } from './deps.js'
import { clipPrompt, clipGateInput, type ClipSpec } from './clipSpec.js'
import type { Brand, LedgerEntry, RemakePlan } from './types.js'

export const clipSlot = (n: number, attempt: number, fallback: boolean): number => 1000 + n * 8 + attempt * 2 + (fallback ? 1 : 0)

export interface ClipResult { look: number; fileId: string | null; localPath: string | null; engine: 'veo' | 'omni' | 'none'; fallback: boolean; status: 'passed' | 'failed' | 'unchecked' | 'blocked' | 'still'; reasons: string[] }
export interface ClipCtx {
  tenantId: string; idToken: string; scopeId: string; runId: string
  exec: (slot: number) => MediaExecContext
  portrait: Img | null; plan: RemakePlan; brand: Brand
  size: { width: number; height: number }; workDir: string
  check: (clipPath: string, spec: ClipSpec) => Promise<CheckResult>
}

const aspect = (s: { width: number; height: number }): '9:16' | '16:9' => (s.height >= s.width ? '9:16' : '16:9')

export async function makeClip(spec: ClipSpec, ctx: ClipCtx, deps: RemakeDeps): Promise<{ result: ClipResult; ledger: LedgerEntry[] }> {
  const n = spec.look.n
  const item = `look ${n} clip`
  const ledger: LedgerEntry[] = []
  let engine: 'veo' | 'omni' = spec.engine === 'veo' ? 'veo' : 'omni'
  let fallback = false
  const base = () => ({ look: n, engine: spec.engine === 'none' ? 'none' as const : engine, fallback })
  if (spec.engine === 'none' || !spec.start) return { result: { ...base(), fileId: null, localPath: null, status: 'still', reasons: [spec.reason ?? 'this part stays a still'] }, ledger }

  let prompt = clipPrompt(ctx.plan, spec.look, ctx.brand, engine)
  let last: { fileId: string; localPath: string; reasons: string[] } | null = null
  const gate = async (p: string) => {
    const g = await deps.promptGate({ ...clipGateInput(ctx.plan, spec.look, p), tenantId: ctx.tenantId })
    if (g.status === 'unknown') console.error(`[remake] ${item} prompt check unavailable: ${g.reason}`)
    return g.status === 'pass' ? null : (g.status === 'unknown' ? 'the clip couldn’t be checked before making it, so it wasn’t made' : g.reason)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const blocked = await gate(prompt)
    if (blocked) {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
      return { result: last ? { ...base(), fileId: last.fileId, localPath: last.localPath, status: 'failed', reasons: last.reasons } : { ...base(), fileId: null, localPath: null, status: 'blocked', reasons: [blocked] }, ledger }
    }
    const title = `Remake look ${n} clip`
    const call = (e: 'veo' | 'omni', p: string) => (e === 'veo'
      ? deps.generateVeoClip({ prompt: p, startImageFileId: spec.start!, endImageFileId: spec.end ?? undefined, durationSeconds: spec.seconds as 4 | 6 | 8, aspectRatio: aspect(ctx.size), title }, ctx.exec(clipSlot(n, attempt, fallback)), clipSlot(n, attempt, fallback))
      : deps.generateOmniClip({ prompt: p, startImageFileId: spec.start!, durationSeconds: spec.seconds, aspectRatio: aspect(ctx.size), title }, ctx.exec(clipSlot(n, attempt, fallback)), clipSlot(n, attempt, fallback)))
    let g = await call(engine, prompt)
    if (engine === 'veo' && !g.fileId && g.refusalReason === 'CONTENT_BLOCKED' && !fallback) {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'retried' })
      engine = 'omni'; fallback = true
      prompt = clipPrompt(ctx.plan, spec.look, ctx.brand, 'omni')
      const again = await gate(prompt)
      if (again) {
        ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
        return { result: { ...base(), fileId: null, localPath: null, status: 'blocked', reasons: [again] }, ledger }
      }
      g = await call('omni', prompt)
    }
    const spent = g.creditsUsedMicro ?? '0'
    if (!g.fileId) {
      if (!g.insufficientCredits) console.error(`[remake] ${item} not made: ${g.refusalReason ?? 'unknown'}`)
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'failed' })
      return { result: { ...base(), fileId: last?.fileId ?? null, localPath: last?.localPath ?? null, status: 'failed', reasons: [g.insufficientCredits ? 'not enough credits' : 'the clip could not be made'] }, ledger }
    }
    const local = await deps.localFile(g.fileId, ctx.idToken, ctx.scopeId)
    const trimmed = await deps.trimToFrames(local, spec.frames, join(ctx.workDir, `look-${n}-a${attempt}.mp4`), ctx.size)
    const c = await ctx.check(trimmed, spec)
    if (c.status !== 'fail') {
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'kept' })
      return { result: { ...base(), fileId: g.fileId, localPath: trimmed, status: c.status === 'pass' ? 'passed' : 'unchecked', reasons: c.status === 'pass' ? [] : [c.reason] }, ledger }
    }
    ledger.push({ item, attempt, creditsMicro: spent, outcome: attempt === 0 ? 'retried' : 'failed' })
    last = { fileId: g.fileId, localPath: trimmed, reasons: [c.reason] }
    prompt = `${clipPrompt(ctx.plan, spec.look, ctx.brand, engine)} Fix: ${c.reason}`
  }
  return { result: { ...base(), fileId: last!.fileId, localPath: last!.localPath, status: 'failed', reasons: last!.reasons }, ledger }
}
```

In `deps.ts`, add the new members to `RemakeDeps` and `real`. Real implementations:

```ts
  generateVeoClip: (input, exec, index) => generateVeoClipItem(input, exec, index),
  generateOmniClip: (input, exec, index) => generateVideoItem({ mode: 'animate_frame', prompt: input.prompt, aspectRatio: input.aspectRatio, durationSeconds: input.durationSeconds, startImageFileId: input.startImageFileId, title: input.title } as never, exec, index),
  poseClip: (path, seconds) => aiService<PoseResult>('/media/pose', { path, looks: [{ label: 'clip', start_s: 0, end_s: seconds }] }),
  sample: (path, times) => sampleFrames(path, times, mkdtempSync(join(tmpdir(), 'remake-sample-'))),
  trimToFrames: (i, f, o, s) => trimToFrames(i, f, o, s),
  clipRateMicro: async (engine) => { const r = await resolveRate('video_generation', engine === 'veo' ? VEO_CLIP_MODEL : VIDEO_MODEL); return r ? costMicro(r.schema, { count: 1 }) : null },
  musicRateMicro: async () => { const r = await resolveRate('music_generation', 'lyria-002'); return r ? costMicro(r.schema, { count: 1 }) : null },
  generateMusic: async (prompt, exec) => (await generateSong.execute!({ prompt, title: 'Remake music' } as never, exec as never)) as never,
  compare: (breakdown, remakeFileId, ctx, tenantId) => compareToReference({ fileId: breakdown.video.fileId }, remakeFileId, ctx, tenantId, breakdown),
```

(`compareToReference`'s fifth parameter comes from Task 8; until then, type `compare` but leave its body calling the four-argument form, and Task 8 adds the fifth.) Check `generateVideoItem`'s `title` field type (`fileTitleSchema`) and `generateSong.execute`'s context type when wiring; ledger any ruling.

- [ ] **Step 4: Run the tests to verify they pass; type-check**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/ && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/
git commit -m "feat(remake): money-safe clip: gate, Veo→Omni once on a content block, exact trim, measured checks, one retry"
```

---

### Task 7: Music prompt (`music.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/remake/music.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/music.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/remake/types.ts` and `plan.ts` (`RemakeReference.music`)

**Interfaces:**
- Produces:
  - `RemakeReference.music: { mood: string; genre: string; instruments: string; hasVocals: boolean | null; songName: string | null }` (from `overview.music`);
  - `export function musicPrompt(plan: RemakePlan): string`: an instrumental in the reference's mood, genre and instruments, or the plan's `sound.music` swap text when the user edited it; never the song name or artist (§9a).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/music.test.ts
import { it, expect, vi } from 'vitest'
import { musicPrompt } from './music.js'
import { writePlan, applyEdits } from './plan.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }

it('an instrumental in the reference mood and genre, never the song itself', async () => {
  const b = breakdown(); b.overview.music = { mood: 'upbeat', genre: 'pop', instruments: 'synth, claps', has_vocals: true, song_name: 'Famous Song' }
  const p = musicPrompt(await writePlan(b, brand, vi.fn().mockResolvedValue({ lines: [] })))
  expect(p).toMatch(/instrumental/i)
  expect(p).toMatch(/upbeat/)
  expect(p).toMatch(/synth, claps/)
  expect(p).not.toMatch(/Famous Song/)
  expect(p).toMatch(/no vocals/i)
})

it("uses the user's music swap when they edited it", async () => {
  const plan = applyEdits(await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] })), [{ ref: 'sound.music', action: 'swap', to: 'calm lo-fi piano' }], brand)
  expect(musicPrompt(plan)).toMatch(/calm lo-fi piano/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/music.test.ts`
Expected: FAIL with `Failed to resolve import "./music.js"`.

- [ ] **Step 3: Implement.** In `types.ts`, add `music: { mood: string; genre: string; instruments: string; hasVocals: boolean | null; songName: string | null }` to `RemakeReference`. In `plan.ts` `referenceOf`, set `music: { mood: o.music.mood, genre: o.music.genre, instruments: o.music.instruments, hasVocals: o.music.has_vocals, songName: o.music.song_name }`. Fix the 3a tests that construct a `RemakeReference` by hand, if any; `tsc` will show them.

```ts
// apps/agent-orchestrator/src/mastra/remake/music.ts
// New music in the reference's mood (spec §9a): the original track is never copied.
import type { RemakePlan } from './types.js'

export function musicPrompt(plan: RemakePlan): string {
  const swap = plan.lines.find((l) => l.ref === 'sound.music')
  const m = plan.reference.music
  const userWords = swap?.action === 'swap' && swap.to && !swap.to.startsWith('new music, same mood') ? swap.to : null
  const feel = userWords ?? [m.mood, m.genre].filter(Boolean).join(' ')
  const instruments = !userWords && m.instruments ? `, with ${m.instruments}` : ''
  return `An original instrumental track, ${feel || 'light and modern'}${instruments}. No vocals, no lyrics. A steady beat suited to a short social video.`
}
```

- [ ] **Step 4: Run the tests to verify they pass, plus all remake tests and tsc**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/ && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/
git commit -m "feat(remake): music prompt in the reference mood, never the original song"
```

---

### Task 8: Final checks without a repeat breakdown, and the difference note

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/compareToReference.ts` (optional known breakdown)
- Modify: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/compareToReference.test.ts` (one test)
- Create: `apps/agent-orchestrator/src/mastra/remake/finalNote.ts`
- Test: `apps/agent-orchestrator/src/mastra/remake/finalNote.test.ts`

**Interfaces:**
- Produces:
  - `compareToReference(refInput, remakeFileId, ctx, tenantId?, known?: Breakdown)`: when `known` is given, it is used instead of `recentBreakdown`/`breakDownVideo` (no repeat paid breakdown);
  - `export function differenceNote(o: { plan: RemakePlan; stills: StillResult[]; clips: ClipResult[]; checks: CheckResult[] | null }): string`: plain words, one short line per item.

What the difference note says:
1. What changed on purpose: the plan's swaps and drops, for example "Changed on purpose: outfit in part 1 → yellow Bubbli tee; reference text left out."
2. Parts that stayed stills, and why (from clips with status `still`/`blocked`/`failed`).
3. Parts made with the backup method: "part 2 was animated a simpler way after the first try was refused".
4. Checks that did not pass, by plain name; unknown → "couldn't be checked".
5. `checks === null` → "The comparison with the original couldn't be run this time." (Review Focus 5).
6. Always last: "Label it as AI-generated when you post it."

It never contains "Veo", "Omni", "Gemini", "Lyria", "ai-service" or "gateway".

- [ ] **Step 1: Write the failing tests**

Add to `compareToReference.test.ts`, using its existing mocks:

```ts
it('uses a known breakdown instead of breaking the reference down again', async () => {
  // In this file's mock setup, breakDownVideo/recentBreakdown are vi.fn()s: assert neither is called.
  const known = /* the file's existing breakdown fixture */ undefined as never
  await compareToReference({ fileId: 'ref' }, 'remake', ctx, 't1', known)
  expect(breakDownVideo).not.toHaveBeenCalled()
})
```

Adapt it to the file's actual fixture and mock names. Read the file first, and use its breakdown fixture as `known`.

```ts
// apps/agent-orchestrator/src/mastra/remake/finalNote.test.ts
import { it, expect, vi } from 'vitest'
import { differenceNote } from './finalNote.js'
import { writePlan, applyEdits } from './plan.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }
const plan = async () => applyEdits(await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] })), [{ ref: 'looks[0].outfit', action: 'swap', to: 'yellow tee' }], brand)

it('says what changed on purpose, what stayed a still, the fallback, failed checks, and the AI label', async () => {
  const note = differenceNote({
    plan: await plan(),
    stills: [],
    clips: [
      { look: 1, fileId: 'c1', localPath: '/x', engine: 'omni', fallback: true, status: 'passed', reasons: [] },
      { look: 2, fileId: null, localPath: null, engine: 'none', fallback: false, status: 'still', reasons: ['this part is too long to animate yet, so it stays a still'] },
    ],
    checks: [{ name: 'brightness-jumps', status: 'fail', reason: 'reference 0, remake 1', evidenceTimes: [] }, { name: 'same-person', status: 'unknown', reason: 'x', evidenceTimes: [] }],
  })
  expect(note).toMatch(/yellow tee/)
  expect(note).toMatch(/part 2.*too long/i)
  expect(note).toMatch(/part 1.*simpler way/i)
  expect(note).toMatch(/brightness/i)
  expect(note).toMatch(/couldn’t be checked/)
  expect(note.trim().split('\n').pop()).toMatch(/AI-generated/)
  expect(note).not.toMatch(/veo|omni|gemini|lyria|ai-service|gateway/i)
})

it('a comparison that could not run is said plainly, never as a match (Review Focus 5)', async () => {
  const note = differenceNote({ plan: await plan(), stills: [], clips: [], checks: null })
  expect(note).toMatch(/couldn’t be run this time/)
  expect(note).not.toMatch(/matches/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/finalNote.test.ts src/mastra/tools/videoBreakdown/compareToReference.test.ts`
Expected: FAIL. `finalNote.js` doesn't exist, and the compare test sees `breakDownVideo` called (or a type error on the fifth argument).

- [ ] **Step 3: Implement.** In `compareToReference.ts`, add the parameter `known?: Breakdown` and change the first line to `const reference = known ?? recentBreakdown(refInput, ctx) ?? await breakDownVideo(refInput, ctx, tenantId)`. In `deps.ts`, pass the breakdown as the fifth argument.

```ts
// apps/agent-orchestrator/src/mastra/remake/finalNote.ts
// The "what differs from the reference" note (spec §1.7, §3.5): plain words, nothing
// presented as fine that isn't, and the AI-label reminder (§11).
import type { CheckResult } from '../scorers/video/gate.js'
import type { ClipResult } from './paidClip.js'
import type { RemakePlan, StillResult } from './types.js'

const CHECK_WORDS: Record<string, string> = { 'brightness-jumps': 'sudden brightness changes', 'same-person': 'same person throughout' }
const plainCheck = (name: string) => CHECK_WORDS[name] ?? name.replace(/@[\d.]+$/, '').replace(/-/g, ' ')
const part = (ref: string) => ref.replace(/^looks\[(\d+)\]\.(\w+)$/, (_m, i, f) => `${f} in part ${Number(i) + 1}`)

export function differenceNote(o: { plan: RemakePlan; stills: StillResult[]; clips: ClipResult[]; checks: CheckResult[] | null }): string {
  const lines: string[] = []
  const changed = o.plan.lines.filter((l) => !l.auto && (l.action === 'swap' || l.action === 'drop') && l.ref !== 'sound.music' && l.ref !== 'cast')
    .map((l) => (l.action === 'swap' ? `${part(l.ref)} → ${l.to}` : `${part(l.ref)} left out`))
  if (changed.length) lines.push(`Changed on purpose: ${changed.join('; ')}.`)
  lines.push('New music in the same mood (the original song is never used).')
  for (const c of o.clips) {
    if (c.status === 'still' || c.status === 'blocked') lines.push(`Part ${c.look} stays a still: ${c.reasons.join('; ')}.`)
    else if (c.status === 'failed') lines.push(`Part ${c.look} didn’t pass its checks after a second try: ${c.reasons.join('; ')}.`)
    else if (c.status === 'unchecked') lines.push(`Part ${c.look} couldn’t be fully checked.`)
    if (c.fallback) lines.push(`Part ${c.look} was animated a simpler way after the first try was refused.`)
  }
  if (o.checks === null) lines.push('The comparison with the original couldn’t be run this time.')
  else {
    const fails = o.checks.filter((c) => c.status === 'fail').map((c) => plainCheck(c.name))
    const unknown = o.checks.filter((c) => c.status === 'unknown').map((c) => plainCheck(c.name))
    if (fails.length) lines.push(`Differs from the original on: ${[...new Set(fails)].join(', ')}.`)
    if (unknown.length) lines.push(`These couldn’t be checked: ${[...new Set(unknown)].join(', ')}.`)
  }
  lines.push('Label it as AI-generated when you post it.')
  return lines.join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/finalNote.test.ts src/mastra/tools/videoBreakdown/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/finalNote.ts apps/agent-orchestrator/src/mastra/remake/finalNote.test.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/compareToReference.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/compareToReference.test.ts apps/agent-orchestrator/src/mastra/remake/deps.ts
git commit -m "feat(remake): final checks reuse the plan's breakdown; plain difference note with the AI-label reminder"
```

---

### Task 9: Workflow: preview review, clips, finish (+ clip cost estimate)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/remake/workflow.ts`
- Modify: `apps/agent-orchestrator/src/mastra/remake/cost.ts` (`estimateClipsCost`)
- Test: `apps/agent-orchestrator/src/mastra/remake/workflow3b.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/remake/workflow.test.ts` and `reviewFixes.test.ts` (the run now pauses at `preview_review`, so tests that expected `success` after the pick expect `suspended` with stage `preview_review`)

**Interfaces:**
- Produces:
  - **The preview step** keeps its 3a work, then suspends `{ stage: 'preview_review', previewFileId, stills, summary, clipsEstimate, cantAnimate?: string }`. Resume: `{ decision: 'approve' | 'stop' }`. `stop` ends the run successfully with the preview output, the same as 3a. `cantAnimate` is set (plain words) when `plan.aspectRatio === '1:1'`, and then `approve` ends the run as `stop` does, with no spend (Review Focus 2).
  - `estimateClipsCost(specs: ClipSpec[], rates: { veo: bigint | null; omni: bigint | null; music: bigint | null }): { clips: number; firstPassMicro: string | null; maxMicro: string | null }`:
    - first pass = Σ the clip rate per non-`none` spec, plus the music;
    - max = Σ 2 × the clip rate, plus a Veo spec's fallback (Veo + Omni + Omni retry, so a Veo spec maximum is `veo + 2 × omni`, else `2 × omni`), plus the music;
    - `null` when any needed rate is missing.
  - **The `clips` step** (after the preview step): `clipSpecs(plan, stills)`, then `makeClip` for each, at most 3 at once. Each job is wrapped (a throw becomes `failed` with "this part could not be animated this time", as in 3a's I1). The ledger is appended.
  - **The `finish` step:**
    1. For each look in time order: a passed, unchecked or failed clip → its `localPath`; else `stillToFrames(localFile(start still), frames)`.
    2. `joinSegments`.
    3. Music: gate `musicPrompt(plan)` (planLine `music: …`); `generateMusic`; on success `fitMusic` to the total length and `muxMusic`. A music failure delivers the video silent, with a note line "the music couldn't be made this time". The music goes in the ledger.
    4. Upload the final mp4 (`generatedFileKey(conversationId, "remake <runId> final", 'mp4')`).
    5. `compare(breakdown, finalFileId, ctx, tenantId)` → its checks, or `null` on a throw.
    6. `differenceNote`.
  - **Workflow output:** `{ finalFileId, previewFileId, clips, stills, ledger, summary, note, plan }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/remake/workflow3b.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { RequestContext } from '@mastra/core/request-context'
import { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } from './instance.js'
import { setRemakeDeps, type RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'B', product: 'p' }
const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); return r }
const pass = { name: 'x', status: 'pass', reason: '', evidenceTimes: [] }
let n = 0
const sameBody = () => { const b = breakdown(); b.pose!.looks[1] = { ...b.pose!.looks[1], main_start: b.pose!.looks[0].main_start }; return b }
function deps(o: Partial<RemakeDeps> = {}): Partial<RemakeDeps> {
  const body = breakdown().pose!.looks[0].main_start
  return {
    ask: () => vi.fn().mockResolvedValue({ lines: [] }),
    generateStill: vi.fn(async () => ({ fileId: `img-${++n}`, creditsUsedMicro: '10' })),
    fetchImage: vi.fn(async () => ({ data: 'AA', mime: 'image/jpeg' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
    poseImage: vi.fn(async () => ({ model: 'm', people: 1, no_person: false, main: body })),
    promptGate: vi.fn(async () => pass),
    stillChecks: vi.fn(async () => ({ passed: true, reasons: [] })),
    ffmpeg: vi.fn(async () => undefined), readFile: vi.fn(() => Buffer.from('x')),
    renderPreview: vi.fn(async () => '/m/preview.mp4'),
    imageRateMicro: vi.fn(async () => 10n),
    clipRateMicro: vi.fn(async (e: 'veo' | 'omni') => (e === 'veo' ? 160n : 100n)),
    musicRateMicro: vi.fn(async () => 8n),
    generateVeoClip: vi.fn(async () => ({ fileId: `veo-${++n}`, creditsUsedMicro: '160' })),
    generateOmniClip: vi.fn(async () => ({ fileId: `omni-${++n}`, creditsUsedMicro: '100' })),
    trimToFrames: vi.fn(async (_i: string, _f: number, out: string) => out),
    poseClip: vi.fn(async () => ({ model: 'm', moves: [], camera_moves: [], looks: [{ label: 'clip', start_s: 0, end_s: 6, frames_used: 9, people: 1, people_max: 1, no_person: false, main_start: body, main_end: body, leg_side_start: 'center', leg_side_end: 'center', body_angle_end: 0, key_frames: [] }] })),
    sample: vi.fn(async () => [{ data: 'AA', mime: 'image/jpeg' }]),
    generateMusic: vi.fn(async () => ({ fileId: 'music-1', creditsUsedMicro: '8' })),
    compare: vi.fn(async () => ({ checks: [pass], brightnessJumps: null, summary: 'ok' })),
    stillToFrames: vi.fn(async (_s: string | null, _f: number, out: string) => out),
    joinSegments: vi.fn(async (_p: string[], out: string) => out),
    fitMusic: vi.fn(async (_m: string, _s: number, out: string) => out),
    muxMusic: vi.fn(async (_v: string, _m: string, out: string) => out),
    ...o,
  } as Partial<RemakeDeps>
}
const wf = async () => ({ w: (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID) })
const resume = async (id: string, step: string, data: unknown) => (await (await wf()).w.createRun({ runId: id })).resume({ step, resumeData: data, requestContext: rc() })
async function toPreview(b = sameBody(), o: Partial<RemakeDeps> = {}) {
  setRemakeDeps(deps(o))
  const run = await (await wf()).w.createRun()
  await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand }, requestContext: rc() })
  await resume(run.runId, 'plan', { decision: 'approve' })
  const r = await resume(run.runId, 'cast', { pick: 1 })
  return { id: run.runId, r }
}
const payload = (r: unknown, step: string) => (r as { steps: Record<string, { suspendPayload?: Record<string, unknown> }> }).steps[step].suspendPayload!

beforeEach(() => { n = 0; setRemakeStorageForTests(new InMemoryStore()) })
afterEach(() => { setRemakeDeps(null); setRemakeStorageForTests(null) })

describe('3b workflow', () => {
  it('pauses at the preview with a clips + music estimate, before any clip is paid', async () => {
    const veo = vi.fn()
    const { r } = await toPreview(sameBody(), { generateVeoClip: veo } as never)
    expect(r.status).toBe('suspended')
    const p = payload(r, 'preview')
    expect(p.stage).toBe('preview_review')
    expect(p.clipsEstimate).toMatchObject({ clips: 2, firstPassMicro: '268' }) // omni 100 + veo 160 + music 8
    expect(veo).not.toHaveBeenCalled()
  })
  it('approve makes the clips, joins them with music, checks, and delivers with a note', async () => {
    const { id } = await toPreview()
    const done = await resume(id, 'preview', { decision: 'approve' })
    expect(done.status).toBe('success')
    const out = (done as unknown as { result: Record<string, unknown> }).result
    expect(out.finalFileId).toMatch(/^up:/)
    expect(String(out.note)).toMatch(/AI-generated/)
    expect((out.summary as { spentMicro: string }).spentMicro).toBe(String(10 + 30 + 100 + 160 + 8)) // sheet + 3 stills + clips + music
  })
  it('stop ends with the preview only, no clip spend', async () => {
    const omni = vi.fn()
    const { id } = await toPreview(sameBody(), { generateOmniClip: omni } as never)
    const done = await resume(id, 'preview', { decision: 'stop' })
    expect(done.status).toBe('success')
    expect(omni).not.toHaveBeenCalled()
  })
  it('a square reel can be previewed but not animated: approve spends nothing (Review Focus 2)', async () => {
    const b = sameBody(); b.video = { ...b.video, width: 1080, height: 1080 }
    const omni = vi.fn(); const veo = vi.fn()
    const { id, r } = await toPreview(b, { generateOmniClip: omni, generateVeoClip: veo } as never)
    expect(String(payload(r, 'preview').cantAnimate)).toMatch(/square/i)
    const done = await resume(id, 'preview', { decision: 'approve' })
    expect(done.status).toBe('success')
    expect(omni).not.toHaveBeenCalled(); expect(veo).not.toHaveBeenCalled()
  })
  it('music failing still delivers the video, silent, and says so', async () => {
    const { id } = await toPreview(sameBody(), { generateMusic: vi.fn(async () => ({ refused: true })) } as never)
    const out = ((await resume(id, 'preview', { decision: 'approve' })) as unknown as { result: { note: string; finalFileId: string } }).result
    expect(out.finalFileId).toBeTruthy()
    expect(out.note).toMatch(/music couldn’t be made/)
  })
  it('the comparison throwing still delivers, with a plain note (Review Focus 5)', async () => {
    const { id } = await toPreview(sameBody(), { compare: vi.fn(async () => { throw new Error('ai-service 500') }) } as never)
    const out = ((await resume(id, 'preview', { decision: 'approve' })) as unknown as { result: { note: string } }).result
    expect(out.note).toMatch(/couldn’t be run this time/)
    expect(out.note).not.toMatch(/ai-service/)
  })
})
```

`stillToFrames`, `joinSegments`, `fitMusic` and `muxMusic` also become `RemakeDeps` members (real = the `compose.ts` functions), so the workflow test needs no ffmpeg. Add them in this task.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/workflow3b.test.ts`
Expected: FAIL. The run ends `success` at the preview (no `preview_review`), and `clipsEstimate` is undefined.

- [ ] **Step 3: Implement.** Modify the preview step: after computing its output, compute:

```ts
    const specs = clipSpecs(plan, stills)
    const clipsEstimate = estimateClipsCost(specs, { veo: await deps.clipRateMicro('veo'), omni: await deps.clipRateMicro('omni'), music: await deps.musicRateMicro() })
    const cantAnimate = plan.aspectRatio === '1:1' ? 'Square videos can be previewed but not animated yet.' : undefined
```

and replace its `return { … }` with:

```ts
    if (!resumeData) return await suspend({ stage: 'preview_review', previewFileId, stills, summary: ledgerSummary(ledger), clipsEstimate, ...(cantAnimate ? { cantAnimate } : {}) })
    return { ...inputData, previewFileId: (suspendData?.previewFileId as string | null) ?? previewFileId, stop: resumeData.decision === 'stop' || !!cantAnimate }
```

The render must not run again on resume. Guard the render block with `if (!resumeData)` and read `previewFileId` from `suspendData` on resume. Then add:
- `clipsStep` (input: the preview output; skip with an empty `clips` array when `stop`);
- `finishStep` (when `stop`, output the preview-only shape `{ finalFileId: null, previewFileId, clips: [], stills, ledger, summary, note: '', plan }`).

Chain: `.then(planStep).then(castStep).then(stillsStep).then(previewStep).then(clipsStep).then(finishStep)`. Update `outputSchema`. The clips step reuses 3a's job-wrapping pattern, `MAX_PARALLEL = 3`, and binds `ctx.check = (path, spec) => checkClip({ clipPath: path, seconds: spec.frames / CLIP_FPS, look: spec.look, portrait, tenantId }, { poseClip: deps.poseClip, sample: deps.sample, gate: runGate })`. The finish step follows the order in Interfaces; everything after the upload is best-effort with plain note lines.

`estimateClipsCost` in `cost.ts`:

```ts
export function estimateClipsCost(specs: ClipSpec[], r: { veo: bigint | null; omni: bigint | null; music: bigint | null }) {
  const live = specs.filter((s) => s.engine !== 'none')
  const needVeo = live.some((s) => s.engine === 'veo')
  if (r.omni === null || r.music === null || (needVeo && r.veo === null)) return { clips: live.length, firstPassMicro: null, maxMicro: null }
  const first = live.reduce((t, s) => t + (s.engine === 'veo' ? r.veo! : r.omni!), 0n) + r.music
  const max = live.reduce((t, s) => t + (s.engine === 'veo' ? r.veo! + 2n * r.omni! : 2n * r.omni!), 0n) + r.music
  return { clips: live.length, firstPassMicro: String(first), maxMicro: String(max) }
}
```

Update the 3a tests that expected `success` right after `pick`: they now expect `suspended` at `preview`, with `payload(r,'preview').stage === 'preview_review'` and the same preview fields. Ledger this as a ruling (the 3a behaviour is intentionally extended).

- [ ] **Step 4: Run all remake tests and tsc**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/ && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/
git commit -m "feat(remake): preview review pause with a clips estimate; clips and finish steps (join, music, final checks, note)"
```

---

### Task 10: Tool + approval card: `approve_preview`, `stop`, `final_ready`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts` (card text, and the video subject for `approve_preview`)
- Test: `apps/agent-orchestrator/src/mastra/remake/remakeVideoTool.test.ts` (add tests), `reviewFixes.test.ts` (card test)

**Interfaces:**
- Produces:
  - **Tool actions:** adds `approve_preview` and `stop`. Both resume step `preview` with `{ decision: 'approve' | 'stop' }`.
  - **`requireApproval`:** true for `approve_preview` via `shouldRequireApproval({ resourceType: 'video_generation', subject: VEO_CLIP_MODEL }, ctx)`.
  - **Stages returned by `shapeRun`:**
    - `preview_review` → `{ previewFileId, stills, summary, clipsEstimate: { clips, firstPassCredits, maxCredits }, cantAnimate? }`;
    - `final_ready` → `{ finalFileId, note, summary }`.
  - **Card:** `GENERATION_APPROVAL_METADATA['remake_video']` gets a `subjectFor` that returns the Veo subject for `approve_preview` (else the image model), and `resourceTypeFor` (if the metadata type has no per-call resource type, add an optional `resourceTypeFor?: (args) => string` and read it in `chatStream.ts` where `resourceType` is used; check how chatStream reads the metadata first). `buildPreview` for `approve_preview`: "Animates every part of the remake (at most one automatic retry each), adds new music, checks it against the original and delivers the video, as estimated with the preview."

- [ ] **Step 1: Write the failing tests** (in `remakeVideoTool.test.ts`):

```ts
  it('approve_preview needs approval, priced as video; stop does not', async () => {
    const need = (action: string) => (remakeVideoTool.requireApproval as (i: unknown, c: unknown) => Promise<boolean>)({ action }, ctx())
    expect(await need('approve_preview')).toBe(true)
    expect(await need('stop')).toBe(false)
    const { shouldRequireApproval } = await import('../tools/generationApproval.js')
    expect(vi.mocked(shouldRequireApproval)).toHaveBeenCalledWith({ resourceType: 'video_generation', subject: 'google/veo-3.1-fast-generate-001' }, expect.anything())
  })
  it('shapes preview_review and final_ready', () => {
    expect(shapeRun('r', { status: 'suspended', steps: { preview: { suspendPayload: { stage: 'preview_review', previewFileId: 'p', stills: [], summary: { spentMicro: '0', wastedMicro: '0', failed: [], blocked: [] }, clipsEstimate: { clips: 2, firstPassMicro: '268000000', maxMicro: '468000000' } } } } }))
      .toMatchObject({ success: true, stage: 'preview_review', clipsEstimate: { clips: 2, firstPassCredits: '268.00', maxCredits: '468.00' } })
    expect(shapeRun('r', { status: 'success', result: { finalFileId: 'f', note: 'N', summary: { spentMicro: '1000000', wastedMicro: '0', failed: [], blocked: [] } } }))
      .toMatchObject({ success: true, stage: 'final_ready', finalFileId: 'f', note: 'N', summary: { spentCredits: '1.00' } })
  })
```

Add to `reviewFixes.test.ts`'s card test: `expect(meta.buildPreview!({ action: 'approve_preview' })).toMatch(/Animates every part/)` and `expect(meta.subjectFor!({ action: 'approve_preview' }, undefined)).toBe('google/veo-3.1-fast-generate-001')`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/remakeVideoTool.test.ts src/mastra/remake/reviewFixes.test.ts`
Expected: FAIL (unknown action / missing stage / missing card text).

- [ ] **Step 3: Implement.**
- Add the actions to the input enum.
- Map `approve_preview` to `['preview', { decision: 'approve' }]` and `stop` to `['preview', { decision: 'stop' }]`.
- Extend `requireApproval` and `shapeRun`. A `success` result with `finalFileId` → `final_ready`. With `finalFileId: null` (stopped) → `preview_ready`, as in 3a.
- Extend the description: after `preview_ready`/`preview_review`, show the preview and the clips cost; on agreement call `approve_preview`; `stop` ends with only the preview. When `final_ready`, share the video and the note exactly, and remind the user to label it as AI-generated.
- In `generationApproval.ts`, extend `remakePreview` and add `subjectFor`/`resourceTypeFor` as described, after reading how `chatStream.ts` consumes `GENERATION_APPROVAL_METADATA` (`grep -n "GENERATION_APPROVAL_METADATA" src/routes/chatStream.ts`). If chatStream reads `meta.resourceType` directly, add the per-call function there with a fallback to `meta.resourceType`, and test it in the same file's existing chatStream approval test if one exists. Ledger the exact change.

- [ ] **Step 4: Run all remake tests, the generationApproval tests and tsc**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/ src/mastra/tools/generationApproval.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/remake/ apps/agent-orchestrator/src/mastra/tools/generationApproval.ts apps/agent-orchestrator/src/routes/chatStream.ts
git commit -m "feat(remake): approve_preview (video-priced approval) and stop; final_ready with the difference note"
```

---

### Task 11: Skill step 9, deploy notes, full suite, live smoke

**Files:**
- Modify: `products/agent-platform/packages/api/seeds/official-skills/template-video.md` (append step 9)
- Modify: `docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md` (Phase 3b section)
- Modify: `apps/agent-orchestrator/src/mastra/remake/skillText.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `skillText.test.ts`:

```ts
it('step 9 covers the preview review, the clips approval and the delivery note, with no internals', () => {
  const step9 = skill.split(/^9\. /m)[1] ?? ''
  expect(step9).toMatch(/approve_preview/)
  expect(step9).toMatch(/stop/)
  expect(step9).toMatch(/AI-generated/)
  expect(step9).not.toMatch(/veo|omni|lyria|gemini|download|server|gateway/i)
  expect(skill).toMatch(/^8\. When the user wants that video remade/m) // append-only
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/remake/skillText.test.ts`
Expected: FAIL on the step 9 test.

- [ ] **Step 3: Append step 9** to `template-video.md`:

```markdown

9. When the preview is ready (adds to step 8): share the preview video, say plainly which stills failed or were held back, and give the cost of animating it (clips plus music) from the reply. If it says the video can't be animated yet, say so and stop there. Ask whether to animate it; if yes, call remake_video with action "approve_preview"; if the user only wanted the preview, call "stop". While it works (stage "working"), use "status" and never start the remake again. When it is done, share the final video and its note exactly as given (what changed on purpose, what stayed a still, anything that didn't pass), the credits spent, and remind the user to label it as AI-generated when they post it.
```

Then add this section to the DEPLOY doc:

```markdown
## Phase 3b (clips, music, final checks)

1. Pull main. Restart the **inference-gateway** (`pm2 restart inference-gateway`; adds Veo 3.1 first+last). Ask first.
2. Seed the Veo 3.1 rate: `cd packages/foundation/database && pnpm db:seed` (it versions rate changes). Check: `select subject, pricing_schema from credit_rates where subject = 'google/veo-3.1-fast-generate-001' and is_active` returns one row of 80 credits.
3. Check that the VM's Vertex project can call `veo-3.1-fast-generate-001` in us-central1 (the same service account as Omni). A 403 here means the model isn't enabled for the project.
4. Rebuild and restart the orchestrator (ask first). Re-seed official skills (template-video step 9): `pnpm --filter @serverless-saas/agent-api db:seed:official-skills`.
5. A restart during "working" (stills or clips) loses that run; runs waiting at the plan, the cast pick or the preview survive.
```

- [ ] **Step 4: Run the tests to verify they pass; run every suite**

Run:
- `cd apps/agent-orchestrator && npx vitest run > /tmp/remake3b-suite.txt 2>&1; tail -5 /tmp/remake3b-suite.txt && npx tsc --noEmit`
- `cd ../inference-gateway && npx vitest run && npx tsc --noEmit`

Expected: all pass, apart from failures that also fail on main (compare a run on the base commit); no type errors.

- [ ] **Step 5: Commit**

```bash
git add -f products/agent-platform/packages/api/seeds/official-skills/template-video.md docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md
git add apps/agent-orchestrator/src/mastra/remake/skillText.test.ts
git commit -m "docs(remake): template-video step 9 (animate after the preview) and Phase 3b deploy notes"
```

- [ ] **Step 6: Live smoke, after the VM deploy and with the user's go-ahead.** It spends real credits: about 2–4 clips plus music, at the 3b rates. Through the internal test MCP, as a user in chat:
  1. The fan reel remake (from 3a's smoke): at the preview, expect the clips estimate.
  2. Approve. Expect a final video exactly as long as the reference at 30fps, with new music (no original song), and a note in plain words ending with the AI-label reminder.
  3. Check every clip's start and end pose against the "Measured:" lines.
  4. Run `stop` on a second run. Expect no clip spend.
  5. Assess the outputs against the reference before calling it done.

---

## Self-review notes (writer)

- **Spec coverage for 3b:**
  - §5.4 steps 3 (clips: Veo first+last, Omni) and 4 (continuity is checked on clips: same person, empty hand);
  - §7 rules 5 (end pose checked), 8 and 9 (occluder/shared track: 3c, not here), 10 (clip checks), 11 (fallback), 12 (30fps exact);
  - §8 (clip checks; final `compare_to_reference` with brightness jumps, pose-legs, expression, same person);
  - §8a (gate before every paid call, retry cap, cost meter including clips and music);
  - §9a option 1 (generated music; the beat-cut edit is deferred, because looks are cut on the reference's measured times);
  - §11 (AI label in the note);
  - §1.7 (difference note).
- **Deferred to 3c or later:**
  - §9 recipes (occluder edge reveal, filmed plates), §9a option 2 (the "music slot" second export), cutting on beats;
  - rule 11's "retry once with plainer wording before falling back" (v1 falls back directly);
  - continuity edits before animating (§5.4.4).

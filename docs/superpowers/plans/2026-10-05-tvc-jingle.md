# TVC Ad Part B: the Sung Jingle (and K1/K2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a TVC ad end on a sung sign-off made by Lyria 3, cut and level-matched by tool code so a good result never depends on prompt text; and move Part A's two process-memory check records into Mastra thread metadata and its two face finders into one.

**Architecture:**
- **Gateway (`music.ts`):** a second code path for `lyria-3-clip-preview` (`generateContent`, location `global`, `responseModalities: ["AUDIO","TEXT"]`) that returns MP3 plus the timed lyrics text. The lyria-002 path is untouched.
- **Orchestrator, pure helpers:** `timedLyrics.ts` (parse `[start:end] text` lines, find the sign-off line) and `jingleCut.ts` (cut the sung line out with ffmpeg: lead-in, ring-out to the first silence, fades, 48 kHz stereo AAC).
- **`generate_jingle` tool:** charge first on a new `music_generation / lyria-3-clip-preview` rate, approval through `shouldRequireApproval`, gateway call, find the line, cut, upload both files; refund on every failure path. `generate_song` is unchanged.
- **Plan (`tvcPlan.ts`, `planTvc.ts`):** `brief.jingle`, recorded `jingleFileId` / `signoffFileId` / `signoffSeconds`, the timing rules, and the finish slice's `signoffStartSeconds` / `musicFadeOutAtSeconds`.
- **Mixing:** `mix_voiceover` blocks gain `kind: 'jingle'` (level-matched, never ducking); `mix_music_bed` gains `fadeOutAtSeconds`.
- **K1:** `tvcCheckRecords.ts` keeps `check_still`'s passed stills and `check_clip`'s re-check guard in the conversation thread's metadata through `getOlmoMemory()`'s `getThreadById` / `updateThread`, with an ownership guard.
- **K2:** `findFaces.ts`, one native `box_2d` face finder; `crop_image` takes the largest box, `faceBoxes` returns them all.

**Tech Stack:** TypeScript, Mastra `createTool` and `Memory` (`@mastra/core` 1.64, `@mastra/memory` 1.28, `@mastra/pg` `PostgresStoreVNext`), zod, vitest, ffmpeg/ffprobe via `execFile`, Vertex AI `lyria-3-clip-preview` through the inference gateway's `/v1/music/generations`, gemini-3.6-flash through the gateway's `/v1/chat/completions`.

**Spec:** `docs/superpowers/specs/2026-10-05-tvc-jingle-design.md` (J1–J7, K1, K2, §4–§6). Read it before your task.

## Global Constraints

- **Additive prompt changes only:** never delete or reword a shipped line in any skill or agent prompt. Append lines, and edit only the TVC files (`tvc-ad.md`, `tvc-ad/director.md`).
- **Paid tools:** charge first and refund on every failure path. Any key built from a tool-call id goes through `stableToolCallId()` (`apps/agent-orchestrator/src/credits.ts`).
- **No automatic paid redo:** the only redo is the one documented retry after a refunded `JINGLE_LINE_NOT_SUNG`.
- **Existing callers unchanged:**
  - lyria-002 requests are byte-identical (same URL, same headers, same body `{"instances":[{"prompt":...}]}`), and `generate_song` is not edited.
  - `mix_voiceover` called without `kind` builds a byte-identical filter graph.
  - `mix_music_bed` called without `fadeOutAtSeconds` builds a byte-identical filter graph.
  - A plan without `brief.jingle` validates, slices (`JSON.stringify` of every slice) and prices exactly as before.
  - `crop_image`'s existing tests (`cropImage.test.ts`) pass unchanged; the file is not edited.
- **Lyria 3 facts (verified 2026-10-05):** model `lyria-3-clip-preview`, location `global` only, `POST https://aiplatform.googleapis.com/v1/projects/{p}/locations/global/publishers/google/models/lyria-3-clip-preview:generateContent` with `generationConfig.responseModalities: ["AUDIO","TEXT"]` (without that field Vertex returns a bare 400). It returns a ~30.77 s MP3 plus text parts with lines like `[9.4:14.9] Chai Nation, mazaa baar baar`. $0.04 per clip = `per_call_micro: 4_000_000` (1 credit = 1 US cent = 1 000 000 micro).
- **Cut and mix numbers (copied from the spec):**
  - Cut starts at the sung line's start − 0.15 s.
  - It ends at the first silence after the line's end (`silencedetect=noise=-35dB:d=0.25`), capped at the line end + 2.0 s.
  - 0.9 s fade-out, 20 ms fade-in; output 48 kHz stereo AAC.
  - Level match: integrated loudness (ebur128) of the mixed audio in the 5 s before the jingle block. With speech there, target = that loudness; otherwise target = it + 2 LU. Gain clamped to ±12 dB.
  - Music bed: 0.5 s fade ending at `fadeOutAtSeconds` = sign-off start − 0.3 s.
- **Plan rules:** sign-off start = `lengthSeconds − signoffSeconds` (computed, never chosen by Director). It starts ≥ 0.75 s after the last speech, or record refuses `JINGLE_OVERLAPS_SPEECH`. A sign-off longer than the packshot + 2 s is refused (`JINGLE_TOO_LONG`).
- **Plain reasons:** `JINGLE_LINE_NOT_SUNG: Lyria did not sing "<line>"; try once more or shorten the line`, `JINGLE_OVERLAPS_SPEECH: the sung line would start <x>s after the last word; shorten the line or end the voiceover earlier`, `JINGLE_TOO_LONG`, `CONTENT_BLOCKED`. Plumbing reasons added by this plan: `JINGLE_CUT_FAILED`, `JINGLE_RECORD_INCOMPLETE`, `NO_JINGLE_IN_PLAN`, `CHECK_RECORD_UNAVAILABLE`.
- **Memory (K1):**
  - Use `getOlmoMemory()` only. Never `getMastraMemory()`, and never change any memory scope (read the cross-tenant warning above `getOlmoMemory` in `apps/agent-orchestrator/src/mastra/memory.ts`).
  - Never write a thread that is missing or whose `resourceId` is not this request's `tenantId`.
  - The thread is `requestContext.get('conversationId')`. This is the Mastra thread id: `chatStream.ts` streams with `memory: { thread: conversationId, resource: tenantId }`. The resource is `requestContext.get('tenantId')`, not `MASTRA_RESOURCE_ID_KEY`, which Mastra strips from a delegated (Director) context.
  - Records are capped at 200 entries per list, dropping the oldest first.
- **Real tagged tests:**
  - Project `excellent-setup-486815-c1`, account `suyashresearchwork@gmail.com`. Never `fitnearn-devops`.
  - `RUN_JINGLE_REAL=1` is one Lyria 3 call ($0.04).
  - `RUN_REAL_FFMPEG=1` is the real-ffmpeg cut and level-match tests.
  - Without the variable, the suite is skipped.
- **Commits:** every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Where work happens:** in the worktree `.claude/worktrees/tvc-ad` on branch `tvc-ad-spec`. Never `git stash`, never push.

## Review Focus

1. **lyria-002 requests must stay byte-identical.** A `lyria-002` call (even one that carries a stray `lyrics` field) must send the same URL, headers and body as today. Pinned in Task 1 ("lyria-002 stays byte-identical").
2. **Plans without a jingle are unchanged.** No new keys in any slice, the same credit steps, the same validation, and the same `mix_voiceover` / `mix_music_bed` filter graphs when the new inputs are absent. Pinned in Task 4 ("a plan without a jingle slices and prices exactly as before") and Task 5 (the pinned legacy filter strings).
3. **A foreign thread is never written in K1.** A thread owned by another tenant, or a missing one, gets no `updateThread` call; the still counts as not checked, and the re-check guard falls back to today's in-process map. Pinned in Task 6 ("never writes a foreign or missing thread").
4. **`crop_image`'s behaviour is unchanged in K2.** `cropImage.test.ts` passes without edits, a single-head reply crops exactly as before, and with several heads the largest one is used. Pinned in Task 7 (the unchanged test run, plus "largestBox picks the biggest head").
5. **A refund happens on every `generate_jingle` failure path:** gateway error, gateway throw, 422, content block, no audio, line not sung, cut failure, and either upload failing. Pinned in Task 3 (the `it.each` refund table).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/inference-gateway/src/contentBlocked.ts` (create) | `isContentBlocked`, moved out of `video.ts` so `music.ts` can use it without importing the video module |
| `apps/inference-gateway/src/video.ts` (modify) | Re-export `isContentBlocked` from `contentBlocked.ts` |
| `apps/inference-gateway/src/music.ts` (modify) | J1: allowlist, `lyria3Body`, `lyria3Url`, `classifyLyria3Response`, `callLyria3`, shared retry |
| `apps/inference-gateway/src/music.test.ts` (modify) | J1 tests, lyria-002 byte-identity |
| `apps/agent-orchestrator/src/mastra/tools/timedLyrics.ts` (create) | J2: `parseTimedLyrics`, `findLine` |
| `apps/agent-orchestrator/src/mastra/tools/jingleCut.ts` (create) | J4: `signoffWindow`, `signoffFilter`, `cutSignoff` |
| `apps/agent-orchestrator/src/mastra/tools/jingleCut.realffmpeg.test.ts` (create) | Tagged real-ffmpeg cut test |
| `apps/agent-orchestrator/src/mastra/tools/generateJingle.ts` (create) | J3: the `generate_jingle` tool |
| `apps/agent-orchestrator/src/mastra/tools/generateJingle.real.test.ts` (create) | Tagged real Lyria 3 test ($0.04) |
| `packages/foundation/database/seeds/credit-rates.ts` (modify) | The `lyria-3-clip-preview` rate row |
| `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts`, `src/routes/cancelNotice.ts` (modify) | Approval card and cancel notice for `generate_jingle` |
| `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts` (modify) | Register `generate_jingle` on both tool maps |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts`, `planTvc.ts` (modify) | J5: plan fields, rules, record, carry-over, finish slice, credit steps |
| `apps/agent-orchestrator/src/mastra/tools/mixVoiceover.ts`, `mixMusicBed.ts` (modify) | J6 |
| `apps/agent-orchestrator/src/mastra/tools/mixVoiceover.realffmpeg.test.ts` (create) | Tagged real-ffmpeg level-match test |
| `apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.ts` (create) | K1: thread-metadata check records, ownership guard, per-thread lock |
| `apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.testing.ts` (create) | K1: in-memory `ThreadMetaStore` for tests (merges metadata like `@mastra/pg`, sorts keys like jsonb) |
| `apps/agent-orchestrator/src/mastra/tools/checkStill.ts`, `checkClip.ts`, `planTvc.ts` (modify) | K1 callers |
| `apps/agent-orchestrator/src/mastra/tools/findFaces.ts` (create) | K2: `findFaces`, `parseBox2dList`, `parseFractionBox`, `largestBox` |
| `apps/agent-orchestrator/src/mastra/tools/cropImage.ts`, `tvcChecks.ts`, `overlayText.ts`, `compositeEndCard.ts` (modify) | K2 callers |
| `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`, `tvc-ad.md` (modify, append only) | J7 |

---

### Task 1: the gateway sings (J1)

**Files:**
- Create: `apps/inference-gateway/src/contentBlocked.ts`
- Modify: `apps/inference-gateway/src/video.ts:400-406`
- Modify: `apps/inference-gateway/src/music.ts`
- Test: `apps/inference-gateway/src/music.test.ts`

**Interfaces:**
- Consumes: nothing new. `vertexMusicBreaker` from `./router.js` as today.
- Produces (the orchestrator relies on this JSON over HTTP, in Task 3):
  - Request `POST /v1/music/generations` `{ model: 'lyria-3-clip-preview', prompt: string, lyrics?: string[] }`
  - Response 200 `{ audioBase64: string, mimeType: 'audio/mpeg', lyricsText: string }` or `{ refused: true, reason: 'CONTENT_BLOCKED' | 'NO_PREDICTIONS' | 'NO_AUDIO_BYTES' }`; 422 on a twice-failed transient 500 (as lyria-002); 503 on other failures.
  - `export function isContentBlocked(message: string): boolean` (from `contentBlocked.ts`; `video.ts` re-exports it, so `video.test.ts` is untouched)
  - `export function lyria3Body(prompt: string, lyrics?: string[])`
  - `export function lyria3Url(project: string): string`
  - `export function classifyLyria3Response(json: any): MusicGenerationResult`
  - `MusicGenerationRequest` gains `lyrics?: string[]`; the success arm of `MusicGenerationResult` gains `lyricsText?: string`.

- [ ] **Step 1: Write the failing tests** (append to `music.test.ts`)

Add `lyria3Body` to the existing import line: `import { classifyVertexMusicResponse, generateMusic, lyria3Body } from './music'`. Then append:

```ts
describe('lyria-002 stays byte-identical (Review Focus 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends exactly the old URL, headers and body, even when a lyrics field is passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ predictions: [{ bytesBase64Encoded: 'QUJD', mimeType: 'audio/wav' }] }) })
    vi.stubGlobal('fetch', fetchMock)
    await generateMusic({ model: 'lyria-002', prompt: 'a calm lo-fi beat', lyrics: ['ignored'] })
    const [url, init] = fetchMock.mock.calls[0]
    const loc = process.env.VERTEX_LOCATION ?? 'us-central1'
    expect(url).toMatch(new RegExp(`^https://${loc}-aiplatform\\.googleapis\\.com/v1/projects/[^/]*/locations/${loc}/publishers/google/models/lyria-002:predict$`))
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' })
    expect(init.body).toBe(JSON.stringify({ instances: [{ prompt: 'a calm lo-fi beat' }] }))
  })
})

describe('Lyria 3 (lyria-3-clip-preview)', () => {
  const req = { model: 'lyria-3-clip-preview', prompt: 'bright pop, female vocal, 120 bpm', lyrics: ['Every bubble, every sip', 'Bubbli, feel the magic'] }
  const okBody = {
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [
        { text: '[0.0:6.2] Every bubble, every sip' },
        { text: '[22.1:25.0] Bubbli, feel the magic' },
        { inlineData: { mimeType: 'audio/mpeg', data: 'TVAz' } },
      ] },
    }],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(vertexMusicBreaker.isAvailable).mockReturnValue(true)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('builds the prompt with a Lyrics section and asks for audio and text', () => {
    expect(lyria3Body('bright pop', ['Every sip', 'Bubbli, feel the magic'])).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'bright pop\n\nLyrics:\n[Chorus]\nEvery sip\nBubbli, feel the magic' }] }],
      generationConfig: { responseModalities: ['AUDIO', 'TEXT'] },
    })
    expect(lyria3Body('bright pop')).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'bright pop' }] }],
      generationConfig: { responseModalities: ['AUDIO', 'TEXT'] },
    })
  })

  it('posts to the global generateContent endpoint and returns MP3 plus the joined lyrics text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateMusic(req)
    expect(result).toEqual({ audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: '[0.0:6.2] Every bubble, every sip\n[22.1:25.0] Bubbli, feel the magic' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/[^/]*\/locations\/global\/publishers\/google\/models\/lyria-3-clip-preview:generateContent$/)
    expect(JSON.parse(init.body)).toEqual(lyria3Body(req.prompt, req.lyrics))
    expect(JSON.parse(init.body).generationConfig.responseModalities).toEqual(['AUDIO', 'TEXT'])
    expect(vertexMusicBreaker.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('a reply with no audio part is NO_AUDIO_BYTES', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) }))
    expect(await generateMusic(req)).toEqual({ refused: true, reason: 'NO_AUDIO_BYTES' })
  })

  it.each([
    ['a prompt block', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }],
    ['a safety finish', { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }],
  ])('maps %s to CONTENT_BLOCKED without tripping the breaker', async (_name, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
    expect(await generateMusic(req)).toEqual({ refused: true, reason: 'CONTENT_BLOCKED' })
    expect(vertexMusicBreaker.onFailure).not.toHaveBeenCalled()
  })

  it('maps a Responsible AI 400 to CONTENT_BLOCKED without tripping the breaker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":{"code":400,"message":"The prompt could not be submitted. It violated Google\'s Responsible AI practices."}}' }))
    expect(await generateMusic(req)).toEqual({ refused: true, reason: 'CONTENT_BLOCKED' })
    expect(vertexMusicBreaker.onFailure).not.toHaveBeenCalled()
  })

  it('retries Lyria\'s transient 500 once, like lyria-002', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Could not generate audio' })
      .mockResolvedValueOnce({ ok: true, json: async () => okBody })
    vi.stubGlobal('fetch', fetchMock)
    const p = generateMusic(req)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await p).toMatchObject({ audioBase64: 'TVAz' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a plain 503 is a clean throw that counts against the breaker (no fallback tier)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'unavailable' }))
    await expect(generateMusic(req)).rejects.toThrow(/503/)
    expect(vertexMusicBreaker.onFailure).toHaveBeenCalledTimes(1)
  })
})
```

Also change the existing "rejects a model not on the allowlist" test's model from `'lyria-3-pro-preview'` to `'lyria-3-pro-preview'`: it stays as is (that model is still not allowed). Leave it untouched.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter inference-gateway exec vitest run src/music.test.ts`
Expected: FAIL. `lyria3Body` is not exported, and `lyria-3-clip-preview` is rejected as unsupported.

- [ ] **Step 3: Move `isContentBlocked` into its own module**

Create `apps/inference-gateway/src/contentBlocked.ts`:

```ts
// Vertex refuses some prompts outright (2026-10-05: Omni on "high-school girl
// … spin"). The same prompt fails the same way on every path, so this is
// never a reason to fall back or to count a backend failure: it is a plain
// refusal the agent can act on by rephrasing. Shared by video.ts and music.ts.
export function isContentBlocked(message: string): boolean {
  return /content_blocked|Responsible AI/i.test(message)
}
```

In `video.ts`, replace the function body block (the comment starting `// Omni refuses some prompts outright` and the `export function isContentBlocked` lines) with:

```ts
// Omni refuses some prompts outright (2026-10-05: "high-school girl … spin");
// see contentBlocked.ts.
import { isContentBlocked } from './contentBlocked.js'
export { isContentBlocked }
```

Move the `import` line to the top of `video.ts` with the other imports if your linter requires imports first; keep the `export { isContentBlocked }` where the function was.

- [ ] **Step 4: Implement the Lyria 3 path in `music.ts`**

1. Add the import at the top: `import { isContentBlocked } from './contentBlocked.js'`
2. Replace the allowlist and the request/result types:

```ts
export const LYRIA3_MODEL = 'lyria-3-clip-preview'
const MUSIC_MODEL_ALLOWLIST = new Set(['lyria-002', LYRIA3_MODEL])
```

```ts
export interface MusicGenerationRequest {
  model: string
  prompt: string
  // lyria-3-clip-preview only: sung in order, after a "Lyrics:" heading. lyria-002 ignores it.
  lyrics?: string[]
}

export type MusicGenerationResult =
  | { audioBase64: string; mimeType: string; lyricsText?: string }
  | { refused: true; reason: string }
```

3. Add, below `callVertexMusicModel` (which stays exactly as it is):

```ts
// Lyria 3 (sung, any language) is a Gemini-style model: generateContent at
// location global only, and it must be asked for TEXT as well as AUDIO or
// Vertex answers a bare 400. The text parts carry timed lyric lines,
// e.g. "[9.4:14.9] Chai Nation, mazaa baar baar" (verified 2026-10-05).
export function lyria3Url(project: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${LYRIA3_MODEL}:generateContent`
}

export function lyria3Body(prompt: string, lyrics?: string[]) {
  const text = lyrics?.length ? `${prompt}\n\nLyrics:\n[Chorus]\n${lyrics.join('\n')}` : prompt
  return { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO', 'TEXT'] } }
}

const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyLyria3Response(json: any): MusicGenerationResult {
  if (json?.promptFeedback?.blockReason) return { refused: true, reason: 'CONTENT_BLOCKED' }
  const candidate = json?.candidates?.[0]
  if (!candidate) return { refused: true, reason: 'NO_PREDICTIONS' }
  if (BLOCKED_FINISH.has(candidate.finishReason)) return { refused: true, reason: 'CONTENT_BLOCKED' }
  const parts: Array<{ text?: unknown; inlineData?: { data?: unknown; mimeType?: unknown } }> = candidate.content?.parts ?? []
  const audio = parts.find((p) => typeof p?.inlineData?.data === 'string')
  if (!audio) return { refused: true, reason: 'NO_AUDIO_BYTES' }
  const lyricsText = parts.filter((p) => typeof p?.text === 'string').map((p) => p.text as string).join('\n')
  return { audioBase64: audio.inlineData!.data as string, mimeType: (audio.inlineData!.mimeType as string | undefined) ?? 'audio/mpeg', lyricsText }
}

async function callLyria3(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const res = await fetch(lyria3Url(PROJECT), {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(lyria3Body(req.prompt, req.lyrics)),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    const text = await res.text()
    if (isContentBlocked(text)) return { refused: true, reason: 'CONTENT_BLOCKED' }
    throw new Error(`Vertex music generation failed: ${res.status} ${text}`)
  }
  return classifyLyria3Response(await res.json())
}

const callFor = (req: MusicGenerationRequest) => (req.model === LYRIA3_MODEL ? callLyria3 : callVertexMusicModel)
```

4. In `callVertexMusicModelWithRetry`, add `const call = callFor(req)` as its first line and replace both `callVertexMusicModel(req)` calls inside it with `call(req)`. Nothing else in it changes, so lyria-002 goes through `callVertexMusicModel` exactly as today.

5. Update the comment above `generateMusic`: append `// lyria-3-clip-preview has no fallback tier either; it shares the breaker and the one transient-500 retry.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter inference-gateway exec vitest run src/music.test.ts src/video.test.ts`
Expected: PASS, including the old lyria-002 tests and `video.test.ts`'s `isContentBlocked` tests.

Then run: `pnpm --filter inference-gateway test && pnpm --filter inference-gateway exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/inference-gateway/src/contentBlocked.ts apps/inference-gateway/src/video.ts apps/inference-gateway/src/music.ts apps/inference-gateway/src/music.test.ts
git commit -m "feat(gateway): Lyria 3 sung clips with timed lyrics on /v1/music/generations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: the timed-lyrics parser and the sign-off cut (J2, J4)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/timedLyrics.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/timedLyrics.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/jingleCut.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/jingleCut.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/jingleCut.realffmpeg.test.ts`

**Interfaces:**
- Consumes: `parseSilences(stderr: string, duration: number): Array<[number, number]>` from `./tightenPauses.js`.
- Produces:
  - `export interface TimedLine { start: number; end: number; text: string }`
  - `export function parseTimedLyrics(text: string): TimedLine[]`
  - `export function lyricWords(s: string): string[]`
  - `export function lineOverlap(wanted: string, candidate: string): number`
  - `export const MIN_LINE_OVERLAP = 0.8`
  - `export function findLine(lines: TimedLine[], wanted: string): TimedLine | null`
  - `export function signoffWindow(line: TimedLine, silencesAfterEnd: Array<[number, number]>, clipSeconds: number): { start: number; end: number }`
  - `export function signoffFilter(lengthSeconds: number): string`
  - `export async function cutSignoff(fullPath: string, line: TimedLine, workDir: string): Promise<{ audio: Buffer; seconds: number }>` (throws on any ffmpeg failure, or a cut shorter than 0.5 s)

- [ ] **Step 1: Write the failing tests**

Create `timedLyrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { findLine, lineOverlap, parseTimedLyrics } from './timedLyrics.js'

// The Chai line is verbatim from the 2026-10-05 Lyria 3 run; the lines around
// it are filler in the same format.
const CHAI = [
  'Here is your jingle.',
  '[Chorus]',
  '[0.0:4.6] Garam chai, subah ki baat',
  '[9.4:14.9] Chai Nation, mazaa baar baar',
].join('\n')
const BUBBLI = '[0.0:6.2] Every bubble, every sip\n[22.1:25.0] Bubbli, feel the magic'
// Decomposed nukta (ज + ◌़) in the sung text; the wanted text below uses the precomposed ज़ (U+095B).
const HINDI = '[15.2:19.0] चाय नेशन, मज़ा बार बार'

describe('parseTimedLyrics (J2)', () => {
  it('reads [start:end] lines and ignores everything else', () => {
    expect(parseTimedLyrics(CHAI)).toEqual([
      { start: 0, end: 4.6, text: 'Garam chai, subah ki baat' },
      { start: 9.4, end: 14.9, text: 'Chai Nation, mazaa baar baar' },
    ])
  })
  it('drops a line whose end is not after its start, and an empty text', () => {
    expect(parseTimedLyrics('[5.0:5.0] same\n[6.0:4.0] backwards\n[1.0:2.0]   \n[1.0:2.5] ok')).toEqual([{ start: 1, end: 2.5, text: 'ok' }])
  })
  it('accepts CRLF and spaces around the colon', () => {
    expect(parseTimedLyrics('[ 1.5 : 3 ] hello\r\n')).toEqual([{ start: 1.5, end: 3, text: 'hello' }])
  })
})

describe('findLine (J2)', () => {
  it('finds the Chai sign-off with different punctuation and case', () => {
    expect(findLine(parseTimedLyrics(CHAI), 'chai nation — Mazaa baar baar!')).toEqual({ start: 9.4, end: 14.9, text: 'Chai Nation, mazaa baar baar' })
  })
  it('finds the Bubbli sign-off', () => {
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli, feel the magic')?.start).toBe(22.1)
  })
  it('finds a Hindi line in Devanagari, keeping vowel signs and nukta', () => {
    expect(findLine(parseTimedLyrics(HINDI), 'चाय नेशन, मज़ा बार बार')?.start).toBe(15.2)
  })
  it('returns null when the line was not sung', () => {
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli, taste the sparkle')).toBeNull()
    expect(findLine([], 'anything')).toBeNull()
  })
  it('needs at least 0.8 of the wanted words', () => {
    expect(lineOverlap('Bubbli feel the magic today', 'Bubbli, feel the magic')).toBe(0.8)
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli feel the magic today')?.start).toBe(22.1)
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli feel the real magic today')).toBeNull()
  })
  it('prefers the later of two equally good lines (the ending)', () => {
    const twice = '[3.0:5.0] Bubbli, feel the magic\n[22.1:25.0] Bubbli, feel the magic'
    expect(findLine(parseTimedLyrics(twice), 'Bubbli, feel the magic')?.start).toBe(22.1)
  })
})
```

Create `jingleCut.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signoffFilter, signoffWindow } from './jingleCut.js'

const line = { start: 22.1, end: 25.0, text: 'Bubbli, feel the magic' }

describe('signoffWindow (J4)', () => {
  it('starts 0.15s early and ends at the first silence after the line', () => {
    expect(signoffWindow(line, [[0.6, 2]], 30.77)).toEqual({ start: 21.95, end: 25.6 })
  })
  it('ends at the line end when the silence starts right there', () => {
    expect(signoffWindow(line, [[0, 1]], 30.77)).toEqual({ start: 21.95, end: 25 })
  })
  it('lets a held note ring for at most 2s when no silence is found', () => {
    expect(signoffWindow(line, [], 30.77)).toEqual({ start: 21.95, end: 27 })
  })
  it('never runs past the clip, and never starts before 0', () => {
    expect(signoffWindow({ start: 0.1, end: 29.5, text: 'x' }, [], 30.77)).toEqual({ start: 0, end: 30.77 })
  })
})

describe('signoffFilter (J4)', () => {
  it('fades in over 20ms and out over the last 0.9s', () => {
    expect(signoffFilter(3.65)).toBe('afade=t=in:d=0.02,afade=t=out:st=2.75:d=0.9')
  })
  it('fades a cut shorter than 0.9s over its whole length', () => {
    expect(signoffFilter(0.6)).toBe('afade=t=in:d=0.02,afade=t=out:st=0:d=0.6')
  })
})
```

Create `jingleCut.realffmpeg.test.ts`:

```ts
// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cutSignoff } from './jingleCut.js'

const meanVolume = (args: string[]): number => {
  const out = execFileSync('ffmpeg', ['-nostats', ...args, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }) as unknown as string
  return Number(/mean_volume: (-?[0-9.]+) dB/.exec(String(out))?.[1] ?? NaN)
}
const stderrOf = (args: string[]): string => {
  try { execFileSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }); return '' } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? '') }
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('sign-off cut on real ffmpeg (J4)', () => {
  it('ends at the gap after the line, fades out, and is 48 kHz stereo AAC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jingle-cut-'))
    const src = join(dir, 'tone.wav')
    // 0–2.0s tone, 2.0–2.6s silence, 2.6–5.0s another tone. The "sung line"
    // is 0.5–1.8s, so the cut must stop at the gap (2.0s) and never reach
    // the next tone.
    execFileSync('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2.4',
      '-filter_complex', '[1]atrim=0:0.6[g];[0][g][2]concat=n=3:v=0:a=1', '-ac', '1', src])

    const { audio, seconds } = await cutSignoff(src, { start: 0.5, end: 1.8, text: 'x' }, dir)
    expect(seconds).toBeCloseTo(1.65, 1)
    const out = join(dir, 'cut.m4a')
    writeFileSync(out, audio)

    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', out]).toString()
    expect(JSON.parse(probe).streams[0]).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 })

    // The fade-out is present: the last 0.15s is at least 10 dB quieter than the body.
    const body = meanVolume(['-ss', '0.2', '-t', '0.5', '-i', out])
    const tail = meanVolume(['-sseof', '-0.15', '-i', out])
    expect(body - tail).toBeGreaterThanOrEqual(10)
    // And no 660 Hz tone leaked in: nothing after the cut point exists.
    expect(stderrOf(['-v', 'error', '-i', out, '-f', 'null', '-'])).toBe('')
  }, 60_000)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/timedLyrics.test.ts src/mastra/tools/jingleCut.test.ts`
Expected: FAIL with "Cannot find module './timedLyrics.js'" / "./jingleCut.js".

- [ ] **Step 3: Implement `timedLyrics.ts`**

```ts
// Lyria 3 returns its lyrics as text parts with one timed line each, e.g.
// "[9.4:14.9] Chai Nation, mazaa baar baar" (spec 2026-10-05-tvc-jingle-
// design.md J2). The sign-off is found here in code, so the cut never
// depends on Director reading timestamps.
export interface TimedLine { start: number; end: number; text: string }

const LINE_RE = /^\s*\[\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*\]\s*(.*?)\s*$/
export const MIN_LINE_OVERLAP = 0.8

export function parseTimedLyrics(text: string): TimedLine[] {
  const out: TimedLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw)
    if (!m) continue
    const start = Number(m[1]), end = Number(m[2]), line = m[3]
    if (!(end > start) || !line) continue
    out.push({ start, end, text: line })
  }
  return out
}

/** Lowercase words with punctuation removed. Keeps letters, combining marks
 *  (Devanagari vowel signs, nukta) and digits; NFC so ज़ matches ज + ◌़. */
export function lyricWords(s: string): string[] {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

/** The share of the wanted words that appear in the candidate line (0..1). */
export function lineOverlap(wanted: string, candidate: string): number {
  const want = lyricWords(wanted)
  if (want.length === 0) return 0
  const have = new Set(lyricWords(candidate))
  return want.filter((w) => have.has(w)).length / want.length
}

/** The sung line that best matches the sign-off (overlap ≥ 0.8), or null.
 *  On a tie the later line wins: a repeated sign-off resolves at the end. */
export function findLine(lines: TimedLine[], wanted: string): TimedLine | null {
  let best: TimedLine | null = null
  let bestScore = 0
  for (const l of lines) {
    const score = lineOverlap(wanted, l.text)
    if (score >= MIN_LINE_OVERLAP && score >= bestScore) { best = l; bestScore = score }
  }
  return best
}
```

- [ ] **Step 4: Implement `jingleCut.ts`**

```ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSilences } from './tightenPauses.js'
import type { TimedLine } from './timedLyrics.js'

// Cuts the sung sign-off out of Lyria 3's 30s clip (spec J4): from just
// before the line (so the first consonant is kept) to the first silence
// after it, never more than 2s past the line, so a held note rings out but
// the next verse is never included.
const execFile = promisify(execFileCb)
const FFMPEG_TIMEOUT_MS = 60_000
export const LEAD_IN = 0.15
export const MAX_RING = 2.0
export const FADE_OUT = 0.9
export const FADE_IN = 0.02
export const SILENCE_FILTER = 'silencedetect=noise=-35dB:d=0.25'
const MIN_CUT = 0.5
const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000

/** silencesAfterEnd: silencedetect pairs measured from the line's end (t=0 is line.end). */
export function signoffWindow(line: TimedLine, silencesAfterEnd: Array<[number, number]>, clipSeconds: number): { start: number; end: number } {
  const start = r2(Math.max(0, line.start - LEAD_IN))
  const firstSilence = silencesAfterEnd.find(([s]) => s >= 0)
  const ring = firstSilence ? Math.min(firstSilence[0], MAX_RING) : MAX_RING
  return { start, end: r2(Math.min(line.end + ring, clipSeconds)) }
}

export function signoffFilter(lengthSeconds: number): string {
  const d = Math.min(FADE_OUT, lengthSeconds)
  return `afade=t=in:d=${FADE_IN},afade=t=out:st=${r3(Math.max(0, lengthSeconds - d))}:d=${r3(d)}`
}

export async function cutSignoff(fullPath: string, line: TimedLine, workDir: string): Promise<{ audio: Buffer; seconds: number }> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fullPath], { timeout: FFMPEG_TIMEOUT_MS })
  const clipSeconds = parseFloat(stdout.trim())
  if (!(clipSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${stdout}`)
  const probe = await execFile('ffmpeg', ['-nostats', '-ss', String(line.end), '-t', String(MAX_RING), '-i', fullPath, '-af', SILENCE_FILTER, '-f', 'null', '-'], { timeout: FFMPEG_TIMEOUT_MS })
  const { start, end } = signoffWindow(line, parseSilences(probe.stderr, MAX_RING), clipSeconds)
  const length = r2(end - start)
  if (length < MIN_CUT) throw new Error(`sign-off cut too short: ${length}s`)
  const out = join(workDir, 'signoff.m4a')
  await execFile('ffmpeg', ['-y', '-ss', String(start), '-t', String(length), '-i', fullPath,
    '-af', signoffFilter(length), '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', out], { timeout: FFMPEG_TIMEOUT_MS })
  return { audio: readFileSync(out), seconds: length }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/timedLyrics.test.ts src/mastra/tools/jingleCut.test.ts`
Expected: PASS.

Run: `RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/jingleCut.realffmpeg.test.ts`
Expected: PASS (1 test). If the length assertion is off by the AAC priming delay, do not widen it past `toBeCloseTo(1.65, 1)`; report the measured value instead.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/timedLyrics.ts apps/agent-orchestrator/src/mastra/tools/timedLyrics.test.ts apps/agent-orchestrator/src/mastra/tools/jingleCut.ts apps/agent-orchestrator/src/mastra/tools/jingleCut.test.ts apps/agent-orchestrator/src/mastra/tools/jingleCut.realffmpeg.test.ts
git commit -m "feat(orchestrator): find the sung sign-off in Lyria's timed lyrics and cut it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: the `generate_jingle` tool, its credit rate and its wiring (J3)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/generateJingle.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/generateJingle.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/generateJingle.real.test.ts`
- Modify: `packages/foundation/database/seeds/credit-rates.ts:9,45-46` (export `RATES`, add the row)
- Test: `packages/foundation/database/seeds/credit-rates.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts:130,172-173`
- Test: `apps/agent-orchestrator/src/mastra/tools/generationApproval.test.ts:74-112`
- Modify: `apps/agent-orchestrator/src/routes/cancelNotice.ts:45-46`
- Test: `apps/agent-orchestrator/src/routes/cancelNotice.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts:28,169,190`

**Interfaces:**
- Consumes:
  - From Task 1: the gateway JSON `{ audioBase64, mimeType: 'audio/mpeg', lyricsText }` or `{ refused, reason }`.
  - From Task 2: `parseTimedLyrics`, `findLine`, `TimedLine`, `cutSignoff(fullPath, line, workDir): Promise<{ audio: Buffer; seconds: number }>`.
  - Existing: `refundMusicCharge(tenantId, agentId, chargeKey, rateId, rateVersion)`, `shouldRequireApproval`, `uploadGeneratedFile`, `stableToolCallId`, `videoBlockedThisTurn`, `emitGenerationStarted`, `fileTitle`.
- Produces:
  - `export const JINGLE_MODEL = 'lyria-3-clip-preview'`
  - `export function jinglePrompt(style: string, language?: string): string`
  - `export const generateJingle` (tool id `generate-jingle`, registered as `generate_jingle`)
  - Input `{ line: string; lyrics?: string[]; style: string; language?: string; title?: string }`
  - Output `{ fileId, name, fileType, size, signoffFileId, signoffSeconds: number, lines: TimedLine[] }` or `{ refused: true, refusalReason, lines? }` or `{ insufficientCredits: true }`
  - Credit rate `music_generation / lyria-3-clip-preview` = `{ per_call_micro: 4_000_000 }`

- [ ] **Step 1: Write the failing tests**

Create `generateJingle.test.ts`:

```ts
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
const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))
const { cutSignoff } = vi.hoisted(() => ({ cutSignoff: vi.fn() }))
vi.mock('./jingleCut.js', () => ({ cutSignoff }))

import { generateJingle, JINGLE_MODEL } from './generateJingle.js'
import { uploadGeneratedFile } from '../../persistence.js'
import { stableToolCallId } from '../../credits.js'

const upload = uploadGeneratedFile as ReturnType<typeof vi.fn>
const LYRICS = '[0.0:6.2] Every bubble, every sip\n[22.1:25.0] Bubbli, feel the magic'
const input = { line: 'Bubbli, feel the magic', lyrics: ['Every bubble, every sip'], style: 'bright pop, female vocal, 120 bpm' }
const gatewayOk = (body: object = { audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: LYRICS }) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

function ctx(toolCallId = 'call-1', values: Record<string, string> = { tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' }) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId, messages: [] } } as never
}
const chargeKeyFor = (toolCallId = 'call-1') => `jingle:c1:${stableToolCallId(toolCallId)}`

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate-j', version: 1, schema: { per_call_micro: 4_000_000 } })
  shouldRequireApproval.mockResolvedValue(false)
  getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-4000000', expires_at: null }] }) })
  cutSignoff.mockResolvedValue({ audio: Buffer.from('cut'), seconds: 3.4 })
  upload
    .mockResolvedValueOnce({ fileId: 'full-1', name: 'Jingle.mp3', type: 'audio/mpeg', size: 3 })
    .mockResolvedValueOnce({ fileId: 'cut-1', name: 'Jingle sign-off.m4a', type: 'audio/mp4', size: 3 })
})

describe('generate_jingle (J3)', () => {
  it('charges the Lyria 3 rate first, sings the lyrics then the line, and returns both files', async () => {
    const order: string[] = []
    spendCredits.mockImplementation(async () => { order.push('charge') })
    const gw = vi.fn(async () => { order.push('gateway'); return new Response(JSON.stringify({ audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: LYRICS }), { status: 200 }) })
    global.fetch = gw as unknown as typeof fetch

    const result = await generateJingle.execute!(input as never, ctx())

    expect(order).toEqual(['charge', 'gateway'])
    expect(resolveRate).toHaveBeenCalledWith('music_generation', JINGLE_MODEL)
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ amountMicro: -4_000_000n, kind: 'debit', key: chargeKeyFor(), jobType: 'music_generation' }))
    expect(JSON.parse((gw.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      model: 'lyria-3-clip-preview', prompt: 'bright pop, female vocal, 120 bpm', lyrics: ['Every bubble, every sip', 'Bubbli, feel the magic'],
    })
    expect(cutSignoff).toHaveBeenCalledWith(expect.stringMatching(/full\.mp3$/), { start: 22.1, end: 25, text: 'Bubbli, feel the magic' }, expect.any(String))
    expect(result).toEqual({
      fileId: 'full-1', name: 'Jingle.mp3', fileType: 'audio/mpeg', size: 3,
      signoffFileId: 'cut-1', signoffSeconds: 3.4,
      lines: [{ start: 0, end: 6.2, text: 'Every bubble, every sip' }, { start: 22.1, end: 25, text: 'Bubbli, feel the magic' }],
    })
    expect(upload.mock.calls[1][1]).toMatchObject({ contentType: 'audio/mp4', extension: 'm4a' })
  })

  it('adds the language to the prompt', async () => {
    const gw = gatewayOk()
    global.fetch = gw
    await generateJingle.execute!({ ...input, language: 'Hindi' } as never, ctx())
    expect(JSON.parse(((gw as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string).prompt).toBe('bright pop, female vocal, 120 bpm. Sung in Hindi.')
  })

  it('builds the charge key from a hashed tool-call id, never the raw one', async () => {
    global.fetch = gatewayOk()
    const huge = `gs.${'A'.repeat(6000)}.0`
    await generateJingle.execute!(input as never, ctx(huge))
    const key = spendCredits.mock.calls[0][0].key as string
    expect(key).toBe(chargeKeyFor(huge))
    expect(key.length).toBeLessThan(120)
  })

  it('never calls the gateway when credits are short', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    spendCredits.mockRejectedValue(Object.assign(new Error('short'), { name: 'InsufficientCreditsError' }))
    expect(await generateJingle.execute!(input as never, ctx())).toEqual({ insufficientCredits: true })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refuses NO_SESSION_CONTEXT before charging', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const r = await generateJingle.execute!(input as never, ctx('call-1', { tenantId: 't1' }))
    expect(r).toMatchObject({ refused: true, refusalReason: 'NO_SESSION_CONTEXT' })
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('an unlimited tenant is never charged or refunded', async () => {
    isUnlimited.mockResolvedValue(true)
    global.fetch = gatewayOk({ refused: true, reason: 'CONTENT_BLOCKED' })
    await generateJingle.execute!(input as never, ctx())
    expect(spendCredits).not.toHaveBeenCalled()
  })
})

// Review Focus 5: every failure after the charge refunds it.
describe('generate_jingle refunds on every failure path', () => {
  const refunded = () => expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refund', key: `${chargeKeyFor()}:refund`, amountMicro: 4_000_000n }))

  it.each([
    ['the gateway answers 503', () => { global.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch }, /^GENERATION_FAILED$/],
    ['the gateway call throws', () => { global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch }, /^GENERATION_FAILED$/],
    ['Lyria rejects the prompt (422)', () => { global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'try another style' } }), { status: 422 })) as unknown as typeof fetch }, /^PROMPT_REJECTED: try another style$/],
    ['the prompt is content-blocked', () => { global.fetch = gatewayOk({ refused: true, reason: 'CONTENT_BLOCKED' }) }, /^CONTENT_BLOCKED$/],
    ['no audio comes back', () => { global.fetch = gatewayOk({ mimeType: 'audio/mpeg', lyricsText: LYRICS }) }, /^GENERATION_FAILED$/],
    ['the line was not sung', () => { global.fetch = gatewayOk({ audioBase64: 'TVAz', mimeType: 'audio/mpeg', lyricsText: '[0.0:6.2] Every bubble, every sip' }) }, /^JINGLE_LINE_NOT_SUNG: Lyria did not sing "Bubbli, feel the magic"; try once more or shorten the line$/],
    ['the cut fails', () => { global.fetch = gatewayOk(); cutSignoff.mockRejectedValue(new Error('ffmpeg died')) }, /^JINGLE_CUT_FAILED$/],
    ['the full clip upload fails', () => { global.fetch = gatewayOk(); upload.mockReset(); upload.mockResolvedValueOnce(null) }, /^STORAGE_FAILED$/],
    ['the sign-off upload fails', () => { global.fetch = gatewayOk(); upload.mockReset(); upload.mockResolvedValueOnce({ fileId: 'full-1', name: 'J.mp3', type: 'audio/mpeg', size: 3 }).mockResolvedValueOnce(null) }, /^STORAGE_FAILED$/],
  ])('%s', async (_name, arrange, reason) => {
    arrange()
    const r = await generateJingle.execute!(input as never, ctx()) as { refused?: boolean; refusalReason?: string }
    expect(r.refused).toBe(true)
    expect(r.refusalReason).toMatch(reason)
    refunded()
  })
})
```

Create `generateJingle.real.test.ts`:

```ts
// One real Lyria 3 call ($0.04) on the test project, then the real cut.
// Tagged: runs only with RUN_JINGLE_REAL=1. Never fitnearn-devops.
import { describe, it, expect } from 'vitest'
import { execSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findLine, parseTimedLyrics } from './timedLyrics.js'
import { cutSignoff } from './jingleCut.js'

const PROJECT = process.env.JINGLE_REAL_PROJECT ?? 'excellent-setup-486815-c1'
const ACCOUNT = process.env.JINGLE_REAL_ACCOUNT ?? 'suyashresearchwork@gmail.com'

describe.skipIf(!process.env.RUN_JINGLE_REAL)('Lyria 3 sings the sign-off and the cut lands on it (real, $0.04)', () => {
  it('finds the line, cuts 1.5–8s, and ends in silence', async () => {
    if (PROJECT === 'fitnearn-devops') throw new Error('never run generation tests on fitnearn-devops')
    const token = execSync(`gcloud auth print-access-token --account=${ACCOUNT}`).toString().trim()
    // Same body the gateway builds (lyria3Body, pinned in music.test.ts).
    const body = { contents: [{ role: 'user', parts: [{ text: 'bright pop jingle, female vocal, 120 bpm\n\nLyrics:\n[Chorus]\nEvery bubble, every sip\nBubbli, feel the magic' }] }], generationConfig: { responseModalities: ['AUDIO', 'TEXT'] } }
    const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/lyria-3-clip-preview:generateContent`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(res.ok).toBe(true)
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> } }> }
    const parts = json.candidates?.[0]?.content?.parts ?? []
    const text = parts.filter((p) => p.text).map((p) => p.text).join('\n')
    const audio = parts.find((p) => p.inlineData?.data)?.inlineData?.data
    expect(audio).toBeTruthy()

    const line = findLine(parseTimedLyrics(text), 'Bubbli, feel the magic')
    expect(line, `lyrics were:\n${text}`).not.toBeNull()

    const dir = mkdtempSync(join(tmpdir(), 'jingle-real-'))
    const full = join(dir, 'full.mp3')
    writeFileSync(full, Buffer.from(audio!, 'base64'))
    const { audio: cut, seconds } = await cutSignoff(full, line!, dir)
    const cutPath = join(dir, 'cut.m4a')
    writeFileSync(cutPath, cut)
    console.log(`[jingle-real] files to listen to: ${dir} (line ${line!.start}–${line!.end}s, cut ${seconds}s)`)
    expect(seconds).toBeGreaterThanOrEqual(1.5)
    expect(seconds).toBeLessThanOrEqual(8)

    // Ends in silence: the last 0.1s of the cut is quiet.
    let stderr = ''
    try { execFileSync('ffmpeg', ['-nostats', '-sseof', '-0.1', '-i', cutPath, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { stderr = String((e as { stderr?: Buffer }).stderr ?? '') }
    stderr ||= execFileSync('ffmpeg', ['-nostats', '-sseof', '-0.1', '-i', cutPath, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })?.toString() ?? ''
    const mean = Number(/mean_volume: (-?[0-9.]+) dB/.exec(stderr)?.[1] ?? NaN)
    expect(mean).toBeLessThan(-30)
  }, 180_000)
})
```

Note on the stderr read: `execFileSync` only returns stdout. If your Node version does not expose stderr this way, replace the two `ffmpeg` lines with one `spawnSync('ffmpeg', [...]).stderr.toString()` from `node:child_process`; that is the intent.

Append to `packages/foundation/database/seeds/credit-rates.test.ts`:

```ts
import { RATES } from './credit-rates';

describe('Lyria 3 jingle rate', () => {
  it('prices lyria-3-clip-preview at its $0.04 per clip (4 credits)', () => {
    expect(RATES.find((r) => r.resourceType === 'music_generation' && r.subject === 'lyria-3-clip-preview')?.pricingSchema).toEqual({ per_call_micro: 4_000_000 });
  });
});
```

In `generationApproval.test.ts`, add `'generate-jingle', 'generate_jingle',` to the expected key list (after `'generate-song', 'generate_song',`), and append inside the "maps the underscored delegate keys" test:

```ts
    expect(GENERATION_APPROVAL_METADATA['generate_jingle']).toBe(GENERATION_APPROVAL_METADATA['generate-jingle'])
    expect(GENERATION_APPROVAL_METADATA['generate_jingle']).toMatchObject({ resourceType: 'music_generation', subject: 'lyria-3-clip-preview', label: 'Generate jingle' })
    expect(GENERATION_APPROVAL_METADATA['generate_jingle'].buildPreview!({ line: 'Bubbli, feel the magic' })).toBe('Sung line: "Bubbli, feel the magic"')
```

In `cancelNotice.test.ts`, append:

```ts
describe('generate_jingle cancel', () => {
  it('says the jingle was cancelled', () => {
    expect(buildCancelNotice('generate_jingle', {}, 'make the ad')).toMatch(/^Cancelled the jingle\./)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/generateJingle.test.ts src/mastra/tools/generationApproval.test.ts src/routes/cancelNotice.test.ts && pnpm --filter @serverless-saas/database exec vitest run seeds/credit-rates.test.ts`
Expected: FAIL (missing module, missing metadata keys, `RATES` not exported).

- [ ] **Step 3: Add the credit rate**

In `credit-rates.ts`, change `const RATES = [` to `export const RATES = [`, and add after the `lyria-002` row:

```ts
  // Lyria 3 sung clip (lyria-3-clip-preview, Vertex, location global): $0.04 per
  // ~30s clip, checked 2026-10-05: 4 credits. Used by generate_jingle.
  { resourceType: 'music_generation', subject: 'lyria-3-clip-preview',
    pricingSchema: { per_call_micro: 4_000_000 } },
```

- [ ] **Step 4: Implement `generateJingle.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { stableToolCallId } from '../../credits.js'
import { fileTitleSchema, fileTitle } from './fileTitle.js'
import { refundMusicCharge } from './musicCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { emitGenerationStarted } from './generationStarted.js'
import { videoBlockedThisTurn, SHOW_FIRST_FOLLOW_ON_REFUSAL } from './oneVideoPerTurn.js'
import { findLine, parseTimedLyrics, type TimedLine } from './timedLyrics.js'
import { cutSignoff } from './jingleCut.js'

// A sung sign-off for the TVC ad (spec 2026-10-05-tvc-jingle-design.md J3).
// Its own tool, so Director never confuses a bed (generate_song, instrumental
// lyria-002) with a jingle. Lyria 3 sings the given lines and returns timed
// lyrics; the sign-off line is found and cut in code, not by the agent.
const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
export const JINGLE_MODEL = 'lyria-3-clip-preview'

export function jinglePrompt(style: string, language?: string): string {
  return language?.trim() ? `${style}. Sung in ${language.trim()}.` : style
}

const lineSchema = z.object({ start: z.number(), end: z.number(), text: z.string() })

export const jingleInputSchema = z.object({
  line: z.string().min(1).max(80).describe('The sung sign-off, e.g. "Bubbli, feel the magic"'),
  lyrics: z.array(z.string().min(1)).max(4).optional().describe('Extra lines sung before the sign-off'),
  style: z.string().min(1).describe('Genre, mood and voice, e.g. "bright pop, female vocal, 120 bpm"'),
  language: z.string().optional().describe('The language it is sung in, when not English, e.g. "Hindi"'),
  title: fileTitleSchema,
})

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  signoffFileId: z.string().optional(),
  signoffSeconds: z.number().optional(),
  lines: z.array(lineSchema).optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})

export const generateJingle = createTool({
  id: 'generate-jingle',
  description: 'Paid. Makes a short SUNG jingle with Lyria 3: it sings the given lyrics and then the sign-off line, in any language, and returns the full ~30s clip plus the sign-off cut out of it (signoffFileId, signoffSeconds) ready to mix over the ending. Use only for a sung sign-off; instrumental music is generate_song.',
  inputSchema: jingleInputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    !videoBlockedThisTurn(ctx?.requestContext) && shouldRequireApproval({ resourceType: 'music_generation', subject: JINGLE_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    if (videoBlockedThisTurn(execContext?.requestContext)) return SHOW_FIRST_FOLLOW_ON_REFUSAL
    const { line, lyrics, style, language, title } = inputData as z.infer<typeof jingleInputSchema>
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    if (!conversationId || !idToken) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT' }
    emitGenerationStarted(execContext)

    // Charge BEFORE the vendor call (same as generate_song); every failure
    // below refunds. A Gemini 3.x toolCallId can be several KB, so it is
    // hashed before it goes into a ledger key (CLAUDE.md).
    const toolCallId = execContext?.agent?.toolCallId
    const chargeKey = `jingle:${conversationId}:${toolCallId ? stableToolCallId(toolCallId) : randomUUID()}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('music_generation', JINGLE_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED JINGLE: no active music_generation rate for model=${JINGLE_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        try {
          await spendCredits({
            tenantId, amountMicro: -costMicro(rate.schema, { count: 1 }), key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'music_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
          throw err
        }
      }
    }
    const refund = async () => { if (charged) await refundMusicCharge(tenantId, agentId, chargeKey, rateId, rateVersion) }

    let gen: { audioBase64?: string; mimeType?: string; lyricsText?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/music/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: JINGLE_MODEL, prompt: jinglePrompt(style, language), lyrics: [...(lyrics ?? []), line] }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) {
        if (res.status === 422) {
          const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
          await refund()
          return { refused: true, refusalReason: `PROMPT_REJECTED: ${body?.error?.message ?? 'Lyria could not sing this.'}` }
        }
        throw new Error(`gateway returned ${res.status}`)
      }
      gen = await res.json()
    } catch (err) {
      console.error(`[session:${conversationId}] generateJingle gateway call failed:`, (err as Error).message)
      await refund()
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }
    if (gen.refused) {
      await refund()
      return { refused: true, refusalReason: gen.reason ?? 'GENERATION_FAILED' }
    }
    if (typeof gen.audioBase64 !== 'string') {
      await refund()
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    const lines: TimedLine[] = parseTimedLyrics(gen.lyricsText ?? '')
    const sung = findLine(lines, line)
    if (!sung) {
      await refund()
      return { refused: true, refusalReason: `JINGLE_LINE_NOT_SUNG: Lyria did not sing "${line}"; try once more or shorten the line`, lines }
    }

    const full = Buffer.from(gen.audioBase64, 'base64')
    const mimeType = gen.mimeType ?? 'audio/mpeg'
    let cut: { audio: Buffer; seconds: number }
    const workDir = mkdtempSync(join(tmpdir(), 'jingle-'))
    try {
      const fullPath = join(workDir, 'full.mp3')
      writeFileSync(fullPath, full)
      cut = await cutSignoff(fullPath, sung, workDir)
    } catch (err) {
      console.error(`[session:${conversationId}] generateJingle cut failed:`, (err as Error).message)
      await refund()
      return { refused: true, refusalReason: 'JINGLE_CUT_FAILED' }
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }

    const name = fileTitle(title, 'Jingle')
    const fullFile = await uploadGeneratedFile(idToken, { conversationId, title: name, content: full, contentType: mimeType, extension: 'mp3' })
    if (!fullFile) { await refund(); return { refused: true, refusalReason: 'STORAGE_FAILED' } }
    const signoffFile = await uploadGeneratedFile(idToken, { conversationId, title: `${name} sign-off`, content: cut.audio, contentType: 'audio/mp4', extension: 'm4a' })
    if (!signoffFile) { await refund(); return { refused: true, refusalReason: 'STORAGE_FAILED' } }

    return {
      fileId: fullFile.fileId, name: fullFile.name, fileType: fullFile.type, size: fullFile.size,
      signoffFileId: signoffFile.fileId, signoffSeconds: cut.seconds, lines,
    }
  },
})
```

- [ ] **Step 5: Wire it in**

`generationApproval.ts`, after the `songGen` line (130):

```ts
const jingleGen = {
  resourceType: 'music_generation', subject: 'lyria-3-clip-preview', label: 'Generate jingle',
  buildPreview: (args: Record<string, unknown>) => (typeof args.line === 'string' ? `Sung line: "${args.line}"` : undefined),
}
```

and in `GENERATION_APPROVAL_METADATA`, after `'generate_song': songGen,`:

```ts
  'generate-jingle': jingleGen,
  'generate_jingle': jingleGen,
```

`cancelNotice.ts`, after the `generate_song` case:

```ts
    case 'generate_jingle':
      return 'Cancelled the jingle.' + RETRY
```

`directorAgent.ts`: add `import { generateJingle } from '../tools/generateJingle.js'` after the `generateSong` import, and in BOTH tool maps (lines 169 and 190) add `generate_jingle: generateJingle,` right after `generate_song: generateSong,`. Do not add it to `producerAgent.ts`, and do not add it to `nestedMedia.ts`'s `RELAYED` (the web app has no jingle renderer; the finished ad is what the user sees).

- [ ] **Step 6: Run the tests to verify they pass**

Run:

```bash
pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/generateJingle.test.ts src/mastra/tools/generationApproval.test.ts src/routes/cancelNotice.test.ts src/mastra/tools/generateSong.test.ts
pnpm --filter @serverless-saas/database exec vitest run seeds/credit-rates.test.ts
pnpm --filter agent-orchestrator type-check
```

Expected: PASS. `generateSong.test.ts` passes untouched.

Then the real tagged run (costs $0.04):

Run: `RUN_JINGLE_REAL=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/generateJingle.real.test.ts`
Expected: PASS, and it prints the folder with `full.mp3` and `cut.m4a`. If the line is not found, report the printed lyrics text; do not loosen `MIN_LINE_OVERLAP`.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generateJingle.ts apps/agent-orchestrator/src/mastra/tools/generateJingle.test.ts apps/agent-orchestrator/src/mastra/tools/generateJingle.real.test.ts packages/foundation/database/seeds/credit-rates.ts packages/foundation/database/seeds/credit-rates.test.ts apps/agent-orchestrator/src/mastra/tools/generationApproval.ts apps/agent-orchestrator/src/mastra/tools/generationApproval.test.ts apps/agent-orchestrator/src/routes/cancelNotice.ts apps/agent-orchestrator/src/routes/cancelNotice.test.ts apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(orchestrator): generate_jingle sings the sign-off with Lyria 3 and cuts it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: plan fields and jingle rules (J5)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/planTvc.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts`, `planTvc.test.ts`

**Interfaces:**
- Consumes: the record values from Task 3's output (`fileId` → `jingleFileId`, `signoffFileId`, `signoffSeconds`).
- Produces:
  - `export const jingleSchema` and `brief.jingle?: { line: string; style: string; lyrics?: string[]; language?: string }`
  - Plan fields `jingleFileId?: string; signoffFileId?: string; signoffSeconds?: number`
  - `export function lastSpeechEnd(plan: TvcPlan): number`
  - `export function jingleErrors(plan: TvcPlan, signoffSeconds: number): string[]`
  - `export function signoffTiming(plan: TvcPlan): { signoffStartSeconds: number; musicFadeOutAtSeconds: number } | undefined`
  - The finish slice gains `jingle` (when `brief.jingle` is set) and `jingleFileId`, `signoffFileId`, `signoffSeconds`, `signoffStartSeconds`, `musicFadeOutAtSeconds` (when recorded). Task 8's Director text reads exactly these names.
  - `plan_tvc record` gains inputs `jingleFileId`, `signoffFileId`, `signoffSeconds`.

- [ ] **Step 1: Write the failing tests**

Append to `tvcPlan.test.ts` (and add `jingleErrors, lastSpeechEnd, signoffTiming` to the first import line):

```ts
describe('jingle (J5)', () => {
  const withJingle = (p = goodPlan()): TvcPlan => ({ ...p, brief: { ...p.brief, jingle: { line: 'Soft all day', style: 'warm pop, female vocal' } } })

  it('the last speech is the later of the voiceover end and a line end (words / 2.7)', () => {
    expect(lastSpeechEnd(goodPlan())).toBe(5.3)
    const p = goodPlan()
    p.shots[5] = { ...p.shots[5], audio: 'line', line: 'Soft all day long.' }
    expect(lastSpeechEnd(p)).toBe(11)
  })
  it('accepts a sign-off that starts 0.75s or more after the last word and fits the packshot plus 2s', () => {
    expect(jingleErrors(withJingle(), 3)).toEqual([])
  })
  it('refuses a sign-off that would start too soon after the voiceover', () => {
    const p = withJingle()
    p.voiceover[0].startSeconds = 8.5 // ends at 11.8
    expect(jingleErrors(p, 3)).toEqual(['JINGLE_OVERLAPS_SPEECH: the sung line would start 0.2s after the last word; shorten the line or end the voiceover earlier'])
    expect(jingleErrors(p, 2.4)).toEqual([])
  })
  it('refuses a sign-off that would start too soon after an on-camera line', () => {
    const p = withJingle()
    p.shots[5] = { ...p.shots[5], audio: 'line', line: 'Soft all day long.' } // ends at 11.0
    expect(jingleErrors(p, 3.6)[0]).toMatch(/^JINGLE_OVERLAPS_SPEECH: the sung line would start 0.4s after the last word/)
  })
  it('refuses a sign-off longer than the packshot plus 2s', () => {
    expect(jingleErrors(withJingle(), 5.5)).toContain('JINGLE_TOO_LONG: the sung sign-off is 5.5s; at most 5s (the packshot plus 2s); shorten the line')
  })
  it('the sign-off ends with the ad, and the bed clears 0.3s before it', () => {
    expect(signoffTiming(withJingle())).toBeUndefined()
    expect(signoffTiming({ ...withJingle(), signoffSeconds: 2.4 })).toEqual({ signoffStartSeconds: 12.6, musicFadeOutAtSeconds: 12.3 })
  })
  it('the finish slice carries the jingle and its timing once recorded', () => {
    const p = { ...withJingle(), jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2.4 }
    expect(sliceTvcPlan(p, 'finish')).toMatchObject({
      jingle: { line: 'Soft all day', style: 'warm pop, female vocal' },
      jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2.4, signoffStartSeconds: 12.6, musicFadeOutAtSeconds: 12.3,
    })
  })
  it('prices one more music step when the brief has a jingle', () => {
    expect(tvcCreditSteps(withJingle())).toEqual([
      { kind: 'image', count: 7 }, { kind: 'video', count: 7 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'music', count: 1 }, { kind: 'edit', count: 12 },
    ])
  })
})

// Review Focus 2: a plan without a jingle is untouched.
describe('a plan without a jingle slices and prices exactly as before', () => {
  it('has no new keys in any slice, the same credit steps and the same validation', () => {
    const p = goodPlan()
    for (const slice of ['brief', 'finish', 'shots 1-7']) {
      expect(JSON.stringify(sliceTvcPlan(p, slice))).not.toMatch(/jingle|signoff|musicFadeOut/i)
    }
    expect(Object.keys(sliceTvcPlan(p, 'finish') as object)).toEqual(['brief', 'shots', 'voiceover', 'packshot', 'legal', 'narrationFileIds', 'songFileId'])
    expect(tvcCreditSteps(p)).toEqual([
      { kind: 'image', count: 7 }, { kind: 'video', count: 7 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'edit', count: 12 },
    ])
    expect(validateTvcPlan(p)).toEqual({ errors: [], warnings: expect.any(Array), plan: expect.any(Object) })
    expect(JSON.stringify(tvcPlanSchema.parse(p))).not.toMatch(/jingle|signoff/i)
  })
})
```

Append to `planTvc.test.ts`:

```ts
describe('plan_tvc record: the jingle (J5)', () => {
  const withJingle = () => { const p = plan(); p.brief.jingle = { line: 'Ice cold, every time', style: 'bright pop, male vocal' }; return p }
  const getFinish = async (deps: PlanTvcDeps, id: string) => JSON.parse((await runPlanTvc({ action: 'get', planFileId: id, slice: 'finish' }, deps)).slice!)

  it('records the jingle and the finish slice returns it with its timing', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    expect(await runPlanTvc({ action: 'record', planFileId: planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2 }, deps)).toEqual({ planFileId })
    expect(await getFinish(deps, planFileId!)).toMatchObject({ jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2, signoffStartSeconds: 4, musicFadeOutAtSeconds: 3.7 })
  })
  it('refuses JINGLE_TOO_LONG and saves nothing', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    const out = await runPlanTvc({ action: 'record', planFileId: planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 4.5 }, deps)
    expect(out).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^JINGLE_TOO_LONG/) })
    expect((await getFinish(deps, planFileId!)).jingleFileId).toBeUndefined()
  })
  it('refuses a partial jingle record, and a jingle on a plan without one', async () => {
    const { deps } = fakeDeps()
    const a = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    expect(await runPlanTvc({ action: 'record', planFileId: a.planFileId!, jingleFileId: 'j1' }, deps)).toMatchObject({ refusalReason: expect.stringMatching(/^JINGLE_RECORD_INCOMPLETE/) })
    const b = await runPlanTvc({ action: 'check', plan: plan() }, fakeDeps().deps)
    const { deps: d2 } = fakeDeps()
    const c = await runPlanTvc({ action: 'check', plan: plan() }, d2)
    expect(b.planFileId).toBeDefined()
    expect(await runPlanTvc({ action: 'record', planFileId: c.planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2 }, d2)).toMatchObject({ refusalReason: expect.stringMatching(/^NO_JINGLE_IN_PLAN/) })
  })
  it('a re-check keeps the recorded jingle while the jingle is the same, and drops it when the line changes', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    await runPlanTvc({ action: 'record', planFileId: planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2 }, deps)
    await runPlanTvc({ action: 'check', plan: withJingle(), planFileId }, deps)
    expect((await getFinish(deps, planFileId!)).jingleFileId).toBe('j1')
    const changed = withJingle(); changed.brief.jingle!.line = 'Ice cold, always'
    await runPlanTvc({ action: 'check', plan: changed, planFileId }, deps)
    const finish = await getFinish(deps, planFileId!)
    expect(finish.jingleFileId).toBeUndefined()
    expect(finish.signoffStartSeconds).toBeUndefined()
  })
})
```

(`plan()` in `planTvc.test.ts` is a 6 s plan with a 2 s packshot and no speech, so a 2 s sign-off starts at 4 s and the bed fades out at 3.7 s; more than 2 + 2 = 4 s is too long.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts`
Expected: FAIL (missing exports, unknown record inputs).

- [ ] **Step 3: Implement the plan side in `tvcPlan.ts`**

1. Add constants next to the others: `const JINGLE_GAP = 0.75, JINGLE_OVER_PACK = 2.0, BED_CLEAR = 0.3` and `const r2 = (x: number) => Math.round(x * 100) / 100` (place `r2` next to `r1`).
2. Add before `tvcPlanSchema`:

```ts
// A sung sign-off over the packshot (spec 2026-10-05-tvc-jingle-design.md J5).
export const jingleSchema = z.object({
  line: z.string().min(1).describe('The sung sign-off, e.g. "Bubbli, feel the magic"'),
  style: z.string().min(1).describe('Genre, mood and voice, e.g. "bright pop, female vocal, 120 bpm"'),
  lyrics: z.array(z.string().min(1)).max(4).optional().describe('Lines sung before the sign-off'),
  language: z.string().optional().describe('The language it is sung in, when not English'),
})
```

3. In `brief`, after `actorLook`, add: `jingle: jingleSchema.optional().describe('A sung sign-off over the ending; only when the user wants one or the reference ad has one'),`
4. After `songFileId` at the plan level, add:

```ts
  jingleFileId: z.string().optional().describe('Set by plan_tvc record: the full sung clip from generate_jingle'),
  signoffFileId: z.string().optional().describe('Set by plan_tvc record: the sign-off cut from generate_jingle'),
  signoffSeconds: z.number().positive().optional().describe('Set by plan_tvc record: the sign-off cut\'s length'),
```

5. Add after `validateTvcPlan`:

```ts
/** When the last spoken word ends: voiceover blocks and on-camera lines, both at 2.7 words per second. */
export function lastSpeechEnd(plan: TvcPlan): number {
  const starts = shotStarts(plan)
  const vo = plan.voiceover.map((v) => r1(v.startSeconds + countWords(v.text) / WORDS_PER_SECOND))
  const lines = plan.shots.map((s, i) => (s.audio === 'line' && s.line ? r1(starts[i] + countWords(s.line) / WORDS_PER_SECOND) : 0))
  return Math.max(0, ...vo, ...lines)
}

/** The sign-off ends with the ad; it must start 0.75s after the last word and fit the packshot plus 2s. */
export function jingleErrors(plan: TvcPlan, signoffSeconds: number): string[] {
  const errors: string[] = []
  const start = r2(plan.brief.lengthSeconds - signoffSeconds)
  const gap = r2(start - lastSpeechEnd(plan))
  if (gap < JINGLE_GAP) errors.push(`JINGLE_OVERLAPS_SPEECH: the sung line would start ${gap}s after the last word; shorten the line or end the voiceover earlier`)
  const max = r2(plan.shots[plan.shots.length - 1].durationSeconds + JINGLE_OVER_PACK)
  if (signoffSeconds > max + EPS) errors.push(`JINGLE_TOO_LONG: the sung sign-off is ${signoffSeconds}s; at most ${max}s (the packshot plus 2s); shorten the line`)
  return errors
}

export function signoffTiming(plan: TvcPlan): { signoffStartSeconds: number; musicFadeOutAtSeconds: number } | undefined {
  if (plan.signoffSeconds === undefined) return undefined
  const start = r2(plan.brief.lengthSeconds - plan.signoffSeconds)
  return { signoffStartSeconds: start, musicFadeOutAtSeconds: r2(Math.max(0, start - BED_CLEAR)) }
}
```

6. In `sliceTvcPlan`'s `finish` return, after `narrationFileIds: plan.narrationFileIds, songFileId: plan.songFileId,` add:

```ts
      ...(plan.brief.jingle ? { jingle: plan.brief.jingle } : {}),
      ...(plan.signoffSeconds !== undefined
        ? { jingleFileId: plan.jingleFileId, signoffFileId: plan.signoffFileId, signoffSeconds: plan.signoffSeconds, ...signoffTiming(plan) }
        : {}),
```

7. In `tvcCreditSteps`, replace `steps.push({ kind: 'music', count: 1 }, { kind: 'edit', count: n + 5 })` with:

```ts
  steps.push({ kind: 'music', count: 1 })
  // The jingle is priced as a second music step (the lyria-002 rate, 8
  // credits, is above Lyria 3's 4, so the estimate never runs short).
  if (plan.brief.jingle) steps.push({ kind: 'music', count: 1 })
  steps.push({ kind: 'edit', count: n + 5 })
```

- [ ] **Step 4: Implement the record side in `planTvc.ts`**

1. Import `jingleErrors` from `./tvcPlan.js`.
2. In `planTvcInputSchema`, after `songFileId`:

```ts
  jingleFileId: z.string().optional().describe('record only: generate_jingle\'s fileId (the full sung clip)'),
  signoffFileId: z.string().optional().describe('record only: generate_jingle\'s signoffFileId'),
  signoffSeconds: z.number().positive().optional().describe('record only: generate_jingle\'s signoffSeconds'),
```

Update the `action` description's record clause to end with `, or the finish's narration, song and jingle to the plan`.

3. In `carryOver`, before `const strip = ...`:

```ts
  // The recorded jingle survives while the jingle asked for is the same and
  // still fits the (possibly changed) voiceover; otherwise it must be re-made.
  delete out.jingleFileId; delete out.signoffFileId; delete out.signoffSeconds
  const sameJingle = !!next.brief.jingle && JSON.stringify(previous.brief.jingle) === JSON.stringify(next.brief.jingle)
  if (sameJingle && previous.signoffSeconds !== undefined && jingleErrors(out, previous.signoffSeconds).length === 0) {
    out.jingleFileId = previous.jingleFileId
    out.signoffFileId = previous.signoffFileId
    out.signoffSeconds = previous.signoffSeconds
  }
```

4. In `runPlanTvcUnlocked`'s record path, replace the `NOTHING_TO_RECORD` line with:

```ts
  const jingleFields = [input.jingleFileId, input.signoffFileId, input.signoffSeconds].filter((v) => v !== undefined).length
  if (jingleFields > 0 && jingleFields < 3) return { refused: true, refusalReason: 'JINGLE_RECORD_INCOMPLETE: record jingleFileId, signoffFileId and signoffSeconds together' }
  if (records.length === 0 && !input.narrationFileIds && !input.songFileId && jingleFields === 0) return { refused: true, refusalReason: 'NOTHING_TO_RECORD' }
```

and after the `NARRATION_COUNT_MISMATCH` line:

```ts
  if (jingleFields === 3) {
    if (!doc.plan.brief.jingle) return { refused: true, refusalReason: 'NO_JINGLE_IN_PLAN: this plan has no brief.jingle; add one with a plan check first' }
    const errs = jingleErrors(doc.plan, input.signoffSeconds!)
    if (errs.length) return { refused: true, refusalReason: errs.join(' ') }
  }
```

and after `if (input.songFileId) next = { ...next, songFileId: input.songFileId }`:

```ts
  if (jingleFields === 3) next = { ...next, jingleFileId: input.jingleFileId, signoffFileId: input.signoffFileId, signoffSeconds: input.signoffSeconds }
```

5. Update the tool's `description`: append ` The finish can also record the sung sign-off (jingleFileId, signoffFileId, signoffSeconds); record refuses one that overlaps speech or is too long.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS, including every pre-existing test in both files.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts apps/agent-orchestrator/src/mastra/tools/planTvc.ts apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts
git commit -m "feat(tvc): the plan carries the sung sign-off and times it off the last word

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: mixing the sign-off: level-matched jingle blocks and a bed that clears (J6)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/mixVoiceover.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/mixVoiceover.test.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/mixVoiceover.realffmpeg.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/mixMusicBed.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/mixMusicBed.test.ts`

**Interfaces:**
- Consumes: from Task 4, the finish slice's `signoffStartSeconds` and `musicFadeOutAtSeconds` (Director passes them in); `parseIntegratedLoudness` from `./mixMusicBed.js`.
- Produces:
  - `mix_voiceover` input block `{ audioFileId, startSeconds, kind?: 'voice' | 'jingle' }`, with `blocks` max 5.
  - `export type MixBlock = { start: number; duration: number; kind?: 'voice' | 'jingle'; gainDb?: number }`
  - `export function buildVoiceoverFilter(blocks: MixBlock[], baseHasAudio: boolean, tail?: string, muteJingles?: boolean): string`
  - `export function jingleWindow(start: number): { from: number; to: number } | null`
  - `export function speechInWindow(blocks: MixBlock[], from: number, to: number): boolean`
  - `export function jingleGainDb(windowLufs: number | null, jingleLufs: number, speech: boolean): number`
  - `export async function levelMatchJingles(inputs: string[], blocks: MixBlock[], blockLufs: number[], baseHasAudio: boolean): Promise<MixBlock[]>`
  - `mix_music_bed` input `fadeOutAtSeconds?: number`; `export function buildMusicBedFilter(fadeOutAtSeconds?: number): string`

- [ ] **Step 1: Write the failing tests**

Append to `mixVoiceover.test.ts` (extend the import with `jingleGainDb, jingleWindow, speechInWindow`):

```ts
// Review Focus 2: a call without kind builds the same graph, byte for byte.
describe('legacy voiceover graphs are byte-identical', () => {
  it('two voice blocks over a video with sound', () => {
    expect(buildVoiceoverFilter([{ start: 2, duration: 3.5 }, { start: 8, duration: 2 }], true)).toBe(
      "[1:a]adelay=2000|2000[vo0];[2:a]adelay=8000|8000[vo1];[vo0][vo1]amix=inputs=2:duration=longest:normalize=0[vo];[0:a]volume=0.4:enable='between(t,2,5.5)+between(t,8,10)'[base];[base][vo]amix=inputs=2:duration=first:normalize=0[pre];[pre]loudnorm=I=-14:TP=-1.5:LRA=11[outa]",
    )
  })
  it('one voice block over a silent video', () => {
    expect(buildVoiceoverFilter([{ start: 0.5, duration: 2 }], false)).toBe('[1:a]adelay=500|500[vo0];[vo0]anull[vo];[vo]apad,loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
  })
})

describe('jingle blocks (J6)', () => {
  it('a jingle block is gained, delayed, and neither ducks the base nor is ducked', () => {
    const f = buildVoiceoverFilter([{ start: 2, duration: 3.5 }, { start: 12.6, duration: 2.4, kind: 'jingle', gainDb: -6.5 }], true)
    expect(f).toContain('[2:a]volume=-6.5dB,adelay=12600|12600[vo1]')
    expect(f).toContain("[0:a]volume=0.4:enable='between(t,2,5.5)'[base]")
    expect(f).not.toContain('between(t,12.6')
  })
  it('a jingle with no voice blocks leaves the base at full level', () => {
    const f = buildVoiceoverFilter([{ start: 12.6, duration: 2.4, kind: 'jingle', gainDb: 0 }], true)
    expect(f).toContain('[0:a]anull[base]')
  })
  it('the probe graph mutes jingles and measures a window instead of mastering', () => {
    const f = buildVoiceoverFilter([{ start: 2, duration: 3.5 }, { start: 12.6, duration: 2.4, kind: 'jingle' }], true, 'atrim=start=7.6:end=12.6,ebur128=framelog=verbose', true)
    expect(f).toContain('[2:a]volume=0,adelay=12600|12600[vo1]')
    expect(f).toContain('[pre]atrim=start=7.6:end=12.6,ebur128=framelog=verbose[outa]')
    expect(f).not.toContain('loudnorm')
  })
  it('the window is the 5s before the block, or none when there is under 0.5s of it', () => {
    expect(jingleWindow(12.6)).toEqual({ from: 7.6, to: 12.6 })
    expect(jingleWindow(3)).toEqual({ from: 0, to: 3 })
    expect(jingleWindow(0.3)).toBeNull()
  })
  it('speech in the window is a voice block overlapping it', () => {
    const blocks = [{ start: 2, duration: 3.5 }, { start: 12.6, duration: 2.4, kind: 'jingle' as const }]
    expect(speechInWindow(blocks, 4, 9)).toBe(true)
    expect(speechInWindow(blocks, 6, 12.6)).toBe(false)
  })
  it('targets the speech level, or the base + 2 LU, clamped to ±12 dB', () => {
    expect(jingleGainDb(-20, -12, true)).toBe(-8)
    expect(jingleGainDb(-20, -12, false)).toBe(-6)
    expect(jingleGainDb(-20, -40, false)).toBe(12)
    expect(jingleGainDb(-30, -10, true)).toBe(-12)
    expect(jingleGainDb(null, -12, true)).toBe(0)
    expect(jingleGainDb(-70, -12, false)).toBe(0)
  })
  it('accepts kind and up to 5 blocks; a legacy block still parses', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: 2 }] }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: 2, kind: 'jingle' }] }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: Array.from({ length: 5 }, () => ({ audioFileId: 'a', startSeconds: 1 })) }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: Array.from({ length: 6 }, () => ({ audioFileId: 'a', startSeconds: 1 })) }).success).toBe(false)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: 2, kind: 'song' }] }).success).toBe(false)
  })
})
```

Append to `mixMusicBed.test.ts` (import `buildMusicBedFilter` and `inputSchema`):

```ts
describe('buildMusicBedFilter (J6)', () => {
  it('is byte-identical without fadeOutAtSeconds (Review Focus 2)', () => {
    expect(buildMusicBedFilter()).toBe('[1:a]volume=0.35[bedvol];[bedvol][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[duckedbed];[0:a][duckedbed]amix=inputs=2:duration=longest:normalize=0[premaster];[premaster]loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
  })
  it('fades the bed out over 0.5s ending at fadeOutAtSeconds', () => {
    expect(buildMusicBedFilter(12.3)).toContain('[1:a]volume=0.35,afade=t=out:st=11.8:d=0.5[bedvol]')
  })
  it('accepts fadeOutAtSeconds as optional', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v', musicFileId: 'm', fadeOutAtSeconds: 12.3 }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', musicFileId: 'm', fadeOutAtSeconds: -1 }).success).toBe(false)
  })
})
```

Create `mixVoiceover.realffmpeg.test.ts`:

```ts
// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { levelMatchJingles, loudnessProbeArgs } from './mixVoiceover.js'
import { parseIntegratedLoudness } from './mixMusicBed.js'

const lufs = (args: string[]): number => parseIntegratedLoudness(spawnSync('ffmpeg', ['-nostats', ...args], { encoding: 'utf8' }).stderr)!

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('jingle level match on real ffmpeg (J6)', () => {
  it('a jingle about 8 LU too loud comes out within ±1 LU of the target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jingle-level-'))
    const base = join(dir, 'base.wav'), jingle = join(dir, 'jingle.wav')
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=10', '-af', 'volume=-20dB', base])
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000:duration=2', '-af', 'volume=-10dB', jingle])

    const windowLufs = lufs(['-ss', '1', '-t', '5', '-i', base, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'])
    const target = windowLufs + 2 // no speech in the window: base + 2 LU
    const jingleLufs = lufs(loudnessProbeArgs(jingle))
    expect(jingleLufs - target).toBeGreaterThan(6) // it really starts too loud
    expect(jingleLufs - target).toBeLessThan(11)

    const [matched] = await levelMatchJingles([base, jingle], [{ start: 6, duration: 2, kind: 'jingle' }], [jingleLufs], true)
    const after = lufs(['-i', jingle, '-af', `volume=${matched.gainDb}dB,ebur128=framelog=verbose`, '-f', 'null', '-'])
    expect(Math.abs(after - target)).toBeLessThanOrEqual(1)
  }, 60_000)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/mixVoiceover.test.ts src/mastra/tools/mixMusicBed.test.ts`
Expected: FAIL (missing exports, schema rejects `kind`).

- [ ] **Step 3: Implement `mixVoiceover.ts`**

1. Change the block schema to:

```ts
  blocks: z.array(z.object({
    audioFileId: z.string().describe('One voiceover block from generate_narration, or the sign-off from generate_jingle'),
    startSeconds: z.number().min(0).describe('Where this block starts in the video, from the TVC plan'),
    kind: z.enum(['voice', 'jingle']).optional().describe('jingle = the sung sign-off (signoffFileId at the finish slice\'s signoffStartSeconds): level-matched to the speech before it instead of ducking. Default voice'),
  })).min(1).max(5),
```

2. Replace `buildVoiceoverFilter` with:

```ts
export type MixBlock = { start: number; duration: number; kind?: 'voice' | 'jingle'; gainDb?: number }

// tail replaces the master on the probe graph (a window measurement);
// muteJingles silences jingle blocks there so the window holds only what
// the jingle has to match. A call without kind builds the same graph as
// before, byte for byte.
export function buildVoiceoverFilter(blocks: MixBlock[], baseHasAudio: boolean, tail: string = MASTER, muteJingles = false): string {
  const parts = blocks.map((b, i) => {
    const ms = Math.round(b.start * 1000)
    const gain = b.kind !== 'jingle' ? '' : muteJingles ? 'volume=0,' : b.gainDb !== undefined ? `volume=${b.gainDb}dB,` : ''
    return `[${i + 1}:a]${gain}adelay=${ms}|${ms}[vo${i}]`
  })
  parts.push(blocks.length === 1
    ? '[vo0]anull[vo]'
    : `${blocks.map((_, i) => `[vo${i}]`).join('')}amix=inputs=${blocks.length}:duration=longest:normalize=0[vo]`)
  if (!baseHasAudio) {
    parts.push(`[vo]apad,${tail}[outa]`)
    return parts.join(';')
  }
  // A jingle neither ducks the base nor is ducked: only voice blocks open a window.
  const voiced = blocks.filter((b) => b.kind !== 'jingle')
  const windows = voiced.map((b) => `between(t,${r2(b.start)},${r2(b.start + b.duration)})`).join('+')
  parts.push(voiced.length ? `[0:a]volume=${DUCK_VOLUME}:enable='${windows}'[base]` : '[0:a]anull[base]')
  parts.push('[base][vo]amix=inputs=2:duration=first:normalize=0[pre]')
  parts.push(`[pre]${tail}[outa]`)
  return parts.join(';')
}

// J6: a sung sign-off came out about 8 LU louder than the speech when not
// matched (2026-10-05). It is set to the loudness of the 5s before it: the
// speech level when someone speaks there, otherwise the base + 2 LU.
export const JINGLE_WINDOW_SECONDS = 5
const JINGLE_OVER_BASE_LU = 2
const JINGLE_MAX_GAIN_DB = 12

export function jingleWindow(start: number): { from: number; to: number } | null {
  const from = Math.max(0, start - JINGLE_WINDOW_SECONDS)
  return start - from >= 0.5 ? { from: r2(from), to: r2(start) } : null
}

export const speechInWindow = (blocks: MixBlock[], from: number, to: number): boolean =>
  blocks.some((b) => b.kind !== 'jingle' && b.start < to && b.start + b.duration > from)

export function jingleGainDb(windowLufs: number | null, jingleLufs: number, speech: boolean): number {
  if (windowLufs === null || windowLufs <= -60) return 0
  const target = windowLufs + (speech ? 0 : JINGLE_OVER_BASE_LU)
  const gain = Math.min(JINGLE_MAX_GAIN_DB, Math.max(-JINGLE_MAX_GAIN_DB, target - jingleLufs))
  return Math.round(gain * 10) / 10
}

/** inputs = [video, ...block audio], in the same order as blocks. Never throws: an unmeasurable window leaves the jingle at 0 dB. */
export async function levelMatchJingles(inputs: string[], blocks: MixBlock[], blockLufs: number[], baseHasAudio: boolean): Promise<MixBlock[]> {
  return Promise.all(blocks.map(async (b, i) => {
    if (b.kind !== 'jingle') return b
    const win = jingleWindow(b.start)
    let windowLufs: number | null = null
    if (win) {
      try {
        const probe = buildVoiceoverFilter(blocks, baseHasAudio, `atrim=start=${win.from}:end=${win.to},ebur128=framelog=verbose`, true)
        const { stderr } = await execFile('ffmpeg', ['-nostats', ...inputs.flatMap((p) => ['-i', p]), '-filter_complex', probe, '-map', '[outa]', '-f', 'null', '-'], { timeout: FFMPEG_TIMEOUT_MS })
        windowLufs = parseIntegratedLoudness(stderr)
      } catch (err) {
        console.warn('[mixVoiceover] jingle window probe failed, leaving the jingle at 0 dB:', (err as Error).message)
      }
    }
    return { ...b, gainDb: jingleGainDb(windowLufs, blockLufs[i], win ? speechInWindow(blocks, win.from, win.to) : false) }
  }))
}
```

3. In `execute`:
   - Change `let timed: Array<{ start: number; duration: number }>` to `let timed: MixBlock[]`, and add `const blockLufs: number[] = []` next to it.
   - Change the `timed = await Promise.all(...)` line to:

```ts
      timed = await Promise.all(voPaths.map(async (p, i) => ({
        start: blocks[i].startSeconds, duration: await durationOf(p),
        ...(blocks[i].kind === 'jingle' ? { kind: 'jingle' as const } : {}),
      })))
```

   - In the loudness loop, push each measured value: after the `VOICEOVER_INAUDIBLE` guard add `blockLufs.push(lufs)`.
   - After the `voiceoverFitsVideo` refusal line, add:

```ts
    if (timed.some((b) => b.kind === 'jingle')) timed = await levelMatchJingles([videoPath, ...voPaths], timed, blockLufs, baseHasAudio)
```

4. Append to the tool `description`: ` A block with kind "jingle" (the sung sign-off) is level-matched to the speech before it and never ducks the sound.`

- [ ] **Step 4: Implement `mixMusicBed.ts`**

1. Add to `inputSchema`: `fadeOutAtSeconds: z.number().positive().optional().describe('TVC with a sung sign-off: the finish slice\'s musicFadeOutAtSeconds. The bed fades out over 0.5s ending here, so it clears before the sung line.'),`
2. Add above the tool:

```ts
const BED_FADE_SECONDS = 0.5
const r2 = (x: number) => Math.round(x * 100) / 100

/** Without fadeOutAtSeconds the graph is the same as before, byte for byte. */
export function buildMusicBedFilter(fadeOutAtSeconds?: number): string {
  const fade = fadeOutAtSeconds === undefined ? '' : `,afade=t=out:st=${r2(Math.max(0, fadeOutAtSeconds - BED_FADE_SECONDS))}:d=${BED_FADE_SECONDS}`
  return `[1:a]volume=${BED_VOLUME}${fade}[bedvol];` +
    `[bedvol][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[duckedbed];` +
    `[0:a][duckedbed]amix=inputs=2:duration=longest:normalize=0[premaster];` +
    `[premaster]loudnorm=I=-14:TP=-1.5:LRA=11[outa]`
}
```

3. In `execute`, destructure `fadeOutAtSeconds` with the other inputs, and replace the inline `const filterComplex = ...` (four concatenated lines) with `const filterComplex = buildMusicBedFilter(fadeOutAtSeconds)`. Keep the sidechain comment above it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/mixVoiceover.test.ts src/mastra/tools/mixMusicBed.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS, including the pre-existing tests.

Run: `RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/mixVoiceover.realffmpeg.test.ts`
Expected: PASS. If the result is off by more than 1 LU, report the measured numbers; do not widen the tolerance.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/mixVoiceover.ts apps/agent-orchestrator/src/mastra/tools/mixVoiceover.test.ts apps/agent-orchestrator/src/mastra/tools/mixVoiceover.realffmpeg.test.ts apps/agent-orchestrator/src/mastra/tools/mixMusicBed.ts apps/agent-orchestrator/src/mastra/tools/mixMusicBed.test.ts
git commit -m "feat(tvc): the sung sign-off is level-matched to the speech and the bed clears for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: K1, check records in Mastra thread metadata

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.testing.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/checkStill.ts:10-17,51`
- Modify: `apps/agent-orchestrator/src/mastra/tools/checkClip.ts:87-121,223`
- Modify: `apps/agent-orchestrator/src/mastra/tools/planTvc.ts` (`PlanTvcDeps.stillChecked`, the record loop, `execute`)
- Test: `checkStill.test.ts` (rewrite shown below), `checkClip.test.ts:2` (one import line), `checkClip.narrow.test.ts` (one `beforeEach` line), `planTvc.test.ts` (one new test)

**Interfaces:**
- Consumes: `getOlmoMemory()` from `../memory.js` (dynamic import), and its `getThreadById({ threadId })` / `updateThread({ id, metadata })`. `@mastra/pg`'s `updateThread` merges top-level metadata (`{ ...existingThread.metadata, ...metadata }`, `node_modules/@mastra/pg/dist/index.js` ~line 10541). Thread metadata is a Postgres `jsonb` column, which does not keep object key order.
- Produces:
  - `export type CheckInputs` (moved here from `checkClip.ts`; `checkClip.ts` imports it)
  - `export interface CheckScope { threadId: string; resourceId: string }`
  - `export interface TvcCheckRecords { passedStills: string[]; checkedWith: Record<string, CheckInputs>; checkedOrder: string[] }`
  - `export interface ThreadMetaStore`, `export function setCheckRecordStore(store: ThreadMetaStore | null): void`
  - `export function checkScopeOf(rc): CheckScope`
  - `export async function loadCheckRecords(scope): Promise<TvcCheckRecords | null>` (null = missing, foreign or unreadable thread)
  - `export async function updateCheckRecords(scope, change: (r) => TvcCheckRecords | null): Promise<'written' | 'unchanged' | 'unavailable'>`
  - `export const MAX_CHECK_RECORDS = 200`
  - `checkStill.ts`: `markStillPassed(scope: CheckScope, stillFileId: string): Promise<boolean>`, `stillPassedCheck(scope: CheckScope, stillFileId: string): Promise<boolean>`
  - `checkClip.ts`: `mergeCheckInputs(before, now)`, `droppedCheckInputsFallback(key, now)` (today's in-process map, unchanged rules), `droppedCheckInputs(scope: CheckScope, clipFileId: string, now: CheckInputs): Promise<string[]>`
  - `PlanTvcDeps.stillChecked: (stillFileId: string) => boolean | Promise<boolean>`

- [ ] **Step 1: Write the test store and the failing tests**

Create `tvcCheckRecords.testing.ts`:

```ts
import type { StoredThread, ThreadMetaStore } from './tvcCheckRecords.js'

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
      : v

/** An in-memory thread store for tests. Like @mastra/pg it merges top-level
 *  metadata on update; like a jsonb column it does not keep key order (it
 *  sorts keys), so a test fails if code reads "oldest" from key order. */
export function inMemoryThreadStore(threads: StoredThread[] = []) {
  const rows = new Map(threads.map((t) => [t.id, structuredClone({ ...t, metadata: t.metadata ?? {} })]))
  const updates: Array<{ id: string; metadata: Record<string, unknown> }> = []
  const store: ThreadMetaStore = {
    async getThreadById({ threadId }) {
      await new Promise((r) => setTimeout(r, 1))
      const t = rows.get(threadId)
      return t ? structuredClone(t) : null
    },
    async updateThread({ id, metadata }) {
      await new Promise((r) => setTimeout(r, 1))
      const t = rows.get(id)
      if (!t) throw new Error(`Thread ${id} not found`)
      updates.push({ id, metadata: structuredClone(metadata) })
      t.metadata = sortKeys({ ...t.metadata, ...metadata }) as Record<string, unknown>
      return structuredClone(t)
    },
  }
  return { store, rows, updates }
}
```

Create `tvcCheckRecords.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_CHECK_RECORDS, loadCheckRecords, setCheckRecordStore } from './tvcCheckRecords.js'
import { inMemoryThreadStore } from './tvcCheckRecords.testing.js'
import { markStillPassed, stillPassedCheck } from './checkStill.js'
import { droppedCheckInputs } from './checkClip.js'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))

const mine = { threadId: 'conv-1', resourceId: 'tenant-A' }
const none = { expectedLine: false, product: false, reference: false }
const all = { expectedLine: true, product: true, reference: true }

let env: ReturnType<typeof inMemoryThreadStore>
beforeEach(() => {
  env = inMemoryThreadStore([
    { id: 'conv-1', resourceId: 'tenant-A', metadata: { workingMemory: '# Brand Context\n- Brand Name: Bubbli', skillTest: { installId: 'i1' } } },
    { id: 'conv-B', resourceId: 'tenant-B', metadata: {} },
  ])
  setCheckRecordStore(env.store)
})

describe('K1: check records live in the thread', () => {
  it('a passed still and a clip\'s check inputs survive a restart (fresh modules, same store)', async () => {
    expect(await markStillPassed(mine, 's1')).toBe(true)
    expect(await droppedCheckInputs(mine, 'clip-1', all)).toEqual([])

    vi.resetModules()
    const records = await import('./tvcCheckRecords.js')
    records.setCheckRecordStore(env.store)
    const still = await import('./checkStill.js')
    const clip = await import('./checkClip.js')
    expect(await still.stillPassedCheck(mine, 's1')).toBe(true)
    expect(await clip.droppedCheckInputs(mine, 'clip-1', none)).toEqual(['expectedLine', 'product', 'reference'])
  })

  it('keeps every other metadata key and writes only tvcChecks', async () => {
    await markStillPassed(mine, 's1')
    expect(env.updates.every((u) => Object.keys(u.metadata).join() === 'tvcChecks')).toBe(true)
    const meta = env.rows.get('conv-1')!.metadata!
    expect(meta.workingMemory).toBe('# Brand Context\n- Brand Name: Bubbli')
    expect(meta.skillTest).toEqual({ installId: 'i1' })
  })

  it('caps each list at 200, dropping the oldest first, even though jsonb sorts keys', async () => {
    for (let i = 0; i < MAX_CHECK_RECORDS + 5; i++) await markStillPassed(mine, `s${i}`)
    for (let i = 0; i < MAX_CHECK_RECORDS + 5; i++) await droppedCheckInputs(mine, `z-clip-${String(1000 - i)}`, none)
    const r = (await loadCheckRecords(mine))!
    expect(r.passedStills).toHaveLength(MAX_CHECK_RECORDS)
    expect(r.passedStills[0]).toBe('s5')
    expect(r.checkedOrder).toHaveLength(MAX_CHECK_RECORDS)
    expect(Object.keys(r.checkedWith)).toHaveLength(MAX_CHECK_RECORDS)
    expect(r.checkedWith['z-clip-1000']).toBeUndefined() // the first one written is the one dropped
    expect(r.checkedWith['z-clip-796']).toBeDefined()
  })

  it('parallel writes in one thread all land (read–merge–write under a lock)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => markStillPassed(mine, `p${i}`)))
    expect((await loadCheckRecords(mine))!.passedStills.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `p${i}`).sort())
  })
})

// Review Focus 3.
describe('K1: never writes a foreign or missing thread', () => {
  it.each([
    ['another tenant\'s thread', { threadId: 'conv-B', resourceId: 'tenant-A' }],
    ['a missing thread', { threadId: 'nope', resourceId: 'tenant-A' }],
    ['no thread id', { threadId: '', resourceId: 'tenant-A' }],
    ['no tenant', { threadId: 'conv-1', resourceId: '' }],
  ])('%s: no write, the still is not checked, and the re-check guard falls back to process memory', async (_name, scope) => {
    expect(await markStillPassed(scope, 's1')).toBe(false)
    expect(await stillPassedCheck(scope, 's1')).toBe(false)
    expect(await droppedCheckInputs(scope, 'clip-x', all)).toEqual([])
    expect(await droppedCheckInputs(scope, 'clip-x', none)).toEqual(['expectedLine', 'product', 'reference'])
    expect(env.updates).toEqual([])
    expect(env.rows.get('conv-B')!.metadata).toEqual({})
  })

  it('a store that throws on write counts as unavailable, never as a pass', async () => {
    const broken = inMemoryThreadStore([{ id: 'conv-1', resourceId: 'tenant-A' }])
    broken.store.updateThread = async () => { throw new Error('db down') }
    setCheckRecordStore(broken.store)
    expect(await markStillPassed(mine, 's1')).toBe(false)
    expect(await stillPassedCheck(mine, 's1')).toBe(false)
  })
})
```

Replace `checkStill.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
const { fetchBase64 } = vi.hoisted(() => ({ fetchBase64: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })) }))
vi.mock('./checkClip.js', () => ({ fetchBase64 }))
const { runStillChecks } = vi.hoisted(() => ({ runStillChecks: vi.fn() }))
vi.mock('./tvcChecks.js', async (orig) => {
  const actual = await orig<typeof import('./tvcChecks.js')>()
  return { ...actual, runStillChecks, gatewayAsk: () => async () => ({}) }
})

import { checkStill, stillPassedCheck, markStillPassed } from './checkStill.js'
import { CheckUnavailableError } from './tvcChecks.js'
import { setCheckRecordStore } from './tvcCheckRecords.js'
import { inMemoryThreadStore } from './tvcCheckRecords.testing.js'

const scope = (threadId = 'c-still') => ({ threadId, resourceId: 't1' })
function ctx(conv = 'c-still') {
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', conversationId: conv, idToken: 'tok' })) rc.set(k, v)
  return { requestContext: rc } as never
}

beforeEach(() => {
  runStillChecks.mockReset()
  setCheckRecordStore(inMemoryThreadStore(['c-still', 'a', 'b'].map((id) => ({ id, resourceId: 't1' }))).store)
})

describe('check_still', () => {
  it('records a passing still so plan_tvc will accept it', async () => {
    runStillChecks.mockResolvedValue({ passed: true, reasons: [] })
    const r = await checkStill.execute!({ stillFileId: 's1', productFileId: 'p1', productScale: 'close', productMustBeVisible: true } as never, ctx())
    expect(r).toMatchObject({ passed: true })
    expect(await stillPassedCheck(scope(), 's1')).toBe(true)
  })
  it('a failing still is not recorded and returns the reasons', async () => {
    runStillChecks.mockResolvedValue({ passed: false, reasons: ['LEAD_CLONED: a background person looks like the lead (frame 1: left).'] })
    const r = await checkStill.execute!({ stillFileId: 's2', actorFileId: 'av1', expectExtras: true } as never, ctx())
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/LEAD_CLONED/) })
    expect(await stillPassedCheck(scope(), 's2')).toBe(false)
  })
  it('an unreachable check is CHECK_UNAVAILABLE, never a pass', async () => {
    runStillChecks.mockRejectedValue(new CheckUnavailableError('check unavailable: gateway 500'))
    const r = await checkStill.execute!({ stillFileId: 's3' } as never, ctx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/) })
    expect(await stillPassedCheck(scope(), 's3')).toBe(false)
  })
  it('a plain Error from the check path is also CHECK_UNAVAILABLE, never CHECK_FAILED or a crash', async () => {
    runStillChecks.mockRejectedValue(new Error('boom'))
    const r = await checkStill.execute!({ stillFileId: 's4' } as never, ctx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/) })
    expect(await stillPassedCheck(scope(), 's4')).toBe(false)
  })
  it('passed stills are per conversation', async () => {
    await markStillPassed(scope('a'), 'x')
    expect(await stillPassedCheck(scope('a'), 'x')).toBe(true)
    expect(await stillPassedCheck(scope('b'), 'x')).toBe(false)
  })
  it('a pass that cannot be stored says so (CHECK_RECORD_UNAVAILABLE)', async () => {
    runStillChecks.mockResolvedValue({ passed: true, reasons: [] })
    const r = await checkStill.execute!({ stillFileId: 's5' } as never, ctx('not-a-thread'))
    expect(r).toMatchObject({ passed: true, reason: expect.stringMatching(/CHECK_RECORD_UNAVAILABLE/) })
  })
})
```

In `checkClip.test.ts`, change only line 2 to:

```ts
import { droppedCheckInputsFallback as droppedCheckInputs, lineMatchScore, parseVerdict, buildCheckQuestion, judgeVerdict, narrowWanted, droppedCheckInputsFallback as dropped2 } from './checkClip.js'
```

(The rule tests keep running against the same rules, now shared through `mergeCheckInputs`; the thread path is tested in `tvcCheckRecords.test.ts`.)

In `checkClip.narrow.test.ts`, add the imports `import { setCheckRecordStore } from './tvcCheckRecords.js'` and `import { inMemoryThreadStore } from './tvcCheckRecords.testing.js'`, and as the last line of its `beforeEach`: `setCheckRecordStore(inMemoryThreadStore([{ id: 'c-narrow', resourceId: 't1' }]).store)`.

Search for every other test that executes `checkClip` or `checkStill`, and give it a store the same way, so no test reaches the real `memory.js`:

Run: `grep -rln "checkClip.execute\|checkStill.execute" apps/agent-orchestrator/src`

Append to `planTvc.test.ts`:

```ts
describe('plan_tvc record: async still records (K1)', () => {
  it('awaits an async stillChecked and refuses an unchecked still', async () => {
    const { deps } = fakeDeps()
    deps.stillChecked = async (id) => id === 'good'
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(await runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 1, stillFileId: 'bad' }, deps)).toMatchObject({ refusalReason: expect.stringMatching(/^STILL_NOT_CHECKED/) })
    expect(await runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 1, stillFileId: 'good' }, deps)).toEqual({ planFileId })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcCheckRecords.test.ts src/mastra/tools/checkStill.test.ts src/mastra/tools/checkClip.test.ts src/mastra/tools/planTvc.test.ts`
Expected: FAIL (missing module and exports).

- [ ] **Step 3: Implement `tvcCheckRecords.ts`**

```ts
// Part A kept two TVC check records in process memory: check_still's passed
// stills and check_clip's re-check guard. A pm2 restart forgot both. They now
// live in the conversation thread's metadata, through Mastra's own
// Memory.getThreadById / updateThread on the existing PostgresStore — no new
// table (spec 2026-10-05-tvc-jingle-design.md K1).
//
// Which memory: getOlmoMemory(), the instance that owns the user's
// conversation thread. Never getMastraMemory(), and never a scope change —
// see the cross-tenant warning above getOlmoMemory in ../memory.ts.
//
// Write guard: a thread is read or written only when it exists and its
// resourceId is this request's tenant. Anything else falls back to today's
// behaviour (a still is "not checked"; the re-check guard uses process memory).

export type CheckInputs = { expectedLine: boolean; product: boolean; reference: boolean; noSpeech?: boolean; presenter?: boolean; productVisible?: boolean; extras?: boolean; lead?: boolean; action?: boolean; endState?: boolean; productNarrow?: boolean; productExpectedState?: boolean }

export interface CheckScope { threadId: string; resourceId: string }
// checkedOrder holds the clip ids oldest first: thread metadata is a jsonb
// column, which does not keep object key order.
export interface TvcCheckRecords { passedStills: string[]; checkedWith: Record<string, CheckInputs>; checkedOrder: string[] }
export interface StoredThread { id: string; resourceId: string; metadata?: Record<string, unknown> | null }
export interface ThreadMetaStore {
  getThreadById(args: { threadId: string }): Promise<StoredThread | null>
  updateThread(args: { id: string; metadata: Record<string, unknown> }): Promise<unknown>
}

export const MAX_CHECK_RECORDS = 200
const RECORDS_KEY = 'tvcChecks'

let storeOverride: ThreadMetaStore | null = null
/** Tests only: swap in an in-memory store (tvcCheckRecords.testing.ts). */
export function setCheckRecordStore(store: ThreadMetaStore | null): void { storeOverride = store }

async function threadStore(): Promise<ThreadMetaStore> {
  if (storeOverride) return storeOverride
  const { getOlmoMemory } = await import('../memory.js')
  const memory = getOlmoMemory()
  return {
    getThreadById: ({ threadId }) => memory.getThreadById({ threadId }),
    // Only our key is sent: @mastra/pg merges top-level metadata, so the
    // title and working memory are kept and never rewritten from a stale read.
    updateThread: ({ id, metadata }) => memory.updateThread({ id, metadata }),
  }
}

/** The conversation thread (= the Mastra thread id chatStream streams with) and the tenant. */
export function checkScopeOf(rc: { get: (key: string) => unknown } | undefined): CheckScope {
  return { threadId: (rc?.get('conversationId') as string | undefined) ?? '', resourceId: (rc?.get('tenantId') as string | undefined) ?? '' }
}

export function readRecords(metadata: Record<string, unknown> | null | undefined): TvcCheckRecords {
  const raw = (metadata?.[RECORDS_KEY] ?? {}) as Partial<TvcCheckRecords>
  const passedStills = Array.isArray(raw.passedStills) ? raw.passedStills.filter((s): s is string => typeof s === 'string') : []
  const checkedWith = raw.checkedWith && typeof raw.checkedWith === 'object' && !Array.isArray(raw.checkedWith) ? { ...raw.checkedWith } : {}
  const order = Array.isArray(raw.checkedOrder) ? raw.checkedOrder.filter((k): k is string => typeof k === 'string' && k in checkedWith) : []
  const checkedOrder = [...order, ...Object.keys(checkedWith).filter((k) => !order.includes(k))]
  return { passedStills, checkedWith, checkedOrder }
}

export function capRecords(r: TvcCheckRecords): TvcCheckRecords {
  const checkedOrder = r.checkedOrder.slice(-MAX_CHECK_RECORDS)
  return {
    passedStills: r.passedStills.slice(-MAX_CHECK_RECORDS),
    checkedOrder,
    checkedWith: Object.fromEntries(checkedOrder.map((k) => [k, r.checkedWith[k]])),
  }
}

async function ownedThread(scope: CheckScope): Promise<StoredThread | null> {
  if (!scope.threadId || !scope.resourceId) return null
  try {
    const thread = await (await threadStore()).getThreadById({ threadId: scope.threadId })
    return thread && thread.resourceId === scope.resourceId ? thread : null
  } catch (err) {
    console.warn('[tvcCheckRecords] thread read failed:', (err as Error).message)
    return null
  }
}

export async function loadCheckRecords(scope: CheckScope): Promise<TvcCheckRecords | null> {
  const thread = await ownedThread(scope)
  return thread ? readRecords(thread.metadata) : null
}

// Parallel tool calls in one thread (Director checks several stills at once)
// would each read, change and write: one process, so a promise chain per
// thread serialises them (same pattern as planTvc's withPlanLock).
const threadLocks = new Map<string, Promise<void>>()
async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const previous = threadLocks.get(threadId) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail = run.then(() => undefined, () => undefined)
  threadLocks.set(threadId, tail)
  try {
    return await run
  } finally {
    if (threadLocks.get(threadId) === tail) threadLocks.delete(threadId)
  }
}

/** Read–merge–write. change returns null to write nothing. */
export async function updateCheckRecords(scope: CheckScope, change: (r: TvcCheckRecords) => TvcCheckRecords | null): Promise<'written' | 'unchanged' | 'unavailable'> {
  return withThreadLock(scope.threadId, async () => {
    const thread = await ownedThread(scope)
    if (!thread) return 'unavailable'
    const next = change(readRecords(thread.metadata))
    if (!next) return 'unchanged'
    try {
      await (await threadStore()).updateThread({ id: scope.threadId, metadata: { [RECORDS_KEY]: capRecords(next) } })
      return 'written'
    } catch (err) {
      console.warn('[tvcCheckRecords] thread write failed:', (err as Error).message)
      return 'unavailable'
    }
  })
}
```

If `tsc` rejects the `getOlmoMemory()` method types in `threadStore` (e.g. `metadata` typed differently on `StorageThreadType`), cast only inside the wrapper (`as Promise<StoredThread | null>`); do not loosen `ThreadMetaStore`.

- [ ] **Step 4: Move the callers**

`checkStill.ts`: delete the `passedStills` map and the two functions (lines 10–17), and add:

```ts
import { checkScopeOf, loadCheckRecords, updateCheckRecords, type CheckScope } from './tvcCheckRecords.js'

// Passed stills live in the conversation thread's metadata (K1), so a
// restart no longer forgets them. false = not stored (missing or foreign
// thread, or the store is down); plan_tvc will then treat it as unchecked.
export async function markStillPassed(scope: CheckScope, stillFileId: string): Promise<boolean> {
  const out = await updateCheckRecords(scope, (r) => ({ ...r, passedStills: [...r.passedStills.filter((id) => id !== stillFileId), stillFileId] }))
  return out !== 'unavailable'
}
export async function stillPassedCheck(scope: CheckScope, stillFileId: string): Promise<boolean> {
  return !!(await loadCheckRecords(scope))?.passedStills.includes(stillFileId)
}
```

In `execute`, remove the now-unused `conversationId` read, and replace `if (r.passed) markStillPassed(conversationId, i.stillFileId)` and the `return` after it with:

```ts
      if (r.passed && !(await markStillPassed(checkScopeOf(execContext?.requestContext), i.stillFileId))) {
        return { passed: true, reason: 'The still passed every check, but this conversation could not store the result (CHECK_RECORD_UNAVAILABLE), so plan_tvc will not record it. Tell Olmo.' }
      }
      return { passed: r.passed, reason: r.passed ? 'The still passed every check.' : r.reasons.join(' ') }
```

`checkClip.ts`: replace the `type CheckInputs = ...` line and the `checkedWith` map plus `droppedCheckInputs` (lines 96–121) with the following. Keep the comment block above them.

```ts
import { checkScopeOf, updateCheckRecords, type CheckInputs, type CheckScope } from './tvcCheckRecords.js'

const CHECK_KEYS = ['expectedLine', 'product', 'reference', 'noSpeech', 'presenter', 'productVisible', 'extras', 'lead', 'action', 'endState', 'productNarrow', 'productExpectedState'] as const

/** The re-check rules (unchanged): a re-check may add inputs, never drop them. */
export function mergeCheckInputs(before: CheckInputs | undefined, now: CheckInputs): { dropped: string[]; merged: CheckInputs } {
  const dropped = before ? CHECK_KEYS.filter((k) => before[k] && !now[k]) : []
  const merged: CheckInputs = {
    expectedLine: now.expectedLine || !!before?.expectedLine,
    product: now.product || !!before?.product,
    reference: now.reference || !!before?.reference,
    noSpeech: !!now.noSpeech || !!before?.noSpeech,
    presenter: !!now.presenter || !!before?.presenter,
    productVisible: !!now.productVisible || !!before?.productVisible,
    extras: !!now.extras || !!before?.extras,
    lead: !!now.lead || !!before?.lead,
    action: !!now.action || !!before?.action,
    endState: !!now.endState || !!before?.endState,
    productNarrow: !!now.productNarrow || !!before?.productNarrow,
    productExpectedState: !!now.productExpectedState || !!before?.productExpectedState,
  }
  return { dropped, merged }
}

// Today's in-process record, kept only as the fallback when the thread
// cannot hold the record (missing, foreign, or the store is down).
const fallbackCheckedWith = new Map<string, CheckInputs>()
export function droppedCheckInputsFallback(key: string, now: CheckInputs): string[] {
  const { dropped, merged } = mergeCheckInputs(fallbackCheckedWith.get(key), now)
  if (dropped.length === 0) {
    if (fallbackCheckedWith.size > 1000) fallbackCheckedWith.delete(fallbackCheckedWith.keys().next().value as string)
    fallbackCheckedWith.set(key, merged)
  }
  return dropped
}

/** What a clip was first checked with lives in the thread's metadata (K1). */
export async function droppedCheckInputs(scope: CheckScope, clipFileId: string, now: CheckInputs): Promise<string[]> {
  let dropped: string[] = []
  const out = await updateCheckRecords(scope, (r) => {
    const res = mergeCheckInputs(r.checkedWith[clipFileId], now)
    dropped = res.dropped
    if (dropped.length) return null
    return { ...r, checkedWith: { ...r.checkedWith, [clipFileId]: res.merged }, checkedOrder: [...r.checkedOrder.filter((k) => k !== clipFileId), clipFileId] }
  })
  return out === 'unavailable' ? droppedCheckInputsFallback(`${scope.threadId}:${clipFileId}`, now) : dropped
}
```

In `execute` (line ~223), change `const dropped = droppedCheckInputs(\`${conversationId}:${clipFileId}\`, { ... })` to `const dropped = await droppedCheckInputs(checkScopeOf(execContext?.requestContext), clipFileId, { ... })`, keeping the object literal exactly as it is.

`planTvc.ts`:
- `PlanTvcDeps.stillChecked: (stillFileId: string) => boolean | Promise<boolean>`
- In the record loop: `if (!r.keptByUser && !(await deps.stillChecked(r.stillFileId))) return ...` (the reason text unchanged).
- In `execute`: `stillChecked: (id) => stillPassedCheck({ threadId: conversationId, resourceId: tenantId }, id),`

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcCheckRecords.test.ts src/mastra/tools/checkStill.test.ts src/mastra/tools/checkClip.test.ts src/mastra/tools/checkClip.narrow.test.ts src/mastra/tools/planTvc.test.ts
pnpm --filter agent-orchestrator test
pnpm --filter agent-orchestrator type-check
```

Expected: PASS. Then confirm no memory scope changed: `git diff apps/agent-orchestrator/src/mastra/memory.ts` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.ts apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.testing.ts apps/agent-orchestrator/src/mastra/tools/tvcCheckRecords.test.ts apps/agent-orchestrator/src/mastra/tools/checkStill.ts apps/agent-orchestrator/src/mastra/tools/checkStill.test.ts apps/agent-orchestrator/src/mastra/tools/checkClip.ts apps/agent-orchestrator/src/mastra/tools/checkClip.test.ts apps/agent-orchestrator/src/mastra/tools/checkClip.narrow.test.ts apps/agent-orchestrator/src/mastra/tools/planTvc.ts apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts
git commit -m "fix(tvc): check records live in the conversation thread, not process memory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add any other test file Step 1's grep found.)

---

### Task 7: K2, one face finder

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/findFaces.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/findFaces.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/cropImage.ts:24-26,79-127`
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts:315-322`
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcChecks.test.ts:225-228`
- Modify: `apps/agent-orchestrator/src/mastra/tools/overlayText.ts:193-197`, `compositeEndCard.ts:226`
- Unchanged and must pass: `apps/agent-orchestrator/src/mastra/tools/cropImage.test.ts`

**Interfaces:**
- Consumes: the gateway's `/v1/chat/completions`, as `findHead` uses it today; `persistCost`.
- Produces:
  - `export type HeadBox = { x: number; y: number; w: number; h: number }` (moved here; `cropImage.ts` re-exports it)
  - `export const FACE_MODEL = 'gemini-3.6-flash'`, `export const FIND_FACES_QUESTION: string`
  - `export function parseBox2dList(raw: string): HeadBox[]`
  - `export function parseFractionBox(raw: string): HeadBox | null`
  - `export function largestBox(boxes: HeadBox[]): HeadBox | null`
  - `export class FaceFinderError extends Error`
  - `export async function findFaces(image: { data: string; mime: string }, opts: { tenantId?: string; agentId: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<HeadBox[]>` (throws `FaceFinderError` on a gateway error or an unreadable reply; `[]` when there is no one)
  - `tvcChecks.ts`: `faceBoxes(tenantId: string, frame: Img, fetchImpl?: typeof fetch): Promise<Box[]>` (was `(ask, frame)`; it retries once, then throws `CheckUnavailableError`). `chooseTextPosition` and `chooseCardColumn` are unchanged.

- [ ] **Step 1: Write the failing tests**

Create `findFaces.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))

import { FACE_MODEL, FIND_FACES_QUESTION, FaceFinderError, findFaces, largestBox, parseBox2dList, parseFractionBox } from './findFaces.js'

const reply = (content: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch
const img = { data: 'QUJD', mime: 'image/jpeg' }

describe('parseBox2dList (K2)', () => {
  it('reads every valid box_2d, in order', () => {
    expect(parseBox2dList('```json\n[{"box_2d":[100,100,200,200],"label":"head"},{"box_2d":[0,500,500,750],"label":"head"}]\n```')).toEqual([
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.5, y: 0, w: 0.25, h: 0.5 },
    ])
  })
  it('skips out-of-range or inverted boxes', () => {
    expect(parseBox2dList('[{"box_2d":[0,0,1200,10]},{"box_2d":[500,500,400,600]}]')).toEqual([])
  })
})

describe('largestBox (Review Focus 4)', () => {
  it('largestBox picks the biggest head, and null for none', () => {
    expect(largestBox([{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, { x: 0.5, y: 0, w: 0.25, h: 0.5 }])).toEqual({ x: 0.5, y: 0, w: 0.25, h: 0.5 })
    expect(largestBox([])).toBeNull()
  })
})

describe('findFaces (K2)', () => {
  it('asks the shared box_2d question on gemini-3.6-flash and returns every head', async () => {
    const f = reply('[{"box_2d":[222,227,563,695],"label":"head"}]')
    const boxes = await findFaces(img, { tenantId: 't1', agentId: 'crop-image', fetchImpl: f })
    expect(boxes).toHaveLength(1)
    const body = JSON.parse(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.model).toBe(FACE_MODEL)
    expect(body.messages[0].content[1].text).toBe(FIND_FACES_QUESTION)
  })
  it('an empty list is no faces; a fraction reply still works; garbage throws', async () => {
    expect(await findFaces(img, { agentId: 'x', fetchImpl: reply('[]') })).toEqual([])
    expect(await findFaces(img, { agentId: 'x', fetchImpl: reply('{"x":0.4,"y":0.08,"w":0.15,"h":0.11}') })).toEqual([{ x: 0.4, y: 0.08, w: 0.15, h: 0.11 }])
    await expect(findFaces(img, { agentId: 'x', fetchImpl: reply('no idea') })).rejects.toBeInstanceOf(FaceFinderError)
    await expect(findFaces(img, { agentId: 'x', fetchImpl: reply('', 500) })).rejects.toBeInstanceOf(FaceFinderError)
  })
  it('parseFractionBox keeps crop_image\'s old rules', () => {
    expect(parseFractionBox('{"x":400,"y":80,"w":150,"h":110}')).toBeNull()
    expect(parseFractionBox('{"x":0.9,"y":0.1,"w":0.3,"h":0.1}')).toBeNull()
  })
})
```

In `tvcChecks.test.ts`, replace the `'faceBoxes drops malformed boxes'` test (lines 225–228) with:

```ts
  it('faceBoxes returns every head from the shared finder, as corners', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"box_2d":[100,100,200,200]},{"box_2d":[0,500,500,750]},{"box_2d":[0,0,1200,10]}]' } }] }), { status: 200 })) as unknown as typeof fetch
    expect(await faceBoxes('t1', img('F'), fetchImpl)).toEqual([{ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, { x0: 0.5, y0: 0, x1: 0.75, y1: 0.5 }])
  })
  it('faceBoxes retries once, then reports the check unavailable (callers keep the requested placement)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    await expect(faceBoxes('t1', img('F'), fetchImpl)).rejects.toBeInstanceOf(CheckUnavailableError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
```

(Import `CheckUnavailableError` in that file if it is not imported yet.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/findFaces.test.ts src/mastra/tools/tvcChecks.test.ts`
Expected: FAIL (missing module; `faceBoxes` signature).

- [ ] **Step 3: Implement `findFaces.ts`**

```ts
import { persistCost } from '../cost.js'

// One face finder for every tool that needs to know where people are
// (spec 2026-10-05-tvc-jingle-design.md K2). crop_image takes the largest
// head; overlay_text and composite_end_card keep text off all of them. It
// asks for Gemini's native box_2d detection: gemini-3.6-flash answers that
// way even when asked for x/y/w/h (2026-10-03: every crop silently fell back
// to a top-centre guess until box_2d was parsed).
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
export const FACE_MODEL = 'gemini-3.6-flash'
export const FIND_FACES_QUESTION = 'Detect the head of every person (or character) in this image, from the top of the hair to the chin. Reply ONLY with a JSON array, one entry per head: [{"box_2d":[ymin,xmin,ymax,xmax],"label":"head"}], coordinates on a 0-1000 scale. Reply [] if there is no one.'

/** A box as fractions of the image (0..1); x and y are the top-left corner. */
export type HeadBox = { x: number; y: number; w: number; h: number }
export class FaceFinderError extends Error {}

const BOX_2D_RE = /"box_2d"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g

/** Every valid box_2d ([ymin, xmin, ymax, xmax] on 0-1000) in the reply, in order. */
export function parseBox2dList(raw: string): HeadBox[] {
  const out: HeadBox[] = []
  for (const m of raw.matchAll(BOX_2D_RE)) {
    const [ymin, xmin, ymax, xmax] = m.slice(1).map(Number)
    if ([ymin, xmin, ymax, xmax].some((n) => !Number.isFinite(n) || n < 0 || n > 1000) || ymax <= ymin || xmax <= xmin) continue
    out.push({ x: xmin / 1000, y: ymin / 1000, w: (xmax - xmin) / 1000, h: (ymax - ymin) / 1000 })
  }
  return out
}

/** {"x":..,"y":..,"w":..,"h":..} as fractions (crop_image's original format); null when unusable. */
export function parseFractionBox(raw: string): HeadBox | null {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const nums = ['x', 'y', 'w', 'h'].map((k) => Number(v[k]))
    if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return null
    const [x, y, w, h] = nums
    if (w <= 0.01 || h <= 0.01 || x + w > 1.001 || y + h > 1.001) return null
    return { x, y, w, h }
  } catch {
    return null
  }
}

export function largestBox(boxes: HeadBox[]): HeadBox | null {
  return boxes.reduce<HeadBox | null>((best, b) => (!best || b.w * b.h > best.w * best.h ? b : best), null)
}

export async function findFaces(
  image: { data: string; mime: string },
  opts: { tenantId?: string; agentId: string; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<HeadBox[]> {
  const res = await (opts.fetchImpl ?? fetch)(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST', signal: opts.signal,
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({
      model: FACE_MODEL, temperature: 0, max_tokens: 600,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } },
        { type: 'text', text: FIND_FACES_QUESTION },
      ] }],
    }),
  })
  if (!res.ok) throw new FaceFinderError(`face finder: gateway ${res.status}`)
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  if (opts.tenantId && json.usage) {
    persistCost({ tenantId: opts.tenantId, agentId: opts.agentId, workflowId: 'media-understanding', model: FACE_MODEL, inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 })
  }
  const content = json.choices?.[0]?.message?.content ?? ''
  const boxes = parseBox2dList(content)
  if (boxes.length) return boxes
  const single = parseFractionBox(content)
  if (single) return [single]
  if (/\[\s*\]/.test(content)) return []
  throw new FaceFinderError('face finder: unreadable reply')
}
```

- [ ] **Step 4: Point the callers at it**

`cropImage.ts`:
- Replace the `HeadBox` type line with `export type { HeadBox } from './findFaces.js'` plus `import { findFaces, largestBox, parseBox2dList, parseFractionBox, type HeadBox } from './findFaces.js'`.
- Delete the local `parseBox2d` (keep its comment, moved above `parseHeadBox`), and make `parseHeadBox`:

```ts
export function parseHeadBox(raw: string): HeadBox | null {
  return parseBox2dList(raw)[0] ?? parseFractionBox(raw)
}
```

- Replace `findHead`'s body with:

```ts
async function findHead(base64: string, mimeType: string, tenantId: string | undefined, signal: AbortSignal): Promise<HeadBox | null> {
  // The shared finder (K2); the main person is the largest head.
  try {
    return largestBox(await findFaces({ data: base64, mime: mimeType }, { tenantId, agentId: 'crop-image', signal }))
  } catch {
    return null
  }
}
```

- Remove `VISION_MODEL` and `INFERENCE_GATEWAY_URL` from `cropImage.ts` if nothing else uses them, and the `persistCost` import if it is unused.

`tvcChecks.ts`: delete `FACE_BOX_QUESTION` and the old `faceBoxes`, import `findFaces` from `./findFaces.js`, and add:

```ts
/** Every face (head) in a frame, as corners, from the shared finder (K2).
 *  Retries once; then CheckUnavailableError, and the callers keep the
 *  requested placement. */
export async function faceBoxes(tenantId: string, frame: Img, fetchImpl: typeof fetch = fetch): Promise<Box[]> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const faces = await findFaces(frame, { tenantId, agentId: 'check-clip', fetchImpl, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) })
      return faces.map((f) => ({ x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h }))
    } catch (err) {
      lastErr = err
    }
  }
  throw new CheckUnavailableError(`face check unavailable: ${(lastErr as Error)?.message ?? 'unknown'}`)
}
```

`overlayText.ts`: replace `const ask = gatewayAsk(tenantId)` (delete the line) and `return await faceBoxes(ask, frame)` with `return await faceBoxes(tenantId, frame)`. Remove `gatewayAsk` from its import if now unused.

`compositeEndCard.ts`: `const faces = await faceBoxes(gatewayAsk(tenantId), frame)` becomes `const faces = await faceBoxes(tenantId, frame)`. Remove `gatewayAsk` from its import if now unused.

Their tests mock `faceBoxes` whole and do not assert its arguments, so they need no change. Leave their `gatewayAsk` mocks in place.

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/findFaces.test.ts src/mastra/tools/tvcChecks.test.ts src/mastra/tools/cropImage.test.ts src/mastra/tools/overlayText.test.ts src/mastra/tools/compositeEndCard.test.ts
git diff --exit-code apps/agent-orchestrator/src/mastra/tools/cropImage.test.ts
pnpm --filter agent-orchestrator type-check
```

Expected: all PASS, and `git diff --exit-code` on `cropImage.test.ts` exits 0 (Review Focus 4: crop_image's tests are unchanged and pass).

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/findFaces.ts apps/agent-orchestrator/src/mastra/tools/findFaces.test.ts apps/agent-orchestrator/src/mastra/tools/cropImage.ts apps/agent-orchestrator/src/mastra/tools/tvcChecks.ts apps/agent-orchestrator/src/mastra/tools/tvcChecks.test.ts apps/agent-orchestrator/src/mastra/tools/overlayText.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts
git commit -m "refactor(orchestrator): one box_2d face finder for crop_image and TVC placement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: the TVC skill texts (J7, append only) and final verification

**Files:**
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md`
- Test: `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts`

**Interfaces:**
- Consumes the exact names from earlier tasks:
  - `generate_jingle`, with inputs `line`, `lyrics`, `style`, `language` and outputs `fileId`, `signoffFileId`, `signoffSeconds`
  - `plan_tvc record`'s `jingleFileId`, `signoffFileId` and `signoffSeconds`
  - The finish slice's `jingle`, `jingleFileId`, `signoffStartSeconds` and `musicFadeOutAtSeconds`
  - `mix_voiceover`'s `kind: "jingle"` and `mix_music_bed`'s `fadeOutAtSeconds`
- Produces: Director and Olmo instructions. Nothing in code reads them.

- [ ] **Step 1: Write the failing test** (append inside the `'tvc-ad follows the final-review rulings'` test, after the Quality tools assertions)

```ts
    // Part B: the sung sign-off (additive section).
    expect(director).toMatch(/Sung sign-off \(supersedes the Music line above when the finish slice has a jingle\)/)
    expect(director).toContain('generate_jingle')
    expect(director).toContain('kind "jingle"')
    expect(director).toContain('signoffStartSeconds')
    expect(director).toContain('fadeOutAtSeconds')
    expect(director).toContain('JINGLE_LINE_NOT_SUNG')
    expect(card).toContain('Jingle: <the line to sing>')
    expect(card).toMatch(/default is no jingle/)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Append the text**

Append to `tvc-ad/director.md` (after the last line, with one blank line before it):

```markdown

Sung sign-off (supersedes the Music line above when the finish slice has a jingle):
- step plan: write brief.jingle {line, style, lyrics, language} only when Olmo's brief has "Jingle: <line>". End the voiceover early enough for it (at least 3.5 seconds before the end) and make the packshot 3–4 seconds.
- step finish, music: when the finish slice has jingle but no jingleFileId, call generate_jingle once with line, lyrics, style and language from it, alongside generate_song for the bed. Then plan_tvc record jingleFileId (its fileId), signoffFileId and signoffSeconds, and get the finish slice again. When the finish slice already has jingleFileId, reuse it.
- If plan_tvc record refuses with JINGLE_OVERLAPS_SPEECH or JINGLE_TOO_LONG, return the reason to Olmo and finish without the jingle only if Olmo says so.
- mix_voiceover: add the sign-off as one more block with kind "jingle", audioFileId = signoffFileId, startSeconds = the finish slice's signoffStartSeconds.
- mix_music_bed: pass fadeOutAtSeconds = the finish slice's musicFadeOutAtSeconds.
- generate_jingle refused with JINGLE_LINE_NOT_SUNG: it was refunded. Call it once more with the same inputs; if it refuses again, return the reason to Olmo so the user can shorten the line.
```

Append to `tvc-ad.md` (after line 13, with one blank line before it):

```markdown

14. Sung sign-off: the default is no jingle. Ask about a sung sign-off (the brand line sung over the ending) only when the user wants one or the reference ad has one. When there is one, pass "Jingle: <the line to sing>; style: <genre, mood, voice>" (and the language when it is not English) in the "step: plan" delegation, and show it in the plan in plain words ("ends on a sung line: 'Bubbli, feel the magic'"). If Director reports the sung line would overlap the voiceover or is too long, tell the user in one plain sentence and offer a shorter line or an earlier end to the voiceover.
```

- [ ] **Step 4: Verify the change is append-only**

Run:

```bash
git diff -U0 products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md | grep -E '^-[^-]' || echo "append-only: OK"
```

Expected: `append-only: OK` (no removed or changed lines).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: PASS.

- [ ] **Step 6: Final verification**

Run:

```bash
pnpm --filter agent-orchestrator test
pnpm --filter agent-orchestrator type-check
pnpm --filter inference-gateway test
pnpm --filter inference-gateway exec tsc --noEmit
pnpm --filter @serverless-saas/database test
pnpm --filter @serverless-saas/agent-api test
RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/jingleCut.realffmpeg.test.ts src/mastra/tools/mixVoiceover.realffmpeg.test.ts src/mastra/tools/assembleClips.realffmpeg.test.ts
```

Expected:
- All pass, except the known pre-existing `personas.test.ts` failure in agent-api (untouched by this branch).
- The real-ffmpeg cut ends at the gap with its fade; the level match lands within ±1 LU.

The real Lyria run was done in Task 3 Step 6. Run it again here only if Tasks 4–7 touched `timedLyrics.ts` or `jingleCut.ts`.

- [ ] **Step 7: Commit**

```bash
git add products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts
git commit -m "feat(skills): TVC Director and Olmo know the sung sign-off (additive)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deploy (after merge; done by the user, not by an implementer)

1. **Lyria 3 on the VM's project, before anything else.** The gateway calls Vertex as the VM's service account on `VERTEX_PROJECT`. After step 3 (the gateway deploy), make one call ($0.04):

   ```bash
   curl -s -X POST http://127.0.0.1:4001/v1/music/generations \
     -H "x-internal-service-key: $INTERNAL_SERVICE_KEY" -H 'Content-Type: application/json' \
     -d '{"model":"lyria-3-clip-preview","prompt":"bright pop jingle, female vocal, 120 bpm","lyrics":["Bubbli, feel the magic"]}' \
     | jq '{mimeType, lyricsText, bytes: (.audioBase64 // "" | length), refused, reason, error}'
   ```

   Expected: `mimeType: "audio/mpeg"`, a `lyricsText` with a `[a:b] Bubbli, feel the magic` line, and `bytes` in the hundreds of thousands.
   - A 403 or 404 means the project has no Lyria 3 access at location `global`. Enable it before the live test.
   - Never point it at `fitnearn-devops`.
2. **Credit rate seed** (the `music_generation / lyria-3-clip-preview` row, 4 credits): with the orchestrator's `DATABASE_URL`, run `pnpm --filter @serverless-saas/database db:seed`. Check that `credit_rates` has the row at `per_call_micro = 4000000`, version 1, active. Without it, `generate_jingle` runs unbilled and shows no approval card.
3. **Gateway:** `./deploy-gateway.sh` (it builds, restarts `inference-gateway` and smoke-tests it). Then run the check in step 1.
4. **Orchestrator and official skills:** `./deploy-orch.sh`. It seeds the official skills (`db:seed:official-skills`, for the `director.md` and `tvc-ad.md` additions), builds, and restarts `agent-orchestrator`. Then check that the `tvc-ad` skill's latest version contains "Sung sign-off".
5. **No migration.** K1 uses the existing `mastra_threads.metadata` column.
6. **Live test:** on the VM, remake the Bubbli ad with a "Bubbli, feel the magic" sign-off. Compare its ending by ear with v5 (`~/Desktop/coke-recreation-test/7-BUBBLI-TVC-v5.mp4`):
   - The sung line is clear.
   - It is not louder than the voiceover.
   - The bed is gone before it.
   - It ends with the ad.

   Then restart the orchestrator mid-flow (after the stills step) and confirm `plan_tvc record` still accepts the checked stills (K1).

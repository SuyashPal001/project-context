# short-drama-stitch (skill 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship skill 7 of 7 — an editing-only skill that stitches user-uploaded footage into an ad-length cut with cross-fade transitions, captions, and a music bed, reusing skill 5's audio pipeline unchanged.

**Architecture:** Extend `analyze_video` to return real timestamps/duration; extend `assemble_clips` with a pairwise xfade/acrossfade filter-graph builder and a raised clip cap; add one new `trim_clip` tool; wire a new Director section and platform contract; reuse `transcribe_audio`/`burn_captions`/`generate_song`/`mix_music_bed` as-is.

**Tech Stack:** Mastra `createTool`, Zod, ffmpeg/ffprobe via `execFile`, Postgres credit ledger via `@serverless-saas/credits`.

**Spec:** `docs/superpowers/specs/2026-09-22-short-drama-stitch-design.md` (revised after one Opus architectural review round — read both documents; this plan argues from that spec).

## Global Constraints

- Every `createTool` input schema is exported RAW alongside the tool (`export const inputSchema = z.object({...})`) so tests can call `.safeParse()` directly — `createTool`'s wrapped type has no `.safeParse`. Omitting this breaks `pnpm type-check`.
- Every ffmpeg filter-graph change or new invocation gets a task step that actually RUNS ffmpeg — mocked-`execFile` tests alone are not sufficient. Several specific behaviors must be reproduced live as negative controls, found across spec review AND plan review (plan review live-verified the spec's own claims and found two more real bugs in the process — never assume a prior review's "confirmed live" claim generalizes past the exact case it tested): video `xfade duration=0` silently drops the second clip; audio `acrossfade d=0` falls through to a ~0.92s default via `nb_samples`; a correct xfade-then-cut 3-clip graph produces 8.06s from three 3s clips with one 1s xfade; a `cut`-then-`xfade` ordering FAILS OUTRIGHT (exit 234, no output) unless a `settb=1/30` is inserted on the concat's video output before it feeds the later xfade — the spec's own live-verified case never exercised this ordering because it happened to put the xfade first; probing `format=duration` (container-level, the MAX of all streams) instead of `-select_streams v:0 -show_entries stream=duration` (video-stream-specific) produces a silently WRONG xfade offset with no error and a multi-second A/V desync on any real clip whose audio and video stream lengths differ, which real uploaded footage does routinely.
- Charge-before-call, refund-after-failure for `trim_clip`: `chargeKey` from `execContext.agent.toolCallId`, `agentId` read as `string | undefined` (never defaulted to `''`), dedicated `*Credits.ts` refund helper mirroring `muxBeatAudioCredits.ts`/`assemblyCredits.ts` exactly.
- `GENERATION_APPROVAL_METADATA` needs BOTH hyphenated (`trim-clip`) and underscored (`trim_clip`) entries — `generationApproval.ts`'s own doc comment (`:75-84`) explains why both forms can arrive on a `tool-call-approval` chunk.
- `chatStream.ts`'s three hardcoded attachment lists (`attachmentFromCanvasToolResult`'s array ~line 157, `SAVE_TOOL_NAMES` ~line 271, the mirrored exclusion array ~line 676) need `'trim-clip'` added to ALL THREE — hyphenated form ONLY, since `resolvedToolName.toLowerCase().replace(/_/g, '-')` normalizes before lookup (unlike `GENERATION_APPROVAL_METADATA`, which needs both forms for a different reason). This is the exact bug class skill 5's final review caught as a Critical repeat of an earlier skill's bug (`d04d1f9b`) — do not let it slip a third time.
- `assemble_clips`'s `clipFileIds` cap raises `.max(4)` → `.max(8)`; `FFMPEG_TIMEOUT_MS` raises `60_000` → `180_000`; `MAX_CLIP_BYTES` raises `200 * 1024 * 1024` → `500 * 1024 * 1024`. All three are ceiling increases with no behavior change for existing skill 4/5 callers.
- A zero-width transition is `type: 'cut'`, never an `xfade` with `overlapSeconds: 0` or omitted — the schema forbids both.
- `transitions` requires `preserveAudio: true` — a second `.refine`, loud rejection not silent no-op.
- No new gateway route, no new vendor, no new resourceType, no schema migration. `clip_assembly` has no Postgres enum constraint.
- `pnpm db:seed` against the target environment is a required deploy step for the new `ffmpeg-trim-clip` rate row — an unseeded row makes `trim_clip` run free AND with no approval card (`shouldRequireApproval` returns `false` with no matching rate). This plan documents it; it does not run it (no `DATABASE_URL` in this environment).

---

### Task 1: Extend `extractVideoFrames`/`analyze_video` with real timestamps and duration

**Files:**
- Modify: `apps/agent-orchestrator/src/media.ts:18-65` (`extractVideoFrames`)
- Modify: `apps/agent-orchestrator/src/types.ts:14-19` (`DownloadedMedia` — NOT `mastra/tools/types.ts`, which does not exist)
- Modify: `apps/agent-orchestrator/src/mastra/tools/analyzeVideo.ts`
- Test: `apps/agent-orchestrator/src/__tests__/media.test.ts` (existing — 3 existing tests need updating, not just a new one added)
- Test: `apps/agent-orchestrator/src/mastra/tools/__tests__/analyzeVideo.test.ts` (existing — note the `__tests__` subdirectory; this app mixes colocated and `__tests__`-subdirectory test files per directory, always check which convention a specific file already uses rather than assuming)

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces: `extractVideoFrames(...)` now returns `{ frames: DownloadedMedia[], durationSeconds: number }` instead of `DownloadedMedia[]` directly, on EVERY path including the existing catch block (never throws — see Step 3). `DownloadedMedia` gains a REQUIRED `timestampSeconds: number` field (not optional — `analyzeVideo.ts`'s `callGatewayForFrames` calls `.toFixed(1)` on it unconditionally). `analyzeVideoTool`'s output schema gains `durationSeconds: z.number().optional()`. Later tasks (directorAgent's new section) reference `analyze_video`'s `durationSeconds` field by that exact name.

`extractVideoFrames` is the only caller-facing function that changes shape; it has exactly one caller (`analyzeVideo.ts:85`), confirmed by grep across the whole repo (not just `apps/agent-orchestrator/src/mastra/tools/`) — the return-type change itself is contained, but two existing test files assert on the OLD shape and must be updated in this task, not left for a later surprise failure.

- [ ] **Step 1: Read the two existing test files first**

Read `apps/agent-orchestrator/src/__tests__/media.test.ts` in full and `apps/agent-orchestrator/src/mastra/tools/__tests__/analyzeVideo.test.ts` in full before writing anything. Both already exist and both assert on `extractVideoFrames`'s CURRENT bare-array return shape — this step is not optional groundwork, the exact assertions below depend on what's actually there.

- [ ] **Step 2: Write the failing test for `extractVideoFrames` returning duration, and fix the two existing tests that assert the old shape**

In `apps/agent-orchestrator/src/__tests__/media.test.ts`, this file mocks `execFile`/`mkdtempSync` via `vi.mock('node:child_process', ...)` and imports `extractVideoFrames` fresh inside each test with `await import('../media.js')` — follow that exact pattern, not a top-level import. Add the new test:

```typescript
it('returns durationSeconds alongside the extracted frames', async () => {
  const { extractVideoFrames } = await import('../media.js')
  const mockedExecFile = vi.mocked(execFileCb)
  let call = 0
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, res?: { stdout: string; stderr: string }) => void
    call++
    if (call === 1) {
      // ffprobe call
      cb(null, { stdout: JSON.stringify({ streams: [{ codec_type: 'video', duration: '12.0' }] }), stderr: '' })
    } else {
      // ffmpeg frame-extraction call
      cb(null, { stdout: '', stderr: '' })
    }
  }) as unknown as typeof execFileCb)

  const result = await extractVideoFrames('/tmp/fake.mp4', 'clip1', 'sess1', 8)

  expect(result.durationSeconds).toBe(12.0)
  expect(Array.isArray(result.frames)).toBe(true)
})
```

Then fix the THREE existing assertions in this same file that break on the new return shape — these are real edits to real existing tests, not new tests:
- `'returns an empty array when ffmpeg fails, without throwing'` (currently `expect(result).toEqual([])`) — change to `expect(result).toEqual({ frames: [], durationSeconds: 0 })`.
- The mkdtempSync-failure test with the same `toEqual([])` assertion — same change.
- `'reads back frame files ffmpeg produced, honoring a custom maxFrames'` (currently `expect(result).toHaveLength(2)` and indexes `result[0].mimeType` etc.) — change every `result[i]` to `result.frames[i]` and `result.toHaveLength(2)` to `result.frames.toHaveLength(2)`; add an assertion on `result.durationSeconds` matching whatever duration that test's ffprobe mock already returns (read the test to find the exact value before writing the assertion — do not guess it).

In `apps/agent-orchestrator/src/mastra/tools/__tests__/analyzeVideo.test.ts`, this file mocks `../../../media.js`'s `extractVideoFrames` to resolve a bare array (`vi.fn().mockResolvedValue([{...}])`) at the top of the file, and its `ctx()` helper is a plain object with a `.get` function, NOT a `RequestContext` instance — match that exact shape, do not import `RequestContext` here. Change the top-of-file mock:

```typescript
vi.mock('../../../media.js', () => ({
  extractVideoFrames: vi.fn().mockResolvedValue({
    frames: [{ filePath: '/tmp/f1.jpg', base64: 'data:image/jpeg;base64,AAA', mimeType: 'image/jpeg', name: 'clip_frame1.jpg', timestampSeconds: 0 }],
    durationSeconds: 8.0,
  }),
}))
```

Then fix the existing test `'samples 8 frames in quick mode and calls the gateway with a summary'` — its current assertion `expect(result).toEqual({ success: true, summary: 'a cat walks across a table', frameCount: 1 })` uses exact `toEqual`, which fails once `durationSeconds` is added to the real return. Change to:

```typescript
expect(result).toEqual({ success: true, summary: 'a cat walks across a table', frameCount: 1, durationSeconds: 8.0 })
```

Any other test in this file mocking `extractVideoFrames.mockResolvedValueOnce([])` (an empty array, for the "no frames" case) must change to `extractVideoFrames.mockResolvedValueOnce({ frames: [], durationSeconds: 0 })`.

- [ ] **Step 3: Run tests to verify the new one fails and the fixed ones still fail (not yet fixed in source)**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/__tests__/media.test.ts src/mastra/tools/__tests__/analyzeVideo.test.ts`
Expected: FAIL — every test touched in Step 2 fails because `extractVideoFrames`'s actual source hasn't changed yet.

- [ ] **Step 4: Change `extractVideoFrames`'s return shape — keep the existing catch block, do not delete it**

In `apps/agent-orchestrator/src/media.ts`, the CURRENT function has a `try { ... } catch (err) { console.error(...); return [] } finally { ... }` shape — the `catch` block is there specifically so this function never throws (two existing tests assert exactly that no-throw contract: the ffmpeg-fails case and the mkdtempSync-fails case). Change the signature, the frame-mapping, the success return, AND the catch's return value together — do not drop the catch:

```typescript
export async function extractVideoFrames(
  filePath: string,
  name: string,
  sessionId: string,
  maxFrames = 8,
  signal?: AbortSignal,
): Promise<{ frames: DownloadedMedia[]; durationSeconds: number }> {
  let frameDir: string | undefined
  try {
    frameDir = mkdtempSync(join(tmpdir(), 'vframes-'))
    const dir = frameDir
    let duration = 0
    try {
      const { stdout: probe } = await execFile('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
      ], { timeout: FFMPEG_TIMEOUT_MS, signal })
      const streams = (JSON.parse(probe) as { streams?: Array<{ codec_type: string; duration?: string }> }).streams ?? []
      const vs = streams.find(s => s.codec_type === 'video')
      duration = parseFloat(vs?.duration ?? '0') || 0
    } catch {}

    const interval = duration > 0 ? Math.max(1, duration / maxFrames) : 1
    const framePattern = join(dir, 'frame_%03d.jpg')
    await execFile('ffmpeg', [
      '-i', filePath,
      '-vf', `fps=1/${interval},scale=1280:-1`,
      '-frames:v', String(maxFrames),
      '-q:v', '3',
      framePattern,
    ], { timeout: FFMPEG_TIMEOUT_MS, signal })

    const frameFiles = readdirSync(dir).filter(f => f.endsWith('.jpg')).sort()
    console.log(`[session:${sessionId}] video frames extracted: ${frameFiles.length}`)

    const frames = frameFiles.map((f, i) => {
      const frameBuf = readFileSync(join(dir, f))
      // Each frame's real timestamp is i * interval — the sampling is
      // evenly spaced by construction (fps=1/interval above), so this is
      // exact, not an estimate.
      return {
        filePath: join(dir, f),
        base64: `data:image/jpeg;base64,${frameBuf.toString('base64')}`,
        mimeType: 'image/jpeg',
        name: `${name}_frame${i + 1}.jpg`,
        timestampSeconds: i * interval,
      }
    })
    return { frames, durationSeconds: duration }
  } catch (err) {
    // Unchanged no-throw contract, new return shape — two existing tests
    // in media.test.ts assert this path never throws.
    console.error(`[session:${sessionId}] video frame extraction error:`, (err as Error).message)
    return { frames: [], durationSeconds: 0 }
  } finally {
    if (frameDir) {
      try { readdirSync(frameDir).forEach(f => unlinkSync(join(frameDir!, f))); rmdirSync(frameDir) } catch {}
    }
  }
}
```

In `apps/agent-orchestrator/src/types.ts` (NOT `mastra/tools/types.ts` — that path doesn't exist; `DownloadedMedia` lives at `apps/agent-orchestrator/src/types.ts:14-19`), add `timestampSeconds: number` as a REQUIRED field (not optional) to the `DownloadedMedia` interface, alongside the existing `filePath`/`base64`/`mimeType`/`name` fields — required because `analyzeVideo.ts`'s `callGatewayForFrames` (Step 6 below) calls `.toFixed(1)` on it unconditionally, and an optional field there would be a `strict`-mode type error and a runtime crash on any caller that omits it. Read `apps/agent-orchestrator/src/media.ts:6`'s import of `./types.js` first to confirm the exact file being edited.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/__tests__/media.test.ts`
Expected: PASS — the new test and all 3 fixed existing tests.

- [ ] **Step 6: Write the failing test for `analyze_video`'s new `durationSeconds` output and timestamp-labeled prompt**

In `apps/agent-orchestrator/src/mastra/tools/__tests__/analyzeVideo.test.ts`, matching this file's real `ctx()` helper (a plain object with `.get`, not `RequestContext`) and its `vi.mocked(extractVideoFrames)` pattern already established at the top of the file:

```typescript
it('returns durationSeconds and labels frames with timestamps in the gateway prompt', async () => {
  vi.mocked(extractVideoFrames).mockResolvedValueOnce({
    frames: [
      { filePath: '/tmp/f1.jpg', base64: 'data:image/jpeg;base64,AAA', mimeType: 'image/jpeg', name: 'f1', timestampSeconds: 0 },
      { filePath: '/tmp/f2.jpg', base64: 'data:image/jpeg;base64,BBB', mimeType: 'image/jpeg', name: 'f2', timestampSeconds: 4.5 },
    ],
    durationSeconds: 9.0,
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'A short clip.' } }] }),
  }))

  const result = await analyzeVideoTool.execute!({ fileId: 'v1', mode: 'quick' } as never, ctx())

  expect((result as { durationSeconds?: number }).durationSeconds).toBe(9.0)
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
  const textBlocks = body.messages[0].content.filter((c: { type: string }) => c.type === 'text')
  expect(textBlocks.some((b: { text: string }) => b.text.includes('t=0.0s'))).toBe(true)
  expect(textBlocks.some((b: { text: string }) => b.text.includes('t=4.5s'))).toBe(true)
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/analyzeVideo.test.ts -t "durationSeconds and labels"`
Expected: FAIL — `result.durationSeconds` is `undefined`, and no `t=0.0s`/`t=4.5s` text blocks exist in the request body.

- [ ] **Step 8: Update `analyzeVideo.ts`**

```typescript
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { extractVideoFrames } from '../../media.js'
import { persistCost } from '../cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const QUICK_FRAMES = 8
const DEEP_FRAMES = 20
const QUICK_TIMEOUT_MS = 45_000
const DEEP_TIMEOUT_MS = 150_000

async function callGatewayForFrames(
  frames: Array<{ base64: string; mimeType: string; timestampSeconds: number }>,
  mode: 'quick' | 'deep',
  signal: AbortSignal,
): Promise<{ text: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const prompt = mode === 'quick'
    ? 'Give a brief 1-2 sentence summary of what happens in this video, based on these sampled frames. Each frame is labeled with its real timestamp.'
    : 'Describe this video in detail — subjects, actions, and any notable scene changes across these sampled frames. Each frame is labeled with its real timestamp; for every notable beat or moment, give a rough timestamp range (e.g. "0.0s-3.2s: ...") rather than only a plain description.'
  const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({
      model: 'gemini-3.6-flash',
      temperature: 0.1,
      max_tokens: mode === 'quick' ? 512 : 4096,
      messages: [{
        role: 'user',
        content: [
          ...frames.flatMap(f => [
            { type: 'text' as const, text: `Frame at t=${f.timestampSeconds.toFixed(1)}s` },
            { type: 'image_url' as const, image_url: { url: f.base64 } },
          ]),
          { type: 'text' as const, text: prompt },
        ],
      }],
    }),
  })
  if (!response.ok) throw new Error(`gateway HTTP ${response.status}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await response.json() as any
  return { text: result?.choices?.[0]?.message?.content ?? '', usage: result?.usage }
}

export const analyzeVideoTool = createTool({
  id: 'analyze_video',
  description:
    'Understand the content of an attached video file by sampling frames, with real timestamps. ' +
    'Use mode "quick" for a brief summary, "deep" for a detailed description with rough timestamp ranges per beat. ' +
    'Returns durationSeconds for callers (e.g. short-drama-stitch) that need the source clip\'s real length.',
  inputSchema: z.object({
    fileId: z.string(),
    mode: z.enum(['quick', 'deep']).default('quick'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    summary: z.string().optional(),
    frameCount: z.number().optional(),
    durationSeconds: z.number().optional(),
    partial: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    if (!idToken || !sessionId) return { success: false, error: 'no_active_session' }

    const mode = inputData.mode ?? 'quick'
    const timeoutMs = mode === 'deep' ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const presignedUrl = await fetchPresignedUrl(inputData.fileId, idToken, controller.signal)
      const { filePath } = await downloadToSessionCache(tenantId ?? sessionId, inputData.fileId, presignedUrl, MAX_VIDEO_BYTES, controller.signal)
      const maxFrames = mode === 'deep' ? DEEP_FRAMES : QUICK_FRAMES
      const { frames, durationSeconds } = await extractVideoFrames(filePath, inputData.fileId, sessionId, maxFrames, controller.signal)
      if (frames.length === 0) return { success: false, error: 'no frames could be extracted' }

      const { text, usage } = await callGatewayForFrames(frames, mode, controller.signal)
      if (tenantId && usage) {
        persistCost({
          tenantId,
          agentId: 'analyze-video',
          workflowId: 'media-understanding',
          model: 'gemini-3.6-flash',
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        })
      }
      return { success: true, summary: text, frameCount: frames.length, durationSeconds }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('abort')) {
        return { success: false, error: `analysis timed out (${mode} mode)`, partial: true }
      }
      return { success: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  },
})
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/__tests__/analyzeVideo.test.ts src/__tests__/media.test.ts`
Expected: PASS — both the new tests and every pre-existing test in both files, including the ones fixed in Step 2 (confirm no regression on the quick/deep summary tests already there).

- [ ] **Step 10: Live ffprobe/ffmpeg verification**

Run `extractVideoFrames` against a real short local video file (any ~10s .mp4 on disk, or generate one with `ffmpeg -f lavfi -i testsrc=duration=10:size=320x240:rate=30 -y /tmp/test10s.mp4`) via a throwaway script, confirm `durationSeconds` is close to 10 and each returned frame's `timestampSeconds` is evenly spaced and increasing. This is not a mocked test — run it for real and note the actual numbers in the task report.

- [ ] **Step 11: Commit**

```bash
git add apps/agent-orchestrator/src/media.ts apps/agent-orchestrator/src/types.ts apps/agent-orchestrator/src/mastra/tools/analyzeVideo.ts apps/agent-orchestrator/src/mastra/tools/__tests__/analyzeVideo.test.ts apps/agent-orchestrator/src/__tests__/media.test.ts
git commit -m "feat(analyze-video): expose durationSeconds and timestamp-labeled frames

Extended for short-drama-stitch's AI-proposed cut-list mode, which needs
real timestamps and clip duration — neither reached the model or the
caller before. extractVideoFrames's duration was already computed
internally and simply discarded; this exposes it."
```

---

### Task 2: Raise `assemble_clips`'s clip cap, timeout, and byte cap

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts:17-22,40`
- Modify: `apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts` (existing "rejects a 5th clip id" test needs updating)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `clipFileIds: z.array(z.string()).min(1).max(8)` (was `.max(4)`), `FFMPEG_TIMEOUT_MS = 180_000` (was `60_000`), `MAX_CLIP_BYTES = 500 * 1024 * 1024` (was `200 * 1024 * 1024`). Task 3 builds on this exact schema.

- [ ] **Step 1: Update the existing "rejects a 5th clip id" test to a boundary test at 8**

In `assembleClips.test.ts`, replace:

```typescript
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
```

with:

```typescript
it('accepts 4 clip ids (raised from the old max of 3 in skill 5)', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b', 'c', 'd'],
    aspectRatio: '9:16',
  })
  expect(result.success).toBe(true)
})

it('accepts 8 clip ids (raised from 4 in skill 7 for short-drama-stitch)', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    aspectRatio: '9:16',
  })
  expect(result.success).toBe(true)
})

it('rejects a 9th clip id', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    aspectRatio: '9:16',
  })
  expect(result.success).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/assembleClips.test.ts -t "accepts 8 clip ids"`
Expected: FAIL — schema still caps at 4.

- [ ] **Step 3: Update the constants and cap in `assembleClips.ts`**

```typescript
// Matches media.ts's FFMPEG_TIMEOUT_MS pattern, sized generously for an
// 8-clip xfade concat with real uploaded footage (short-drama-stitch) —
// raised from 60s (sized for skill 4/5's shorter generated clips) to 180s.
const FFMPEG_TIMEOUT_MS = 180_000
// Raised from 200MB (sized for skill 4/5's generated clips) to 500MB —
// short-drama-stitch's inputs are real uploaded camera footage, where a
// single clip well over 200MB is ordinary.
const MAX_CLIP_BYTES = 500 * 1024 * 1024
```

And the schema line:

```typescript
export const inputSchema = z.object({
  clipFileIds: z.array(z.string()).min(1).max(8),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/assembleClips.test.ts`
Expected: PASS — full file, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/assembleClips.ts apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts
git commit -m "feat(assemble-clips): raise clip cap to 8, timeout to 180s, byte cap to 500MB

Prerequisite for short-drama-stitch (skill 7): up to 8 real uploaded
clips, always preserveAudio, soon an xfade filter chain. Skill 4/5's
existing calls use far fewer clips in practice, so this is a ceiling
increase with no behavior change for them."
```

---

### Task 3: `assemble_clips` — `transitions` param and the xfade/acrossfade filter-graph rewrite

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/assembleClips.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts`

**Interfaces:**
- Consumes: Task 2's raised cap/constants.
- Produces: `assembleClips`'s `inputSchema` gains `transitions: z.array(transitionEntrySchema).optional()`, where `transitionEntrySchema` is a discriminated union on `type: 'xfade' | 'cut'`. `directorAgent.ts`'s new section (Task 8) calls `assemble_clips` with `transitions` set to the approved per-boundary list.

This is the largest task in the plan — a real filter-graph rewrite, not an added flag, per the spec's Critical finding #3.

- [ ] **Step 1: Write the failing schema tests**

Add to `assembleClips.test.ts`:

```typescript
it('accepts a valid transitions array matching clipFileIds.length - 1', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b', 'c'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [
      { type: 'xfade', name: 'fade', overlapSeconds: 1 },
      { type: 'cut' },
    ],
  })
  expect(result.success).toBe(true)
})

it('rejects transitions with the wrong length', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b', 'c'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [{ type: 'cut' }],
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('TRANSITION_COUNT_MISMATCH')
})

it('rejects transitions set without preserveAudio', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b'],
    aspectRatio: '9:16',
    transitions: [{ type: 'cut' }],
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('TRANSITION_REQUIRES_AUDIO')
})

it('rejects an xfade entry with overlapSeconds: 0', () => {
  // Negative control for the live-verified ffmpeg bug: video xfade
  // duration=0 silently drops the second clip entirely; audio acrossfade
  // d=0 falls through to a ~0.92s default. Neither is a valid "zero-width
  // crossfade," so the schema must reject this before it reaches ffmpeg.
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [{ type: 'xfade', name: 'fade', overlapSeconds: 0 }],
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('INVALID_TRANSITION_OVERLAP')
})

it('rejects an xfade entry with overlapSeconds omitted', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [{ type: 'xfade', name: 'fade' }],
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('INVALID_TRANSITION_OVERLAP')
})

it('rejects an xfade entry with no name', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [{ type: 'xfade', overlapSeconds: 1 }],
  })
  expect(result.success).toBe(false)
})

it('rejects a cut entry that carries overlapSeconds', () => {
  const result = inputSchema.safeParse({
    clipFileIds: ['a', 'b'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [{ type: 'cut', overlapSeconds: 1 }],
  })
  expect(result.success).toBe(false)
  if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('INVALID_TRANSITION_OVERLAP')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/assembleClips.test.ts -t "transitions"`
Expected: FAIL — `transitions` doesn't exist on the schema yet, all `safeParse` calls either error on the unknown key (stripped, not rejected) or the valid-case test fails because the field is silently dropped.

- [ ] **Step 3: Add the `transitions` schema**

Add above `inputSchema` in `assembleClips.ts`. This is a FLAT object with `.superRefine`, not a `z.discriminatedUnion` — this codebase has zero prior use of `discriminatedUnion` in any tool input schema (grep confirms), and Mastra converts `inputSchema` to a JSON Schema the model calls tools against; a flat shape is the safer, already-precedented pattern (every other tool schema in this codebase is a flat object) and it also gives every rejection reason a named, greppable message, unlike relying on `.strict()`'s generic "unrecognized key" error:

```typescript
// A zero-width transition is `type: 'cut'`, never an xfade with
// overlapSeconds 0 or omitted — verified live against real ffmpeg: video
// `xfade duration=0` silently drops the second clip entirely (exit 0, no
// error), and audio `acrossfade d=0` falls through to `nb_samples`'s
// ~0.92s default, the opposite of zero. A flat object + .superRefine
// (not z.discriminatedUnion, which nothing else in this codebase's tool
// schemas uses and which Mastra's JSON-Schema conversion for model
// function-calling has not been verified against) keeps every rejection
// reason as a named, greppable message.
const transitionEntrySchema = z.object({
  type: z.enum(['xfade', 'cut']),
  name: z.string().min(1).optional(),
  overlapSeconds: z.number().optional(),
}).superRefine((v, ctx) => {
  if (v.type === 'xfade') {
    if (!v.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_TRANSITION_OVERLAP: xfade entries require a name (e.g. "fade")' })
    }
    if (v.overlapSeconds === undefined || v.overlapSeconds <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_TRANSITION_OVERLAP: xfade entries require overlapSeconds > 0 — never 0 or omitted, use type "cut" for a zero-width transition instead' })
    }
  } else if (v.overlapSeconds !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_TRANSITION_OVERLAP: a cut entry must not carry overlapSeconds' })
  }
})
```

Add `transitions` to `inputSchema` and a second `.refine`:

```typescript
export const inputSchema = z.object({
  clipFileIds: z.array(z.string()).min(1).max(8),
  targetDurationSeconds: z.number().positive().optional().describe(
    'When set, the assembled video is trimmed (extra tail dropped) or the final frame held (tpad) to match this length — used to align this clip total to a separate audio track\'s length. Not compatible with preserveAudio (see refine below) — animation-character\'s preserveAudio callers pre-trim every clip upstream and never set this.'
  ),
  preserveAudio: z.boolean().default(false).describe(
    'When true, concatenates with each input\'s audio stream preserved (v=1:a=1, each stream resampled to a common format first) instead of stripping all audio (-an). Every input must already carry an audio stream, already trimmed to its final length — this field does not itself trim anything. Default false keeps talking-head/short-drama-stitch\'s existing silent-concat-then-lipsync behavior unchanged.'
  ),
  transitions: z.array(transitionEntrySchema).optional().describe(
    'Per-boundary transitions, length must equal clipFileIds.length - 1. Only consumed when preserveAudio is true (short-drama-stitch use case) — every clip pair gets either an xfade crossfade (with a positive overlapSeconds) or a hard cut.'
  ),
  aspectRatio: z.enum(['16:9', '9:16']),
}).refine(
  (v) => !(v.preserveAudio && v.targetDurationSeconds !== undefined),
  { message: 'preserveAudio and targetDurationSeconds cannot both be set — the concat filter graph produces one video+audio output stream, and stop_duration padding is meaningless once every input is already individually trimmed upstream' },
).refine(
  (v) => !v.transitions || v.transitions.length === v.clipFileIds.length - 1,
  { message: 'TRANSITION_COUNT_MISMATCH: transitions.length must equal clipFileIds.length - 1, one entry per boundary between consecutive clips' },
).refine(
  (v) => !v.transitions || v.preserveAudio,
  { message: 'TRANSITION_REQUIRES_AUDIO: transitions can only be set when preserveAudio is true — footage keeps its own audio in the short-drama-stitch use case this exists for' },
)
```

- [ ] **Step 4: Run schema tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/assembleClips.test.ts -t "transitions"`
Expected: PASS — all 6 new schema tests green.

- [ ] **Step 5: Write the failing filter-graph tests, including a mixed cut-then-xfade ordering**

```typescript
it('builds a sequential xfade/acrossfade+concat filter graph when transitions is set (xfade then cut)', async () => {
  const fs = await import('node:fs')
  vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })
  // Three ffprobe duration calls (one per input, 3s each), then the ffmpeg
  // call itself.
  execFile
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

  await assembleClips.execute!({
    clipFileIds: ['c1', 'c2', 'c3'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [
      { type: 'xfade', name: 'fade', overlapSeconds: 1 },
      { type: 'cut' },
    ],
  } as never, baseCtx())

  const ffmpegCall = execFile.mock.calls.find(c => c[0] === 'ffmpeg')!
  const args = ffmpegCall[1] as string[]
  const filterComplex = args[args.indexOf('-filter_complex') + 1]
  // Matches the spec's live-verified confirmed-correct shape exactly:
  // offset = accumulated duration so far (3) - overlap (1) = 2.
  expect(filterComplex).toContain('xfade=transition=fade:duration=1:offset=2')
  expect(filterComplex).toContain('acrossfade=d=1')
  expect(filterComplex).toMatch(/concat=n=2:v=1:a=1\[outv\]\[outa\]/)
})

it('inserts settb after a concat that feeds a LATER xfade (cut-then-xfade ordering)', async () => {
  // This ordering is the one the plan's Opus review found ffmpeg rejects
  // without a fix: feeding a concat filter's video output directly into a
  // later xfade fails live with "First input link main timebase ...
  // do not match ... xfade timebase" and produces NO output file (exit
  // 234) — the earlier xfade-then-cut test above never exercises this
  // path, since its concat is the LAST boundary. This test asserts the
  // settb fix is present: the video output of a non-final concat must be
  // re-based to 1/30 before it feeds the next xfade.
  const fs = await import('node:fs')
  vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })
  execFile
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

  await assembleClips.execute!({
    clipFileIds: ['c1', 'c2', 'c3'],
    aspectRatio: '9:16',
    preserveAudio: true,
    transitions: [
      { type: 'cut' },
      { type: 'xfade', name: 'fade', overlapSeconds: 1 },
    ],
  } as never, baseCtx())

  const ffmpegCall = execFile.mock.calls.find(c => c[0] === 'ffmpeg')!
  const args = ffmpegCall[1] as string[]
  const filterComplex = args[args.indexOf('-filter_complex') + 1]
  expect(filterComplex).toContain('concat=n=2:v=1:a=1')
  expect(filterComplex).toContain('settb=1/30')
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/assembleClips.test.ts -t "sequential xfade|settb"`
Expected: FAIL — no transitions-handling code exists yet, filter graph still uses plain `concat=n=3`.

- [ ] **Step 7: Implement the filter-graph builder and ffprobe pass**

Add a helper function above `assembleClips` in `assembleClips.ts`:

```typescript
interface TransitionEntry {
  type: 'xfade' | 'cut'
  name?: string
  overlapSeconds?: number
}

// xfade/acrossfade are strictly pairwise with an absolute `offset`
// (relative to the first input) — there is no n-way form like concat has.
// This walks the boundary list left to right, accumulating a running
// duration, and builds a sequential filter graph: each xfade boundary
// joins the accumulated stream to the next clip with an absolute offset;
// each cut boundary concats them instead (concat=n=2, not batched with
// neighbors — simpler and still correct at this skill's <=8-clip scale).
// Confirmed live and correct for the xfade-then-cut case during spec
// review: three 3s clips, one 1s xfade then one cut, produced exactly
// 8.06s.
//
// settb fix (found during plan review, live-verified): feeding a
// concat filter's video output directly into a LATER xfade fails —
// ffmpeg 8.1.2 rejects it with "First input link main timebase ...
// do not match ... xfade timebase" and produces no output at all (exit
// 234). Every non-final concat's video output is re-based with
// settb=1/30 before it's used as an xfade input. A live 4-clip/3-boundary
// [cut, xfade(1s), cut] run with this fix produced 11.074s for four 3s
// clips — matching the arithmetic 9.0s (=3*4-1 overlap second... actually
// 12 - 1 = 11, quantization accounts for the rest).
function buildTransitionsFilterComplex(
  videoLabels: string[], // ['v0', 'v1', ...] — already-normalized per-input labels
  audioLabels: string[], // ['a0', 'a1', ...]
  durations: number[],   // ffprobed VIDEO-stream duration per input, same order
  transitions: TransitionEntry[],
): string {
  let accV = videoLabels[0]
  let accA = audioLabels[0]
  let accDuration = durations[0]
  const parts: string[] = []

  for (let i = 0; i < transitions.length; i++) {
    const boundary = transitions[i]
    const nextV = videoLabels[i + 1]
    const nextA = audioLabels[i + 1]
    const nextDuration = durations[i + 1]
    const isLast = i === transitions.length - 1
    const outV = isLast ? 'outv' : `accv${i}`
    const outA = isLast ? 'outa' : `acca${i}`

    if (boundary.type === 'xfade') {
      const overlap = boundary.overlapSeconds!
      const offset = accDuration - overlap
      if (offset < 0) {
        // The AI-proposed or user-given overlap is larger than the
        // accumulated stream it's crossfading against — ffmpeg accepts a
        // negative offset silently and produces a garbled result rather
        // than erroring, so this must be caught here, before ffmpeg ever
        // runs.
        throw new Error(`INVALID_TRANSITION_OVERLAP: boundary ${i}'s overlapSeconds (${overlap}) exceeds the accumulated clip duration (${accDuration}) it would crossfade against`)
      }
      parts.push(`[${accV}][${nextV}]xfade=transition=${boundary.name}:duration=${overlap}:offset=${offset}[${outV}]`)
      parts.push(`[${accA}][${nextA}]acrossfade=d=${overlap}[${outA}]`)
      accDuration = accDuration + nextDuration - overlap
    } else {
      const isFollowedByXfade = !isLast && transitions[i + 1].type === 'xfade'
      const concatVideoOut = isFollowedByXfade ? `${outV}raw` : outV
      parts.push(`[${accV}][${accA}][${nextV}][${nextA}]concat=n=2:v=1:a=1[${concatVideoOut}][${outA}]`)
      if (isFollowedByXfade) {
        parts.push(`[${concatVideoOut}]settb=1/30[${outV}]`)
      }
      accDuration = accDuration + nextDuration
    }
    accV = outV
    accA = outA
  }

  return parts.join('; ')
}
```

In `assembleClips`'s `execute`, add an ffprobe-per-input duration pass and route to the new builder when `transitions` is set. **Remove the outer `let concatInputs: string` declaration that currently sits above this whole if/else block** — the branches below each declare their own `const concatInputs` inside their own scope, so the outer one becomes an unused variable (`noUnusedLocals` is on in this repo's `tsconfig.base.json`, so this is a real `pnpm type-check` failure if left in place, not just a lint nit). Modify the existing `preserveAudio` branch:

```typescript
      const videoFilterParts = localPaths.map((_, i) =>
        `[${i}:v]fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      )

      let filterComplex: string
      if (transitions && transitions.length > 0) {
        // Every input is ffprobed for its own VIDEO-stream duration
        // specifically — NOT `format=duration` (the container's overall
        // duration, which is the MAX of all streams). Real uploaded
        // footage routinely has audio and video streams of different
        // lengths; probing the container duration and using it as the
        // xfade offset produced a live-verified, silently WRONG offset
        // (exit 0, no error) with several seconds of A/V desync in the
        // final output — this is the exact silent-failure class this
        // skill's overlapSeconds validation was written to close, and it
        // would have been reopened here by the wrong probe field.
        const durations: number[] = []
        for (const p of localPaths) {
          const { stdout: durOut } = await execFile('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', p,
          ], { timeout: FFMPEG_TIMEOUT_MS })
          const d = parseFloat(durOut.trim())
          if (!(d > 0)) throw new Error(`ffprobe returned an invalid video-stream duration for an input clip: ${durOut}`)
          durations.push(d)
        }
        const audioFilterParts = localPaths.map((_, i) =>
          `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
        )
        const videoLabels = localPaths.map((_, i) => `v${i}`)
        const audioLabels = localPaths.map((_, i) => `a${i}`)
        const transitionsGraph = buildTransitionsFilterComplex(videoLabels, audioLabels, durations, transitions as TransitionEntry[])
        filterComplex = `${videoFilterParts.join('; ')}; ${audioFilterParts.join('; ')}; ${transitionsGraph}`
      } else if (preserveAudio) {
        const audioFilterParts = localPaths.map((_, i) =>
          `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
        )
        const concatInputs = localPaths.map((_, i) => `[v${i}][a${i}]`).join('')
        filterComplex = `${videoFilterParts.join('; ')}; ${audioFilterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=1[outv][outa]`
      } else {
        const concatInputs = localPaths.map((_, i) => `[v${i}]`).join('')
        const concatLabel = targetDurationSeconds !== undefined ? '[cat]' : '[outv]'
        filterComplex = `${videoFilterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=0${concatLabel}`
        if (targetDurationSeconds !== undefined) {
          filterComplex += `; [cat]tpad=stop_mode=clone:stop_duration=${Math.max(0, targetDurationSeconds)}[outv]`
        }
      }
```

Destructure `transitions` from `inputData` alongside the other fields at the top of `execute`, and pass `-map [outa]` whenever `transitions && transitions.length > 0` (same branch that already maps `[outa]` for plain `preserveAudio`) — the existing `if (preserveAudio) { args.push('-map', '[outa]') } else { args.push('-an') }` line already covers this correctly since `transitions` requires `preserveAudio: true` by schema.

`buildTransitionsFilterComplex` can throw (the `INVALID_TRANSITION_OVERLAP` case above) — this call sits inside the same `try` block that already wraps ffmpeg invocation and already refunds on any thrown error, so no new try/catch is needed, only a new branch in the existing catch to recognize this specific thrown message and return a distinct refusal instead of falling into the generic bucket. Add a new refusal bucket for xfade-specific ffmpeg failures too, distinct from the generic `ASSEMBLY_FAILED` — the exact stderr match string must be discovered live, not guessed (Step 9 below confirms it):

```typescript
      const message = (err as Error).message ?? ''
      if (message.startsWith('INVALID_TRANSITION_OVERLAP')) {
        return { refused: true, refusalReason: 'INVALID_TRANSITION_OVERLAP', jobId }
      }
      const stderr = (err as { stderr?: string }).stderr ?? ''
      if (preserveAudio && stderr.includes('matches no streams')) {
        return { refused: true, refusalReason: 'MISSING_AUDIO_STREAM', jobId }
      }
      if (transitions && transitions.length > 0 && stderr.includes('<XFADE_STDERR_MARKER_FROM_STEP_9>')) {
        return { refused: true, refusalReason: 'XFADE_FILTER_FAILED', jobId }
      }
      return { refused: true, refusalReason: 'ASSEMBLY_FAILED', jobId }
```

(`<XFADE_STDERR_MARKER_FROM_STEP_9>` is a literal placeholder in this plan text only — Step 9 replaces it with the real observed stderr substring from a live failing run, e.g. an invalid transition `name`. Do not ship the placeholder string.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/assembleClips.test.ts`
Expected: PASS — both new filter-graph tests (including the settb one) and every pre-existing test in the file.

- [ ] **Step 9: Live ffmpeg verification with negative controls (mandatory — do not skip)**

Using two-to-four real short local clips (or `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=30 -f lavfi -i sine=duration=3 -c:v libx264 -c:a aac -y /tmp/clip1.mp4`, repeat for `clip2.mp4`/`clip3.mp4`/`clip4.mp4`), run these live, outside any test mock, and record the actual results in the task report:

1. Run the tool's real filter graph for the xfade-then-cut case (three 3s clips, one 1s xfade + one cut) directly with ffmpeg on the command line. Confirm the output duration is ~8.0-8.1s (matches the spec's live-verified 8.06s).
2. Run the cut-then-xfade case (three 3s clips, one cut then one 1s xfade, WITH the settb fix from Step 7) and confirm it actually produces an output file (without the fix, this exact ordering fails at exit 234 with a timebase-mismatch error and NO output — reproduce that failure once first, without the fix, as the negative control proving the fix is what changed the outcome, then confirm it succeeds with the fix in place).
3. Run a 4-clip/3-boundary `[cut, xfade(1s), cut]` chain and confirm the output duration is close to the arithmetic expectation (durations sum minus the one overlap second, plus normal frame-quantization slop).
4. Negative control: run `xfade=transition=fade:duration=0:offset=2` directly on two real clips. Confirm the second clip is dropped and the output is ~3.0s, not the expected ~5s — reproducing the exact bug the schema now prevents from ever reaching this point.
5. Negative control: run `acrossfade=d=0` on two real audio-bearing clips. Confirm the crossfade duration is NOT 0 (falls through to the ~0.92s `nb_samples` default) — same purpose as control 4, for audio.
6. Negative control: probe a clip with mismatched audio/video stream lengths (`ffmpeg -f lavfi -i testsrc=duration=3 -f lavfi -i sine=duration=5 -c:v libx264 -c:a aac -y /tmp/mismatch.mp4`) with BOTH `-show_entries format=duration` and the corrected `-select_streams v:0 -show_entries stream=duration`, confirming they return different values and that the tool's actual ffprobe call (Step 7's code) uses the video-stream-specific one.
7. Trigger a real xfade filter failure (e.g. an invalid `transition` name like `xfade=transition=not-a-real-name`) and capture the EXACT ffmpeg stderr text. Replace the `<XFADE_STDERR_MARKER_FROM_STEP_9>` placeholder from Step 7 with the real observed substring — do not guess this string in advance, per this codebase's standing rule (skill 5's `burn_captions` task got its own guessed string wrong and had to correct it after a live run).
8. Add one more test to `assembleClips.test.ts` asserting `XFADE_FILTER_FAILED` fires on that exact real stderr text (mirroring the existing `MISSING_AUDIO_STREAM` test's structure).

- [ ] **Step 10: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/assembleClips.ts apps/agent-orchestrator/src/mastra/tools/assembleClips.test.ts
git commit -m "feat(assemble-clips): add transitions param with xfade/acrossfade filter-graph builder

New optional transitions parameter for short-drama-stitch: per-boundary
xfade crossfade or hard cut, consumed only when preserveAudio is true.
Not a flag added to the existing concat path — xfade is strictly
pairwise with an absolute offset, so this adds a real ffprobe-per-input
pass and a sequential filter-graph builder. overlapSeconds:0/omitted is
rejected at the schema level (video xfade duration=0 silently drops a
clip; audio acrossfade d=0 falls through to a ~0.92s default — neither
is a usable zero-width crossfade, verified live)."
```

---

### Task 4: New `trim_clip` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/trimClip.ts`
- Create: `apps/agent-orchestrator/src/mastra/tools/trimClipCredits.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/trimClip.test.ts`

**Interfaces:**
- Consumes: `shouldRequireApproval` from `generationApproval.js` (existing), `fetchPresignedUrl`/`downloadToSessionCache` from `mediaCache.js` (existing), `uploadGeneratedFile` from `../../persistence.js` (existing).
- Produces: `trimClip` (tool, `id: 'trim-clip'`), raw `inputSchema` export — `{ sourceFileId: string, startSeconds: number, endSeconds: number }`. Output: `{ fileId?, name?, fileType?, size?, refused?, refusalReason?, insufficientCredits?, creditsUsedMicro?, jobId? }` — `refusalReason` values: `SOURCE_UNAVAILABLE`, `INVALID_TRIM_RANGE`, `MISSING_AUDIO_STREAM`, `TRIM_FAILED`, `NO_SESSION_CONTEXT`, `STORAGE_FAILED`. Task 5 registers `'trim-clip'`/`'trim_clip'` in `GENERATION_APPROVAL_METADATA`. Task 6 adds `'trim-clip'` to `chatStream.ts`'s three lists. Task 7 seeds its credit rate. Task 8 imports and registers `trim_clip` in `directorAgent.ts`'s tools maps.

- [ ] **Step 1: Write the failing schema tests**

```typescript
import { describe, it, expect } from 'vitest'
import { inputSchema } from './trimClip.js'

describe('trimClip inputSchema', () => {
  it('accepts a valid trim range', () => {
    const result = inputSchema.safeParse({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 5 })
    expect(result.success).toBe(true)
  })

  it('rejects endSeconds <= startSeconds', () => {
    const result = inputSchema.safeParse({ sourceFileId: 'c1', startSeconds: 5, endSeconds: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects a negative startSeconds', () => {
    const result = inputSchema.safeParse({ sourceFileId: 'c1', startSeconds: -1, endSeconds: 5 })
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/trimClip.test.ts`
Expected: FAIL — `./trimClip.js` doesn't exist yet.

- [ ] **Step 3: Write `trimClipCredits.ts`**

```typescript
import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

// Mirrors refundMuxBeatAudioCharge/refundAssemblyCharge exactly — see
// refundVideoCharge's comments (videoCredits.ts) for why the amount/expiry
// are always read back from the ledger rather than trusted from in-memory
// state.
export async function refundTrimClipCharge(
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
        `[credits] UNREFUNDED TRIM-CLIP CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(`[credits] refundTrimClipCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`, (err as Error).message)
  }
}
```

- [ ] **Step 4: Write `trimClip.ts`**

```typescript
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
import { refundTrimClipCharge } from './trimClipCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const TRIM_SUBJECT = 'ffmpeg-trim-clip'
// Matches assembleClips.ts's own raised value (Task 2) — this tool takes
// the same class of input (real uploaded camera footage, up to 500MB),
// and output-side -ss/-to seeking (see below) decodes the whole file up
// to the in-point before it can start trimming, so a long source clip
// needs the same generous margin.
const FFMPEG_TIMEOUT_MS = 180_000
const MAX_SOURCE_BYTES = 500 * 1024 * 1024

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

// Exported raw so tests can .safeParse() it directly — createTool's wrapped
// type has no .safeParse (see this plan's Global Constraints).
export const inputSchema = z.object({
  sourceFileId: z.string().describe('An uploaded footage clip to trim a segment from.'),
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
}).refine((v) => v.endSeconds > v.startSeconds, { message: 'endSeconds must be greater than startSeconds' })

export const trimClip = createTool({
  id: 'trim-clip',
  description: 'Trims one uploaded footage clip to an in/out segment, producing a new clip. Used in short-drama-stitch to cut down a selected segment from a larger uploaded clip before assembly.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: TRIM_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { sourceFileId, startSeconds, endSeconds } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let sourcePath: string
    try {
      const presignedUrl = await fetchPresignedUrl(sourceFileId, idToken)
      ;({ filePath: sourcePath } = await downloadToSessionCache(scopeId, sourceFileId, presignedUrl, MAX_SOURCE_BYTES))
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to download source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Probe-before-trim: Mode A's AI-proposed timestamps are approximate
    // (see analyzeVideo.ts's timestamp labeling), so this is the real
    // correctness backstop, not just defensive padding. Also checks for an
    // audio stream up front — a source clip with no audio produces a
    // video-only trimmed output that would only fail later, inside
    // assemble_clips's MISSING_AUDIO_STREAM path, AFTER this tool (and
    // potentially several sibling trim_clip calls) has already been
    // charged. Refusing here instead avoids charging for a trim whose
    // output can never be used downstream (short-drama-stitch always sets
    // preserveAudio: true).
    let sourceDurationSeconds: number
    let hasAudioStream: boolean
    try {
      const { stdout: probeOut } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', sourcePath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const probe = JSON.parse(probeOut) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> }
      sourceDurationSeconds = parseFloat(probe.format?.duration ?? '')
      if (!(sourceDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${probeOut}`)
      hasAudioStream = (probe.streams ?? []).some(s => s.codec_type === 'audio')
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to probe source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }
    if (endSeconds > sourceDurationSeconds) {
      return { refused: true, refusalReason: 'INVALID_TRIM_RANGE', jobId }
    }
    if (!hasAudioStream) {
      return { refused: true, refusalReason: 'MISSING_AUDIO_STREAM', jobId }
    }

    // Charge BEFORE running ffmpeg — same settled ordering as every other
    // generation tool.
    const attempt = 0
    const chargeKey = `trim-clip:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', TRIM_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED TRIM-CLIP: no active clip_assembly/${TRIM_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
      workDir = mkdtempSync(join(tmpdir(), 'trim-clip-'))
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'TRIM_FAILED', jobId }
    }
    const outputPath = join(workDir, 'trimmed.mp4')
    try {
      // Output-side seeking (-ss/-to after -i) for frame-accurate trims —
      // input-side seeking (-ss before -i) is faster but can land on the
      // wrong keyframe, which matters here since trim points come from
      // approximate AI-proposed timestamps as often as exact user ones.
      await execFile('ffmpeg', [
        '-y', '-i', sourcePath,
        '-ss', String(startSeconds), '-to', String(endSeconds),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'TRIM_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to read output:`, (err as Error).message)
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'TRIM_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Trimmed Clip', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
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

- [ ] **Step 5: Run schema tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/trimClip.test.ts`
Expected: PASS — the 3 schema tests from Step 1.

- [ ] **Step 6: Write and run the execution tests**

Mirror `assembleClips.test.ts`'s mocking setup exactly (same `vi.hoisted`/`vi.mock` blocks for `@serverless-saas/credits`, `../../usage.js`, `../../persistence.js`, `./mediaCache.js`, `./generationApproval.js`, `node:child_process`, `node:fs`). Add tests for:

Note the probe is now ONE combined ffprobe call (duration + audio-stream presence in one `-of json` call), not the separate duration-only call from an earlier draft — every mock below reflects that.

```typescript
function probeResult(durationSeconds: string, hasAudio: boolean) {
  return {
    stdout: JSON.stringify({
      format: { duration: durationSeconds },
      streams: hasAudio ? [{ codec_type: 'video' }, { codec_type: 'audio' }] : [{ codec_type: 'video' }],
    }),
    stderr: '',
  }
}

it('downloads the source, probes duration+audio, trims with ffmpeg, and uploads the result', async () => {
  const fs = await import('node:fs')
  vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'trimmed1', name: 'trimmed.mp4', type: 'video/mp4', size: 8 })
  execFile
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', true)))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

  const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

  expect(result).toMatchObject({ fileId: 'trimmed1' })
})

it('refuses with INVALID_TRIM_RANGE when endSeconds exceeds the probed source duration', async () => {
  execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('4.0', true)))

  const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 0, endSeconds: 10 } as never, baseCtx())

  expect(result).toMatchObject({ refused: true, refusalReason: 'INVALID_TRIM_RANGE' })
  // No charge should have happened — the probe runs before charging.
  expect(spendCredits).not.toHaveBeenCalled()
})

it('refuses with MISSING_AUDIO_STREAM when the source has no audio track, before charging', async () => {
  execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', false)))

  const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

  expect(result).toMatchObject({ refused: true, refusalReason: 'MISSING_AUDIO_STREAM' })
  expect(spendCredits).not.toHaveBeenCalled()
})

it('refunds the charge when ffmpeg fails after a successful charge', async () => {
  execFile
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', true)))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: Error) => void) => cb(new Error('ffmpeg exploded')))
  getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

  const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

  expect(result).toMatchObject({ refused: true, refusalReason: 'TRIM_FAILED' })
  expect(spendCredits).toHaveBeenCalledTimes(2)
  expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund', jobType: 'clip_assembly' }))
})

it('argv-assertion: places -ss and -to AFTER -i (output-side seeking), in that order', async () => {
  // Regression guard for the exact property the trim's correctness
  // depends on — output-side seeking on the requested window, not
  // input-side seeking (faster but can land on the wrong keyframe).
  const fs = await import('node:fs')
  vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
  ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'trimmed1', name: 'trimmed.mp4', type: 'video/mp4', size: 8 })
  execFile
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', true)))
    .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

  await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

  const ffmpegCall = execFile.mock.calls.find(c => c[0] === 'ffmpeg')!
  const args = ffmpegCall[1] as string[]
  const iIdx = args.indexOf('-i')
  const ssIdx = args.indexOf('-ss')
  const toIdx = args.indexOf('-to')
  expect(ssIdx).toBeGreaterThan(iIdx)
  expect(toIdx).toBeGreaterThan(ssIdx)
  expect(args[ssIdx + 1]).toBe('2')
  expect(args[toIdx + 1]).toBe('6')
})
```

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/trimClip.test.ts`
Expected: PASS

- [ ] **Step 7: Live ffmpeg verification**

Run the tool's real `ffmpeg -ss ... -to ...` command against a real short local clip (e.g. the same `/tmp/clip1.mp4` from Task 3), trimming a 2-6s window from a 10s source. Confirm with `ffprobe` that the output's real duration is ~4.0s and starts at the right content. Also verify the out-of-range case live: request `endSeconds` past the real source duration and confirm the tool's ffprobe-based check catches it before any ffmpeg trim call runs (not just in the mocked test). Also generate one real video-only clip with no audio stream (`ffmpeg -f lavfi -i testsrc=duration=5:size=320x240:rate=30 -c:v libx264 -y /tmp/noaudio.mp4`) and confirm the tool's real combined ffprobe call correctly reports no audio stream for it.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/trimClip.ts apps/agent-orchestrator/src/mastra/tools/trimClipCredits.ts apps/agent-orchestrator/src/mastra/tools/trimClip.test.ts
git commit -m "feat(trim-clip): add new tool for short-drama-stitch clip trimming

One ffmpeg call, trims one uploaded clip to an in/out segment. Mirrors
mux_beat_audio's charge-before-call/refund-after-failure shape exactly.
Probes source duration before charging so an out-of-range request never
reaches the charge path."
```

---

### Task 5: `GENERATION_APPROVAL_METADATA` entries for `trim_clip`

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/generationApproval.ts`
- Test: check for an existing `generationApproval.test.ts` and add to it; if none exists, this task's verification is Task 4/8's own tests plus a manual check (do not create a new test file just for a metadata map entry — fold into whichever existing suite already covers this map, e.g. `directorAgent.test.ts` in Task 10).

**Interfaces:**
- Consumes: nothing new.
- Produces: `GENERATION_APPROVAL_METADATA['trim-clip']` and `['trim_clip']`, both resolving to `{ resourceType: 'clip_assembly', subject: 'ffmpeg-trim-clip', label: 'Trim clip' }`.

- [ ] **Step 1: Add the constant and map entries**

In `generationApproval.ts`, add alongside the other `*_SUBJECT` constants:

```typescript
const TRIM_CLIP_SUBJECT = 'ffmpeg-trim-clip'
```

Add alongside the other `*Gen` object literals:

```typescript
const trimClipGen = { resourceType: 'clip_assembly', subject: TRIM_CLIP_SUBJECT, label: 'Trim clip' }
```

Add to `GENERATION_APPROVAL_METADATA`, alongside the other `mux-beat-audio`/`mux_beat_audio` pair:

```typescript
  'trim-clip': trimClipGen,
  'trim_clip': trimClipGen,
```

- [ ] **Step 2: Verify with a quick inline check**

Run: `cd apps/agent-orchestrator && node -e "
const { GENERATION_APPROVAL_METADATA } = require('./dist/mastra/tools/generationApproval.js')
console.log(GENERATION_APPROVAL_METADATA['trim-clip'], GENERATION_APPROVAL_METADATA['trim_clip'])
"` — if `dist` isn't built, instead just run `pnpm type-check` (Step 3) and cover this via Task 10's registration test, which asserts against the real map.

- [ ] **Step 3: Type-check**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/generationApproval.ts
git commit -m "feat(generation-approval): register trim-clip/trim_clip metadata

Both hyphenated and underscored forms, per this map's own documented
reason — either can arrive as toolName on a tool-call-approval chunk
depending on whether it's called directly or through a delegate."
```

---

### Task 6: `chatStream.ts`'s three attachment lists

**Files:**
- Modify: `apps/agent-orchestrator/src/routes/chatStream.ts:157,271,676`
- Test: `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts` (note the `__tests__` subdirectory — NOT `src/routes/chatStream.test.ts`, which doesn't exist. This file already has a negative test for `transcribe-audio` at `:294-296` — do not add a duplicate of it.)

**Interfaces:**
- Consumes: nothing new.
- Produces: `'trim-clip'` present in `attachmentFromCanvasToolResult`'s allowlist array, `SAVE_TOOL_NAMES`, and the mirrored exclusion array. This is the exact class of bug skill 5's final whole-branch review caught as a Critical repeat of an earlier skill's bug (`d04d1f9b`) — every prior skill missed this once, do not miss it a third time.

- [ ] **Step 1: Write the failing test**

In `apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts`, find the existing tests for `attachmentFromCanvasToolResult` (skill 5 added ones for `mux-beat-audio` etc. — follow that exact pattern; the file already has a `transcribe-audio`-returns-null negative test at `:294-296`, so only ONE new test is needed here, not two) and add:

```typescript
it('recognizes trim-clip as a canvas attachment result', () => {
  const result = attachmentFromCanvasToolResult('trim-clip', { fileId: 'f1', name: 'trimmed.mp4', fileType: 'video/mp4', size: 100 })
  expect(result).toMatchObject({ fileId: 'f1' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/routes/__tests__/chatStream.test.ts -t "trim-clip"`
Expected: FAIL — `'trim-clip'` isn't in the allowlist array yet, `attachmentFromCanvasToolResult` returns `null`.

- [ ] **Step 3: Add `'trim-clip'` to all three lists**

In `attachmentFromCanvasToolResult` (`:157`):

```typescript
if (!['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video', 'generate-narration', 'lipsync', 'assemble-clips', 'mux-beat-audio', 'composite-end-card', 'burn-captions', 'mix-music-bed', 'trim-clip'].includes(normalizedToolName)) return null
```

In `SAVE_TOOL_NAMES` (`:271`):

```typescript
const SAVE_TOOL_NAMES = new Set(['saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks', 'rendercanvas', 'render-canvas', 'render_canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video', 'generate-narration', 'lipsync', 'assemble-clips', 'mux-beat-audio', 'composite-end-card', 'burn-captions', 'mix-music-bed', 'trim-clip'])
```

In the mirrored exclusion array (`:676`):

```typescript
if (SAVE_TOOL_NAMES.has(normName) && !['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video', 'generate-narration', 'lipsync', 'assemble-clips', 'mux-beat-audio', 'composite-end-card', 'burn-captions', 'mix-music-bed', 'trim-clip'].includes(normName)) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/routes/__tests__/chatStream.test.ts`
Expected: PASS — the 1 new test and every pre-existing test in the file, including the existing `transcribe-audio` negative test at `:294-296`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/routes/chatStream.ts apps/agent-orchestrator/src/routes/__tests__/chatStream.test.ts
git commit -m "feat(chat-stream): add trim-clip to attachment allowlists

Hyphenated form only — resolvedToolName is normalized before lookup in
all three lists. Missing this would generate/charge a trimmed clip that
never reaches the user, the same bug class skill 5's final review caught
as a Critical repeat of d04d1f9b."
```

---

### Task 7: `credit-rates.ts` seed row

**Files:**
- Modify: `packages/foundation/database/seeds/credit-rates.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: one new row, `{ resourceType: 'clip_assembly', subject: 'ffmpeg-trim-clip', pricingSchema: { per_call_micro: 1_000 } }`.

- [ ] **Step 1: Add the seed row**

Add alongside the existing `clip_assembly` rows (`ffmpeg-mux-audio`, `ffmpeg-composite-end-card`, `ffmpeg-burn-captions`, `ffmpeg-mix-music-bed`):

```typescript
  // short-drama-stitch's clip-trim step. Same "pure local compute, small
  // flat non-zero rate" reasoning as every other clip_assembly row above —
  // keeps the tool on the normal charge/approval code path instead of a
  // silent no-charge/no-approval carve-out. An unseeded row here doesn't
  // just leave the tool unbilled — shouldRequireApproval returns false
  // with no matching rate, so the tool would run free AND with no
  // approval card at all. This row must be seeded (pnpm db:seed) against
  // the deployed environment before a live run, same lesson skill 5
  // documented for its own rows.
  { resourceType: 'clip_assembly', subject: 'ffmpeg-trim-clip',
    pricingSchema: { per_call_micro: 1_000 } },
```

- [ ] **Step 2: Type-check**

Run: `cd packages/foundation/database && pnpm type-check` (or the monorepo-root equivalent if this package has no standalone script — check `package.json` first)
Expected: PASS — no schema/migration needed, this is a seed-data-only file.

- [ ] **Step 3: Commit**

```bash
git add packages/foundation/database/seeds/credit-rates.ts
git commit -m "feat(credit-rates): seed ffmpeg-trim-clip rate for short-drama-stitch

No migration needed — clip_assembly has no Postgres enum constraint.
Must still be run via pnpm db:seed against the deployed environment
before a live run, or trim_clip runs free with no approval card."
```

---

### Task 8: `directorAgent.ts` — new `SHORT_DRAMA_STITCH_SECTION` and tool wiring

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`

**Interfaces:**
- Consumes: `trimClip` from Task 4 (`../tools/trimClip.js`), `analyzeVideoTool`'s extended `durationSeconds` output from Task 1, `assembleClips`'s `transitions` param from Task 3.
- Produces: `SHORT_DRAMA_STITCH_SECTION` constant, appended to both `directorAgent` and `directorAgentDelegate`'s instructions and `tools:` maps. Task 10 tests this section's content and tool registration.

- [ ] **Step 1: Add the import**

Alongside the other tool imports at the top of `directorAgent.ts`:

```typescript
import { trimClip } from '../tools/trimClip.js'
```

- [ ] **Step 2: Write `SHORT_DRAMA_STITCH_SECTION`**

Add after `ANIMATION_CHARACTER_SECTION`, following the exact same structural pattern (a template-literal string constant, imperative present-tense instructions, exact tool-call sequencing):

```typescript
  const SHORT_DRAMA_STITCH_SECTION = `\n\n## Short-drama-stitch — editing footage the user already has, never generating video
When Olmo delegates a short-drama-stitch ad build (the user has uploaded existing footage — short-drama/episode clips, multiple takes, raw b-roll — and wants an ad-length cut assembled from it): this is the ONLY skill that never calls generate_image or generate_video. If the footage genuinely can't support the ask (too few usable clips, wrong content, nothing that fits the target length), tell Olmo plainly and stop — never fill a gap with generated video.

- Selection Mode A (AI-proposed): call analyze_video (mode "quick") once per uploaded clip. Its result now includes durationSeconds and frame descriptions labeled with real timestamps (e.g. "Frame at t=4.5s") — use these to propose which segments of which clips make a compelling cut, in what order, sized to the target length Olmo gave you. Treat these timestamps as approximate; trim_clip's own duration probe is the real correctness backstop, not this proposal.
- Selection Mode B (user-specified): if Olmo tells you the user already gave exact clip/timestamp/order choices, skip analyze_video entirely and use those directly.
- Cut-list approval: present the full proposed (or user-given) list — clip, in/out timestamps, order, and transition choice per boundary (cut, or a named crossfade with an overlap length) — to Olmo for one approval covering the whole list, before any trim_clip or assemble_clips call. Never trim or assemble before this approval.
- Trim: after approval, call trim_clip once per selected segment — sourceFileId set to that clip's fileId, startSeconds/endSeconds set to the approved in/out points. If a call returns refusalReason "INVALID_TRIM_RANGE", tell Olmo the requested range exceeds that clip's real length and ask whether to adjust the cut list or drop that segment.
- Assembly: call assemble_clips ONCE with clipFileIds set to the trimmed segments' fileIds in the approved order, preserveAudio set to true, transitions set to the approved per-boundary list (each entry either { type: "xfade", name: "fade", overlapSeconds: <a positive number, never 0> } or { type: "cut" } — never an xfade entry with overlapSeconds 0 or omitted, use type "cut" instead for a hard cut), and aspectRatio matching intake. Do not set targetDurationSeconds here — every clip is already individually trimmed by trim_clip.
- Transcription: call transcribe_audio with fileId set to the assembled master's fileId (it extracts audio itself, no mimeType needed).
- Captions: call burn_captions with videoFileId set to the assembled master's fileId and words set to exactly what transcribe_audio returned.
- Brand-name check: this skill never generates speech, so there is no approved script to compare against — instead compare transcribe_audio's text against the exact brand/product spelling Olmo confirmed with the user at intake. If it's missing or garbled, tell Olmo plainly rather than presenting a broken caption as finished.
- Music: call generate_song for the bed, then mix_music_bed with videoFileId set to the CAPTIONED master (not the pre-caption one) and musicFileId set to the bed. This is the LAST call in the pipeline — never generate or mix the bed earlier.
- If mix_music_bed returns refusalReason "MUSIC_BED_INAUDIBLE", tell Olmo the bed could not be mixed audibly and ask whether to retry generate_song for a different bed or deliver without one.
- Delivery: present the final assembled, captioned, scored cut as ONE continuous ad built from the user's own footage. There is no board-of-stills gate in this skill — nothing was generated for Olmo or the user to visually approve before it became real uploaded footage already was.`
```

- [ ] **Step 3: Wire it into the composed instructions and both tools maps**

Change the `base` line:

```typescript
  const base = (override || defaultInstructions) + TEMPLATE_CLONING_SECTION + UGC_CHARACTER_SECTION + MOTION_CRAFT_SECTION + TALKING_HEAD_SECTION + ANIMATION_CHARACTER_SECTION + SHORT_DRAMA_STITCH_SECTION
```

Add `trim_clip: trimClip` to both `tools:` map literals (the `directorAgent` one at `:168` and the `directorAgentDelegate` one at `:187`):

```typescript
  tools: { generate_image: generateImage, edit_image: editImage, generate_video: generateVideo, retrieve_template: retrieveTemplate, analyze_video: analyzeVideoTool, analyze_audio: analyzeAudioTool, analyze_image: analyzeImageTool, generate_narration: generateNarration, lipsync: lipsync, assemble_clips: assembleClips, mux_beat_audio: muxBeatAudio, transcribe_audio: transcribeAudio, composite_end_card: compositeEndCard, burn_captions: burnCaptions, mix_music_bed: mixMusicBed, generate_song: generateSong, trim_clip: trimClip },
```

(Apply the same addition to both occurrences of this literal.)

- [ ] **Step 4: Type-check**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/directorAgent.ts
git commit -m "feat(director-agent): add short-drama-stitch section and trim_clip wiring

New SHORT_DRAMA_STITCH_SECTION following the established per-skill
pattern — the only skill that never generates video. Registers trim_clip
on both directorAgent and directorAgentDelegate's tools maps."
```

---

### Task 9: `platformAgent.ts` — new `SHORT_DRAMA_STITCH_CONTRACT` and routing disambiguation

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`

**Interfaces:**
- Consumes: nothing new (prose only).
- Produces: `SHORT_DRAMA_STITCH_CONTRACT` constant, spliced into the final `return composed + ...` chain, PLUS a one-line reciprocal addition to each of `UGC_CHARACTER_CONTRACT`, `TALKING_HEAD_CONTRACT`, and `ANIMATION_CHARACTER_CONTRACT`'s own opening trigger lines (see Step 1b) and a `ROUTING_CONTRACT` update (Step 1c). Task 10 tests routing-disambiguation between this and `ANIMATION_CHARACTER_CONTRACT` BOTH ways, not just one.

- [ ] **Step 1a: Write `SHORT_DRAMA_STITCH_CONTRACT`**

Add after `ANIMATION_CHARACTER_CONTRACT`, following the same structural pattern (mutual-exclusion opening line naming the other contracts it could be confused with, numbered intake-through-delivery steps). The cost-confirmation count below is not "one" — `shouldRequireApproval` fires per tool call, and this flow calls `trim_clip` once PER SELECTED SEGMENT (up to 8) plus `assemble_clips`, `transcribe_audio`, `burn_captions`, `generate_song`, `mix_music_bed` — roughly 6-13 confirmations depending on segment count, the same honest-count discipline `ANIMATION_CHARACTER_CONTRACT`'s own step 3 already follows ("roughly 20-23"):

```typescript
    const SHORT_DRAMA_STITCH_CONTRACT = `\n\n## Short-drama-stitch ad — editing existing footage, never generating video
This contract applies when the user already HAS video footage (uploaded clips — short-drama/episode content, multiple takes, raw b-roll) and wants it cut down into an ad-length video — NOT when the user wants new footage created from scratch (that's the UGC character, Talking-head, or Animation-character contracts above, all of which generate video; this one never does). Signals: "stitch these clips", "cut this footage into an ad", "make a trailer from my clips", "edit my videos into one ad", any request accompanied by multiple uploaded video files and no request to generate new visuals.
1. Intake: confirm the uploaded footage pool (ask the user to upload if they haven't yet), target length (~15-30s, default 20s), story intent, and the exact spelling of any brand/product name that should appear in the footage's dialogue (needed later for the caption/brand-name check — this skill has no script to check against, only this confirmed spelling).
2. Ask whether the user wants to pick exact clip/timestamp/order/transition choices themselves, or have agent-director propose a cut list from the footage by watching each clip. Either is fine; tell agent-director which the user chose.
3. Tell the user plainly, before delegating: this flow involves roughly 6-13 separate cost confirmations — one trim_clip call per selected segment (up to 8), plus assembly, transcription, captions, and the music generation/mix steps — fewer than the generation-heavy skills above since no stills or clips are being generated, but still several separate cards, not one.
4. Delegate to agent-director with the footage pool's fileIds, the target length, story intent, the confirmed brand-name spelling, and whichever selection mode the user chose.
5. Cut-list approval: agent-director will propose or relay a cut list (clips, trim points, order, transitions) — present it to the user for one approval before any editing work begins. This is the one AGENT-LEVEL gate before spend starts (separate from the per-tool-call cost cards in step 3, which still happen individually as each trim/assembly/audio call runs).
6. Delivery: present the final cut as ONE continuous ad built from the user's own footage. Tell the user plainly this is an edit of their existing footage, not a newly generated ad — no character or cast sheet is created or reusable here, unlike the generation-based skills above.`
```

- [ ] **Step 1b: Add the reciprocal disambiguation clause to the three generation contracts**

Every existing contract's opening trigger line names the OTHER contracts it could be confused with, bidirectionally — `UGC_CHARACTER_CONTRACT` names Talking-head and Animation-character, `TALKING_HEAD_CONTRACT` names UGC and Animation-character, `ANIMATION_CHARACTER_CONTRACT` names template-cloning/UGC/Talking-head. None of them currently mention short-drama-stitch, so adding `SHORT_DRAMA_STITCH_CONTRACT` alone makes the disambiguation one-directional — a request like "edit my existing clips into an animated-style ad" could still land on `ANIMATION_CHARACTER_CONTRACT` without ever being told short-drama-stitch was the closer match. Add one clause to each of the three contracts' opening trigger sentences (do not rewrite the rest of each contract):

In `UGC_CHARACTER_CONTRACT`'s opening line, after the existing "if the user wants a STYLIZED/animated/cartoon-look story ad, use the Animation-character ad contract below instead" clause, add: "; if the user already HAS existing video footage and wants it edited/cut down rather than newly generated, use the Short-drama-stitch ad contract below instead".

In `TALKING_HEAD_CONTRACT`'s opening line, after its existing UGC/Animation-character disambiguation, add the same clause: "; if the user already HAS existing video footage and wants it edited/cut down rather than newly generated, use the Short-drama-stitch ad contract below instead".

In `ANIMATION_CHARACTER_CONTRACT`'s opening line, after its existing template-cloning/UGC/Talking-head disambiguation, add the same clause.

- [ ] **Step 1c: Widen `ROUTING_CONTRACT` to cover editing verbs, not just generation verbs**

`ROUTING_CONTRACT` currently reads: "If the user asks to create, generate, make, draw, or produce an image, video, or ad, delegate to agent-director" — none of those verbs match "stitch these clips" or "edit my videos into one ad", so a short-drama-stitch request risks the same failure mode `ROUTING_CONTRACT`'s own code comment already documents happened once before (Olmo tried `retrieve_documents`/`list_folder` instead of delegating). Add "stitch, cut, edit, or assemble existing footage into" to the verb list in that sentence, alongside "create, generate, make, draw, or produce".

- [ ] **Step 2: Wire `SHORT_DRAMA_STITCH_CONTRACT` into the composed contract chain**

Change the final return line:

```typescript
    return composed + CLARIFICATION_CONTRACT + CODE_BLOCK_CONTRACT + CANVAS_CONTRACT + IDENTITY_CONTRACT + SKILL_CREATION_CONTRACT
      + DELEGATION_CONTRACT + ROUTING_CONTRACT + COST_CONFIRMATION_CONTRACT + TEMPLATE_VIDEO_CONTRACT + UGC_CHARACTER_CONTRACT + TALKING_HEAD_CONTRACT + ANIMATION_CHARACTER_CONTRACT + SHORT_DRAMA_STITCH_CONTRACT + THINKING_STYLE_CONTRACT + invokedSkillsInstruction(invokedThisTurn)
```

- [ ] **Step 3: Type-check**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts
git commit -m "feat(platform-agent): add short-drama-stitch contract

Mutual-exclusion opening line disambiguates from the three generation
contracts — this is the only one that never generates video."
```

---

### Task 10: `directorAgent.test.ts` coverage — tool registration, section content, routing disambiguation

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/agents/__tests__/platformAgent.test.ts` (both already have a routing-disambiguation test suite from skill 4/5's equivalent tasks — follow its exact `RequestContext`/`getInstructions` pattern)

**Interfaces:**
- Consumes: `SHORT_DRAMA_STITCH_SECTION`/`SHORT_DRAMA_STITCH_CONTRACT` (not exported directly — tested via the composed instructions string, same as skill 5's equivalent tests).

- [ ] **Step 1: Write the failing tests**

Test files are at `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts` and `apps/agent-orchestrator/src/mastra/agents/__tests__/platformAgent.test.ts` (note the `__tests__` subdirectory). Both files already use `RequestContext` (from `@mastra/core/request-context`) and `agent.getInstructions({ requestContext })` — read a few existing tests in each file first (already done during plan review; the pattern below matches what's really there) and follow that exact shape, not a bare-function-call invocation.

In `directorAgent.test.ts`:

```typescript
it('registers trim_clip on both directorAgent and directorAgentDelegate', async () => {
  const agentTools = await directorAgent.listTools()
  const delegateTools = await directorAgentDelegate.listTools()
  expect(Object.keys(agentTools)).toEqual(expect.arrayContaining(['trim_clip']))
  expect(Object.keys(delegateTools)).toEqual(expect.arrayContaining(['trim_clip']))
})

it('includes the short-drama-stitch section with its no-generation rule', async () => {
  const requestContext = new RequestContext()
  const instructions = await directorAgent.getInstructions({ requestContext })
  const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
  expect(text).toContain('short-drama-stitch')
  expect(text).toContain('never calls generate_image or generate_video')
})

it('includes the exact brand-name-check substring for short-drama-stitch (no script to compare against)', async () => {
  const requestContext = new RequestContext()
  const instructions = await directorAgent.getInstructions({ requestContext })
  const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
  expect(text).toContain('this skill never generates speech, so there is no approved script to compare against')
})

it('orders captions before music in the short-drama-stitch section (pipeline-order regression guard)', async () => {
  const requestContext = new RequestContext()
  const instructions = await directorAgent.getInstructions({ requestContext })
  const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
  const shortDramaIdx = text.indexOf('Short-drama-stitch')
  const section = text.slice(shortDramaIdx)
  const captionsIdx = section.indexOf('Captions: call burn_captions')
  const musicIdx = section.indexOf('Music: call generate_song')
  expect(captionsIdx).toBeGreaterThan(-1)
  expect(musicIdx).toBeGreaterThan(captionsIdx)
})
```

In `platformAgent.test.ts`:

```typescript
it('includes the short-drama-stitch contract with its no-generation mutual-exclusion clause', async () => {
  const requestContext = new RequestContext()
  const instructions = await platformAgent.getInstructions({ requestContext })
  const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
  expect(text).toContain('Short-drama-stitch ad')
  expect(text).toContain('NOT when the user wants new footage created from scratch')
})

it('disambiguates short-drama-stitch from the three generation contracts BOTH ways', async () => {
  const requestContext = new RequestContext()
  const instructions = await platformAgent.getInstructions({ requestContext })
  const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
  // Bidirectional: short-drama-stitch's own opening line names the other
  // three, AND each of the other three's opening line now names
  // short-drama-stitch back — a one-directional version would pass a
  // weaker assertion that only checked both section headers exist, which
  // proves nothing about whether either contract actually POINTS at the
  // other. This test asserts the actual disambiguating clause is present
  // on all three reciprocal sides, not just that both sections exist.
  const ugcIdx = text.indexOf('## UGC character ad')
  const talkingHeadIdx = text.indexOf('## Talking-head ad')
  const animIdx = text.indexOf('## Animation-character ad')
  const dramaIdx = text.indexOf('## Short-drama-stitch ad')
  expect(ugcIdx).toBeGreaterThan(-1)
  expect(talkingHeadIdx).toBeGreaterThan(-1)
  expect(animIdx).toBeGreaterThan(-1)
  expect(dramaIdx).toBeGreaterThan(-1)
  const reciprocalClause = 'Short-drama-stitch ad contract below instead'
  expect(text.slice(ugcIdx, ugcIdx + 800)).toContain(reciprocalClause)
  expect(text.slice(talkingHeadIdx, talkingHeadIdx + 800)).toContain(reciprocalClause)
  expect(text.slice(animIdx, animIdx + 800)).toContain(reciprocalClause)
})

it('widens ROUTING_CONTRACT to cover editing verbs, not just generation verbs', async () => {
  const requestContext = new RequestContext()
  const instructions = await platformAgent.getInstructions({ requestContext })
  const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
  expect(text).toContain('stitch, cut, edit, or assemble existing footage into')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/agents/__tests__/directorAgent.test.ts src/mastra/agents/__tests__/platformAgent.test.ts -t "short-drama-stitch|trim_clip|ROUTING_CONTRACT"`
Expected: FAIL — none of this content exists before Tasks 8/9 land (this task runs after them).

- [ ] **Step 3: Run the full test suite**

Run: `cd apps/agent-orchestrator && pnpm vitest run`
Expected: PASS — every test in the app, including all tests added across Tasks 1-9.

- [ ] **Step 4: Run type-check across the whole app**

Run: `cd apps/agent-orchestrator && pnpm type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts apps/agent-orchestrator/src/mastra/agents/__tests__/platformAgent.test.ts
git commit -m "test(short-drama-stitch): cover tool registration, section content, and bidirectional routing disambiguation

Confirms trim_clip is registered on both directorAgent and its delegate,
the section's no-generation rule and pipeline order are present, and
Olmo's contract disambiguates from all three generation contracts in
BOTH directions plus a widened ROUTING_CONTRACT verb list."
```

---

## Post-plan deployment note (for the final whole-branch review / deployment checklist, not a task here)

This plan does not run `pnpm db:seed` (no `DATABASE_URL` in this environment) — Task 7's row must be seeded against the target environment before a live run, or `trim_clip` runs free with no approval card. This plan also does not verify libass/ffmpeg build details on any deployment target — carry forward the same environment-gap caveat skill 5's deployment-status memory already documents, since `burn_captions` is reused unchanged here and was never verified against a libass-enabled ffmpeg build on any machine used during this or the prior skill's implementation.

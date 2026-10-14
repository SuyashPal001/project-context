# Social Video Clone — Phase 1 (Breakdown) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user pastes a social video link (or attaches a video) and the agent returns a complete, measured breakdown of it — story, moments, looks, poses, movement, props, setting, the trick, exact cuts, hidden cuts and sound timing — via one `break_down_video` tool plus the separate small tools it is built from.

**Architecture:** Mastra tools in `apps/agent-orchestrator` do fetching, Gemini calls and composition. Gemini receives the WHOLE video plus audio through the inference gateway (new `input_video` content part). CPU measuring work (TransNetV2 cuts, OpenCV hidden cuts, ffmpeg loudness) runs in `apps/ai-service` (FastAPI, same VM), which reads the orchestrator's local media cache by path. Gemini's own timings are always overridden by measured ones.

**Tech Stack:** TypeScript, Mastra `createTool`, zod, vitest (orchestrator + gateway); Python 3, FastAPI, pytest, `transnetv2-pytorch`, `opencv-python-headless`, numpy (ai-service); ffmpeg/ffprobe, `yt-dlp` on the VM.

**Spec:** `docs/superpowers/specs/2026-10-14-social-video-clone-design.md` (sections 2, 4, 5.1, 5.2, 6.1, 8, 11, 13 phase 1, 14). Phases 2–4 (checks, remake, plates) get their own plans.

## Global Constraints

- Watch model: `gemini-3.8-flash`, thinking level `LOW`, temperature ≤ 0.2. Never send frames-as-images to watch a video (11x the cost, no audio).
- Video fps sent to Gemini: `4` if duration ≤ 30s, `2` if ≤ 90s, else `1`.
- Fetch is logged-out only. Never pass cookies or an account to `yt-dlp`. TikTok returns a plain "upload the file instead" message.
- Stored/played video must be H.264 (`yt-dlp -S "vcodec:h264,res:1080,acodec:m4a"`, then ffmpeg-convert if still not H.264).
- YouTube links go to Gemini as the URL itself (`fileUri`), not a download, for watching.
- Videos longer than 90s: return a segment map and ask which part to clone; do not run the full breakdown.
- Measured times (TransNetV2, look matching, loudness) override Gemini's times everywhere.
- `find_hidden_cuts` runs ONLY when `watch_video.change_style` contains `hidden_changes`.
- A checker or parser with no usable data returns `unknown`/an error — never a pass, never an empty success.
- Model JSON replies may be a bare list or an object; every parser accepts both.
- Directions in prompts and outputs are image-left / image-right.
- Music: the original song is never downloaded into a deliverable. Song name/artist come only from platform metadata or on-screen/caption text — never guessed (spec §9a). Phase 1 only RECORDS music facts (mood, genre, instruments, vocals, BPM, beats, song name); using them is phase 3.
- Do not add effects, expressions or actions the reference does not show (spec §7.1) — applies to prompts written here too.
- Skill text is append-only (memory `feedback_prompt_changes_additive_only`).

## Review Focus

1. **A long video (> 90s) or an oversized file** — expected: no Gemini watch call, a segment map and a question; never a 413/timeout from the gateway. Test in Task 3 (`fetchVideo` duration branch) and Task 4 (size guard).
2. **Gemini replies with a bare JSON list, markdown fences, or a missing key** — expected: parsed or a clear error, never a silent empty result. Test in Task 2 (`parseModelJson`).
3. **ai-service down or slow** — expected: `find_cuts`/`sound_timeline` return `{ success:false, error }` and `break_down_video` still returns the Gemini overview marked `measured:false` instead of crashing. Test in Task 9.
4. **A hard-cut video where Gemini lists many looks** (the Facebook reaction case) — expected: hidden-cut detection does NOT run; shot count follows TransNetV2. Test in Task 9.
5. **A path outside the media cache sent to ai-service** — expected: 400, file never read. Test in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/inference-gateway/src/types.ts` | add `input_video` content part and `thinkingLevel` to request types |
| `apps/inference-gateway/src/adapters/vertex.ts`, `gemini.ts` | map `input_video` → Gemini `inlineData`/`fileData` + `videoMetadata.fps`; map `thinkingLevel` |
| `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/geminiVideo.ts` | prepare an analysis copy of a video, call Gemini with the whole video, parse JSON, record cost |
| `.../videoBreakdown/fetchVideo.ts` | `fetch_video` tool: link/upload → cached local file + H.264 Drive file + metadata |
| `.../videoBreakdown/watchVideo.ts` | `watch_video` tool: overview JSON |
| `.../videoBreakdown/aiServiceClient.ts` | typed client for ai-service `/cuts`, `/hidden-cuts`, `/sound` |
| `.../videoBreakdown/measureTools.ts` | `find_cuts`, `find_hidden_cuts`, `sound_timeline` tools |
| `.../videoBreakdown/describeShots.ts` | `describe_shots` tool + bounds merging |
| `.../videoBreakdown/checkShortShots.ts` | `check_short_shots` tool |
| `.../videoBreakdown/breakDownVideo.ts` | `break_down_video` composite |
| `.../videoBreakdown/index.ts` | re-exports for agent registration |
| `apps/ai-service/media/` (new package) | `auth.py`, `paths.py`, `cuts.py`, `hidden_cuts.py`, `sound.py`, `router.py` |
| `apps/ai-service/tests/` | pytest with synthetic ffmpeg-made videos |
| `apps/agent-orchestrator/src/mastra/tools/analyzeVideo.ts` | internals switched to the whole-video call |
| agents + `seeds/official-skills/template-video.md` | register tools; append skill step |

---

### Task 1: Gateway accepts whole videos and a thinking level

**Files:**
- Modify: `apps/inference-gateway/src/types.ts:31-36` and the `OpenAIRequest` interface
- Modify: `apps/inference-gateway/src/adapters/vertex.ts` (`toGeminiParts`, `buildGeminiRequest`)
- Modify: `apps/inference-gateway/src/adapters/gemini.ts` (`toGeminiParts`, its request builder)
- Test: `apps/inference-gateway/src/adapters/vertex.test.ts`, `gemini.test.ts`

**Interfaces:**
- Produces: content part `{ type: 'input_video', input_video: { data?: string /* base64 */, url?: string /* https YouTube or gs:// */, mime?: string /* default video/mp4 */, fps?: number } }`; request field `thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH'`.

- [ ] **Step 1: Write the failing tests** (append to `vertex.test.ts`; mirror the same three cases in `gemini.test.ts` against its `toGeminiParts`)

```ts
import { describe, it, expect } from 'vitest'
import { toGeminiParts } from './vertex'

describe('toGeminiParts input_video', () => {
  it('inline base64 video becomes inlineData with videoMetadata.fps', () => {
    const parts = toGeminiParts([{ type: 'input_video', input_video: { data: 'AAAA', fps: 4 } }])
    expect(parts).toEqual([{ inlineData: { mimeType: 'video/mp4', data: 'AAAA' }, videoMetadata: { fps: 4 } }])
  })
  it('a YouTube URL becomes fileData', () => {
    const parts = toGeminiParts([{ type: 'input_video', input_video: { url: 'https://www.youtube.com/watch?v=x', fps: 2 } }])
    expect(parts).toEqual([{ fileData: { mimeType: 'video/mp4', fileUri: 'https://www.youtube.com/watch?v=x' }, videoMetadata: { fps: 2 } }])
  })
  it('a video part with neither data nor url is dropped', () => {
    expect(toGeminiParts([{ type: 'input_video', input_video: {} }])).toEqual([])
  })
})
```

Add one more test in `vertex.test.ts` for `buildGeminiRequest` (export it if it is not exported — add `export` to the existing function, no behaviour change):

```ts
it('thinkingLevel maps to generationConfig.thinkingConfig.thinkingLevel', () => {
  const req = buildGeminiRequest({ messages: [{ role: 'user', content: 'hi' }], thinkingLevel: 'LOW' })
  expect(req.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'LOW' } })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/inference-gateway && pnpm vitest run src/adapters/vertex.test.ts src/adapters/gemini.test.ts`
Expected: FAIL (type error / `[]` instead of the video part).

- [ ] **Step 3: Implement**

`types.ts`:
```ts
export interface OpenAIContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video';
  text?: string;
  image_url?: { url: string; detail?: string };
  input_audio?: { data: string; format: string };
  /** Whole video for Gemini: base64 `data` (≤ 15 MB) or a `url` (YouTube watch URL or gs://). */
  input_video?: { data?: string; url?: string; mime?: string; fps?: number };
}
// in OpenAIRequest:
  /** Gemini 3.x thinking level. Ignored when thinkingBudget is set. */
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
```

In both adapters' `toGeminiParts`, before the final `return []`:
```ts
if (block.type === 'input_video' && block.input_video) {
  const v = block.input_video
  const mimeType = v.mime ?? 'video/mp4'
  const meta = v.fps ? { videoMetadata: { fps: v.fps } } : {}
  if (v.data) return [{ inlineData: { mimeType, data: v.data }, ...meta } as Part]
  if (v.url) return [{ fileData: { mimeType, fileUri: v.url }, ...meta } as Part]
  return []
}
```
(`as Part` because the SDK's `Part` type does not list `videoMetadata`; the REST body passes it through. In `gemini.ts` widen `GeminiPart` with an optional `videoMetadata?: { fps?: number }` instead of casting.)

In `buildGeminiRequest` (vertex) and the gemini adapter's builder, after the `thinkingBudget` branch:
```ts
} else if (openaiReq.thinkingLevel) {
  generationConfig.thinkingConfig = { thinkingLevel: openaiReq.thinkingLevel };
}
```
(place it before the `includeThoughts` branch so the order is: budget → level → includeThoughts.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/inference-gateway && pnpm vitest run src/adapters && pnpm tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Live smoke test (manual, ~Rs 0.5)**

With the gateway running locally (`cd apps/inference-gateway && pnpm dev`), send a 2-second test clip:
```bash
ffmpeg -v error -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -c:v libx264 /tmp/claude-501/t.mp4
B64=$(base64 -i /tmp/claude-501/t.mp4)
curl -s localhost:4001/v1/chat/completions -H 'Content-Type: application/json' -H "x-internal-service-key: $INTERNAL_SERVICE_KEY" \
  -d "{\"model\":\"gemini-3.8-flash\",\"thinkingLevel\":\"LOW\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"input_video\",\"input_video\":{\"data\":\"$B64\",\"fps\":2}},{\"type\":\"text\",\"text\":\"Describe this video in one sentence.\"}]}]}" | head -c 600
```
Expected: a sentence mentioning a test pattern / colour bars, and `usage.prompt_tokens` > 0.

- [ ] **Step 6: Commit**

```bash
git add apps/inference-gateway/src/types.ts apps/inference-gateway/src/adapters/vertex.ts apps/inference-gateway/src/adapters/gemini.ts apps/inference-gateway/src/adapters/vertex.test.ts apps/inference-gateway/src/adapters/gemini.test.ts
git commit -m "feat(gateway): whole-video input and thinking level for Gemini"
```

---

### Task 2: Shared whole-video Gemini helper

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/geminiVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/geminiVideo.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/cost.ts:12` (add `'gemini-3.8-flash': { input: 0.75, output: 3.75 }` to the fallback pricing table)

**Interfaces:**
- Produces:
  - `fpsForDuration(seconds: number): 1 | 2 | 4`
  - `parseModelJson(raw: string): unknown` — strips ``` fences, parses the outermost `{...}` or `[...]`; throws `Error('unreadable model reply')` when neither parses.
  - `asObject(v: unknown, listKey: string): Record<string, unknown>` — a bare list becomes `{ [listKey]: list }`; an object is returned as is; a single-item list containing an object without `listKey` returns that object.
  - `prepareAnalysisCopy(filePath: string, signal?: AbortSignal): Promise<string>` — ffmpeg to 480p-wide H.264 CRF 30 + AAC 64k, cached next to the source as `<path>.analysis.mp4`; throws if the result is over 15 MB.
  - `askGeminiVideo(opts: { video: { filePath?: string; youtubeUrl?: string }; durationS: number; prompt: string; tenantId?: string; agentId: string; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<{ raw: string; usage: { prompt_tokens: number; completion_tokens: number } }>`
  - `WATCH_MODEL = 'gemini-3.8-flash'`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { fpsForDuration, parseModelJson, asObject, askGeminiVideo } from './geminiVideo.js'

vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))

describe('fpsForDuration', () => {
  it('uses 4 / 2 / 1 fps by length', () => {
    expect(fpsForDuration(15)).toBe(4)
    expect(fpsForDuration(30)).toBe(4)
    expect(fpsForDuration(60)).toBe(2)
    expect(fpsForDuration(178)).toBe(1)
  })
})

describe('parseModelJson / asObject', () => {
  it('parses fenced JSON objects', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('parses a bare list and wraps it under the list key', () => {
    expect(asObject(parseModelJson('[{"t":0,"remotes":1}]'), 'frames')).toEqual({ frames: [{ t: 0, remotes: 1 }] })
  })
  it('unwraps a one-item list holding the real object', () => {
    expect(asObject(parseModelJson('[{"shots":[]}]'), 'shots')).toEqual({ shots: [] })
  })
  it('throws on prose with no JSON', () => {
    expect(() => parseModelJson('Sorry, I cannot help')).toThrow('unreadable model reply')
  })
})

describe('askGeminiVideo', () => {
  it('sends a YouTube URL as input_video.url with the length-based fps and LOW thinking', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })))
    const out = await askGeminiVideo({ video: { youtubeUrl: 'https://www.youtube.com/watch?v=x' }, durationS: 60, prompt: 'p', agentId: 'watch-video', fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)
    expect(body.model).toBe('gemini-3.8-flash')
    expect(body.thinkingLevel).toBe('LOW')
    expect(body.messages[0].content[0]).toEqual({ type: 'input_video', input_video: { url: 'https://www.youtube.com/watch?v=x', fps: 2 } })
    expect(out.raw).toBe('{"ok":true}')
  })
  it('throws on a non-200 gateway reply', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }))
    await expect(askGeminiVideo({ video: { youtubeUrl: 'u' }, durationS: 10, prompt: 'p', agentId: 'a', fetchImpl })).rejects.toThrow('gateway 502')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/geminiVideo.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `geminiVideo.ts`**

```ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { persistCost } from '../../cost.js'

const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
export const WATCH_MODEL = 'gemini-3.8-flash'
const MAX_INLINE_BYTES = 15 * 1024 * 1024
const ASK_TIMEOUT_MS = 240_000

export function fpsForDuration(seconds: number): 1 | 2 | 4 {
  if (seconds <= 30) return 4
  if (seconds <= 90) return 2
  return 1
}

export function parseModelJson(raw: string): unknown {
  const s = raw.replace(/```(?:json)?/g, '').trim()
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const a = s.indexOf(open), b = s.lastIndexOf(close)
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)) } catch { /* try the other shape */ }
    }
  }
  throw new Error('unreadable model reply')
}

export function asObject(v: unknown, listKey: string): Record<string, unknown> {
  if (Array.isArray(v)) {
    if (v.length === 1 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]) && !(listKey in v[0]) && Object.keys(v[0]).some((k) => Array.isArray((v[0] as Record<string, unknown>)[k]) || typeof (v[0] as Record<string, unknown>)[k] === 'object')) {
      return v[0] as Record<string, unknown>
    }
    return { [listKey]: v }
  }
  if (v && typeof v === 'object') return v as Record<string, unknown>
  throw new Error('unreadable model reply')
}

export async function prepareAnalysisCopy(filePath: string, signal?: AbortSignal): Promise<string> {
  const out = `${filePath}.analysis.mp4`
  if (!existsSync(out)) {
    await execFile('ffmpeg', ['-v', 'error', '-y', '-i', filePath, '-vf', 'scale=480:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', out], { timeout: 180_000, signal })
  }
  if (statSync(out).size > MAX_INLINE_BYTES) throw new Error('video too large to analyse inline; pick a shorter segment')
  return out
}

export async function askGeminiVideo(opts: {
  video: { filePath?: string; youtubeUrl?: string }
  durationS: number
  prompt: string
  tenantId?: string
  agentId: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<{ raw: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
  const fps = fpsForDuration(opts.durationS)
  let videoPart: { type: 'input_video'; input_video: { data?: string; url?: string; fps: number } }
  if (opts.video.youtubeUrl) {
    videoPart = { type: 'input_video', input_video: { url: opts.video.youtubeUrl, fps } }
  } else if (opts.video.filePath) {
    const copy = await prepareAnalysisCopy(opts.video.filePath, opts.signal)
    videoPart = { type: 'input_video', input_video: { data: readFileSync(copy).toString('base64'), fps } }
  } else {
    throw new Error('askGeminiVideo needs a filePath or youtubeUrl')
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    signal: opts.signal ?? AbortSignal.timeout(ASK_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({ model: WATCH_MODEL, temperature: 0.1, max_tokens: 16000, thinkingLevel: 'LOW', messages: [{ role: 'user', content: [videoPart, { type: 'text', text: opts.prompt }] }] }),
  })
  if (!res.ok) throw new Error(`gateway ${res.status}`)
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const usage = { prompt_tokens: json.usage?.prompt_tokens ?? 0, completion_tokens: json.usage?.completion_tokens ?? 0 }
  if (opts.tenantId) persistCost({ tenantId: opts.tenantId, agentId: opts.agentId, workflowId: 'video-breakdown', model: WATCH_MODEL, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens })
  const raw = json.choices?.[0]?.message?.content ?? ''
  if (!raw) throw new Error('empty model reply')
  return { raw, usage }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/geminiVideo.test.ts && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoBreakdown/geminiVideo.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/geminiVideo.test.ts apps/agent-orchestrator/src/mastra/cost.ts
git commit -m "feat(orchestrator): whole-video Gemini helper with tolerant JSON parsing"
```

---

### Task 3: `fetch_video` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/fetchVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/fetchVideo.test.ts`

**Interfaces:**
- Consumes: `fetchPresignedUrl`, `downloadToSessionCache` (`../mediaCache.js`), `uploadGeneratedFile` (`../../../persistence.js`), `MEDIA_DIR` (`../../../types.js`).
- Produces:
  - `classifyLink(url: string): 'youtube' | 'instagram' | 'x' | 'facebook' | 'linkedin' | 'tiktok' | 'other'`
  - `interface FetchedVideo { fileId: string; filePath: string; durationS: number; width: number; height: number; fps: number; hasAudio: boolean; caption: string | null; song: { name: string; artist: string | null } | null; youtubeUrl: string | null; platform: string; tooLong: boolean }` — `song` only from the platform's own metadata (yt-dlp `track`/`artist`), never guessed.
  - `fetchVideo(input: { url?: string; fileId?: string }, ctx: { idToken: string; scopeId: string; conversationId: string }, deps?): Promise<FetchedVideo>` — throws `FetchRefused` with a user-ready message for TikTok/blocked posts.
  - tool id `fetch_video`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyLink, fetchVideo, FetchRefused } from './fetchVideo.js'

const execCalls: Array<{ file: string; args: string[] }> = []
let probeJson = ''
let ytdlpFails = ''
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _o: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    execCalls.push({ file, args })
    if (file === 'yt-dlp' && ytdlpFails) return cb(Object.assign(new Error('yt-dlp failed'), { stderr: ytdlpFails }))
    if (file === 'ffprobe') return cb(null, { stdout: probeJson, stderr: '' })
    if (file === 'yt-dlp' && args.includes('--print')) return cb(null, { stdout: 'author | caption text\nAs It Was\tHarry Styles\n', stderr: '' })
    cb(null, { stdout: '', stderr: '' })
  },
}))
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), readFileSync: vi.fn(() => Buffer.from('mp4')), existsSync: vi.fn(() => true) }))
vi.mock('../../../persistence.js', () => ({ uploadGeneratedFile: vi.fn(async () => ({ fileId: 'file-new', name: 'x.mp4', type: 'video/mp4', size: 3 })) }))
vi.mock('../mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async () => 'https://s3/x'), downloadToSessionCache: vi.fn(async () => ({ filePath: '/cache/s-f.mp4', buf: Buffer.from(''), mimeType: 'video/mp4' })) }))

const ctx = { idToken: 't', scopeId: 's', conversationId: 'c' }
const probe = (codec: string, dur: number) => JSON.stringify({ format: { duration: String(dur) }, streams: [{ codec_type: 'video', codec_name: codec, width: 720, height: 1280, r_frame_rate: '30/1' }, { codec_type: 'audio' }] })

beforeEach(() => { execCalls.length = 0; ytdlpFails = ''; probeJson = probe('h264', 15) })

describe('classifyLink', () => {
  it('knows the platforms, including short links', () => {
    expect(classifyLink('https://youtu.be/abc')).toBe('youtube')
    expect(classifyLink('https://www.instagram.com/p/x/')).toBe('instagram')
    expect(classifyLink('https://x.com/a/status/1')).toBe('x')
    expect(classifyLink('https://www.facebook.com/reel/1')).toBe('facebook')
    expect(classifyLink('https://lnkd.in/p/abc')).toBe('linkedin')
    expect(classifyLink('https://www.tiktok.com/@a/video/1')).toBe('tiktok')
  })
})

describe('fetchVideo', () => {
  it('refuses TikTok with an upload message and never runs yt-dlp', async () => {
    await expect(fetchVideo({ url: 'https://www.tiktok.com/@a/video/1' }, ctx)).rejects.toBeInstanceOf(FetchRefused)
    expect(execCalls.find((c) => c.file === 'yt-dlp')).toBeUndefined()
  })
  it('downloads logged-out with the H.264 preference and no cookies', async () => {
    await fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    const dl = execCalls.find((c) => c.file === 'yt-dlp' && !c.args.includes('--print'))!
    expect(dl.args).toEqual(expect.arrayContaining(['-S', 'vcodec:h264,res:1080,acodec:m4a', '--merge-output-format', 'mp4']))
    expect(dl.args.join(' ')).not.toMatch(/cookies/)
  })
  it('converts a non-H.264 download with ffmpeg', async () => {
    probeJson = probe('vp9', 15)
    await fetchVideo({ url: 'https://www.facebook.com/reel/1' }, ctx)
    expect(execCalls.some((c) => c.file === 'ffmpeg' && c.args.includes('libx264'))).toBe(true)
  })
  it('keeps the YouTube URL for Gemini', async () => {
    const v = await fetchVideo({ url: 'https://www.youtube.com/watch?v=abc' }, ctx)
    expect(v.youtubeUrl).toBe('https://www.youtube.com/watch?v=abc')
  })
  it('keeps the song name and artist from platform metadata', async () => {
    const v = await fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    expect(v.song).toEqual({ name: 'As It Was', artist: 'Harry Styles' })
  })
  it('flags videos over 90s as tooLong', async () => {
    probeJson = probe('h264', 178)
    const v = await fetchVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(v.tooLong).toBe(true)
  })
  it('turns an Instagram "not granting access" failure into a FetchRefused asking for an upload', async () => {
    ytdlpFails = 'ERROR: [Instagram] x: Instagram API is not granting access'
    await expect(fetchVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)).rejects.toThrow(/upload/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/fetchVideo.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `fetchVideo.ts`**

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { MEDIA_DIR } from '../../../types.js'
import { uploadGeneratedFile } from '../../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from '../mediaCache.js'

const execFile = promisify(execFileCb)
const MAX_SOURCE_BYTES = 300 * 1024 * 1024
export const MAX_FULL_BREAKDOWN_S = 90

export class FetchRefused extends Error {}

export function classifyLink(url: string): 'youtube' | 'instagram' | 'x' | 'facebook' | 'linkedin' | 'tiktok' | 'other' {
  const h = (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } })()
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return 'youtube'
  if (/(^|\.)instagram\.com$/.test(h)) return 'instagram'
  if (/^(x|twitter)\.com$/.test(h)) return 'x'
  if (/(^|\.)facebook\.com$|^fb\.watch$/.test(h)) return 'facebook'
  if (/(^|\.)linkedin\.com$|^lnkd\.in$/.test(h)) return 'linkedin'
  if (/(^|\.)tiktok\.com$/.test(h)) return 'tiktok'
  return 'other'
}

export interface FetchedVideo { fileId: string; filePath: string; durationS: number; width: number; height: number; fps: number; hasAudio: boolean; caption: string | null; song: { name: string; artist: string | null } | null; youtubeUrl: string | null; platform: string; tooLong: boolean }

async function probe(filePath: string) {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', filePath], { timeout: 30_000 })
  const p = JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }> }
  const v = p.streams.find((s) => s.codec_type === 'video')
  if (!v) throw new FetchRefused('That link has no video in it.')
  const [n, d] = (v.r_frame_rate ?? '30/1').split('/').map(Number)
  return { durationS: Math.round(parseFloat(p.format.duration) * 100) / 100, width: v.width ?? 0, height: v.height ?? 0, fps: d ? n / d : 30, codec: v.codec_name ?? '', hasAudio: p.streams.some((s) => s.codec_type === 'audio') }
}

export async function fetchVideo(input: { url?: string; fileId?: string }, ctx: { idToken: string; scopeId: string; conversationId: string }): Promise<FetchedVideo> {
  let filePath: string
  let caption: string | null = null
  let song: FetchedVideo['song'] = null
  let platform = 'upload'
  let youtubeUrl: string | null = null
  let fileId = input.fileId ?? ''
  if (input.url) {
    platform = classifyLink(input.url)
    if (platform === 'tiktok') throw new FetchRefused('TikTok links can’t be opened from our servers in India. Please download the video from TikTok and attach it here.')
    if (platform === 'youtube') youtubeUrl = input.url
    filePath = join(MEDIA_DIR, `${ctx.scopeId}-link-${createHash('sha256').update(input.url).digest('hex').slice(0, 16)}.mp4`)
    if (!existsSync(filePath)) {
      try {
        // Logged-out only (spec §11): never add cookies or an account here.
        await execFile('yt-dlp', ['-q', '--no-warnings', '--no-playlist', '-S', 'vcodec:h264,res:1080,acodec:m4a', '--merge-output-format', 'mp4', '-o', filePath, input.url], { timeout: 240_000 })
      } catch (err) {
        const msg = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message}`
        throw new FetchRefused(/not granting access|login|private|cookies/i.test(msg)
          ? 'That post can’t be opened without logging in. Please download the video and attach it here.'
          : 'I couldn’t download that link. Please download the video and attach it here.')
      }
    }
    try {
      const { stdout } = await execFile('yt-dlp', ['-q', '--no-warnings', '--skip-download', '--print', '%(uploader)s | %(title)s', '--print', '%(track)s\t%(artist)s', input.url], { timeout: 60_000 })
      const [captionLine = '', songLine = ''] = stdout.split('\n')
      caption = captionLine.trim().slice(0, 500) || null
      const [track, artist] = songLine.split('\t').map((x) => x.trim())
      // Song facts only from the platform's own metadata — never guessed (spec §9a).
      song = track && track !== 'NA' ? { name: track, artist: artist && artist !== 'NA' ? artist : null } : null
    } catch { caption = null }
  } else if (input.fileId) {
    const url = await fetchPresignedUrl(input.fileId, ctx.idToken)
    filePath = (await downloadToSessionCache(ctx.scopeId, input.fileId, url, MAX_SOURCE_BYTES)).filePath
  } else {
    throw new FetchRefused('Send a video link or attach a video.')
  }
  let meta = await probe(filePath)
  if (meta.codec !== 'h264') {
    const conv = filePath.replace(/\.mp4$/, '') + '.h264.mp4'
    if (!existsSync(conv)) await execFile('ffmpeg', ['-v', 'error', '-y', '-i', filePath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', conv], { timeout: 300_000 })
    filePath = conv
    meta = await probe(filePath)
  }
  if (input.url) {
    const saved = await uploadGeneratedFile(ctx.idToken, { conversationId: ctx.conversationId, title: `Reference video (${platform})`, content: readFileSync(filePath), contentType: 'video/mp4', extension: 'mp4' })
    if (!saved) throw new Error('could not save the reference video')
    fileId = saved.fileId
  }
  return { fileId, filePath, durationS: meta.durationS, width: meta.width, height: meta.height, fps: meta.fps, hasAudio: meta.hasAudio, caption, song, youtubeUrl, platform, tooLong: meta.durationS > MAX_FULL_BREAKDOWN_S }
}

export const fetchVideoTool = createTool({
  id: 'fetch_video',
  description: 'Get a reference video from a social link (YouTube, Instagram, X, Facebook, LinkedIn) or an attached file, ready for breaking down. Logged-out downloads only; TikTok needs an upload. Returns fileId, length, size, caption and tooLong (over 90s: ask the user which part to clone).',
  inputSchema: z.object({ url: z.string().url().optional(), fileId: z.string().optional() }),
  outputSchema: z.object({ success: z.boolean(), video: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const conversationId = (execContext?.requestContext?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    try {
      const video = await fetchVideo(input, { idToken, scopeId: tenantId ?? sessionId, conversationId })
      return { success: true, video }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/fetchVideo.test.ts && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoBreakdown/fetchVideo.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/fetchVideo.test.ts
git commit -m "feat(orchestrator): fetch_video tool (logged-out yt-dlp, H.264, TikTok refusal)"
```

---

### Task 4: `watch_video` tool

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/watchVideo.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/watchVideo.test.ts`

**Interfaces:**
- Consumes: `askGeminiVideo`, `parseModelJson`, `asObject` (Task 2); `FetchedVideo` (Task 3).
- Produces:
  - `WATCH_PROMPT: string`
  - `interface WatchOverview { format: string; layout: string; change_style: Array<'hard_cuts'|'hidden_changes'|'fades'|'near_still'>; looks: Array<{ label: string; approx_start_s: number; approx_end_s: number; outfit?: string; expression?: string; start_pose?: string; end_pose?: string; moves?: Array<{ t_s: number; limb: string; direction: string; how: string }>; leg_side?: string }>; subject_box: [number, number, number, number] | null; story: { setup: string; cause: string; payoff: string }; moments: Array<{ t_s: number; what: string; why_it_matters: string }>; setting: Record<string, string>; props: Array<{ prop: string; where: string; when: string }>; trick: string; sound: string; voice_lines: string | null; on_screen_text: string[]; keep_for_clone: string[]; swap_for_clone: string[]; never_copy: string[] }`
  - `normalizeOverview(v: Record<string, unknown>): WatchOverview` — fills defaults, clamps `subject_box` to 0..1, drops unknown `change_style` values.
  - `watchVideo(video: Pick<FetchedVideo,'filePath'|'youtubeUrl'|'durationS'>, tenantId?: string, fetchImpl?: typeof fetch): Promise<WatchOverview>`
  - tool id `watch_video`, input `{ fileId: string, url?: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { WATCH_PROMPT, normalizeOverview, watchVideo } from './watchVideo.js'

vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))

describe('WATCH_PROMPT', () => {
  it('asks for every field the remake needs', () => {
    for (const key of ['change_style', 'looks', 'start_pose', 'end_pose', 'moves', 'leg_side', 'subject_box', 'story', 'moments', 'setting', 'props', 'expression', 'never_copy', 'music', 'has_vocals', 'never guess']) {
      expect(WATCH_PROMPT).toContain(key)
    }
    expect(WATCH_PROMPT).toMatch(/image-left|image-right/)
  })
})

describe('normalizeOverview', () => {
  it('drops unknown change styles and clamps the subject box', () => {
    const o = normalizeOverview({ change_style: ['hard_cuts', 'teleport'], subject_box: [-0.2, 0.1, 1.4, 0.9] })
    expect(o.change_style).toEqual(['hard_cuts'])
    expect(o.subject_box).toEqual([0, 0.1, 1, 0.9])
    expect(o.looks).toEqual([])
    expect(o.never_copy).toEqual([])
    expect(o.music).toEqual({ mood: '', genre: '', instruments: '', has_vocals: null, song_name: null })
  })
})

describe('watchVideo', () => {
  it('returns a normalized overview from a bare-list reply', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"format":"fan wipe","change_style":["hidden_changes"],"looks":[{"label":"a","approx_start_s":0,"approx_end_s":5}]}]' } }], usage: {} })))
    const o = await watchVideo({ filePath: undefined as unknown as string, youtubeUrl: 'https://youtu.be/x', durationS: 15 }, undefined, fetchImpl)
    expect(o.format).toBe('fan wipe')
    expect(o.change_style).toEqual(['hidden_changes'])
    expect(o.looks).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/watchVideo.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `watchVideo.ts`**

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { askGeminiVideo, parseModelJson, asObject } from './geminiVideo.js'
import { fetchVideo, type FetchedVideo } from './fetchVideo.js'

export const WATCH_PROMPT = `Watch and listen to this whole video. Describe only what you actually see and hear. Times are rough; other tools measure exact times.
Use IMAGE directions (image-left / image-right as the viewer sees the frame).
Return ONLY JSON with these keys:
{"format": "one line naming the video format",
 "layout": "full frame | split screen | picture-in-picture | other",
 "change_style": ["hard_cuts" and/or "hidden_changes" (the scene/outfit changes while something covers the camera) and/or "fades" and/or "near_still"],
 "looks": [{"label": "short name of this distinct look/scene, in order", "approx_start_s": 0, "approx_end_s": 0,
   "outfit": "pieces, colours, fabric, details", "expression": "mouth, eyes, mood, and whether it changes",
   "start_pose": "pose when this look is first revealed", "end_pose": "pose at the end of this look",
   "moves": [{"t_s": 0, "limb": "arm/hand/legs/head/body", "direction": "image-left|image-right|up|down|toward camera", "how": "exact movement"}],
   "leg_side": "image-left|image-right|center (where the lower legs and feet end up)"}],
 "subject_box": [x0, y0, x1, y1] as 0-1 fractions where the main subject sits most of the time, or null,
 "story": {"setup": "how it opens", "cause": "what action drives the change", "payoff": "how it ends"},
 "moments": [{"t_s": 0, "what": "every meaningful action or event, including small ones inside a shot (a gesture, a prop used, a switch pressed, text appearing)", "why_it_matters": "its job in the story"}],
 "setting": {"floor": "", "rug": "", "furniture": "", "light": "", "framing": "how much of the frame the subject fills"},
 "props": [{"prop": "", "where": "", "when": "", "stays_in_place": true}],
 "trick": "the single mechanic that makes this video work, including what covers the camera and from where, if anything",
 "sound": "music / voice / sound effects summary", "voice_lines": "verbatim spoken words or null",
 "music": {"mood": "", "genre": "", "instruments": "", "has_vocals": true, "song_name": "ONLY if the song title is shown on screen or in the post caption; otherwise null — never guess"},
 "on_screen_text": ["exact text"],
 "keep_for_clone": [], "swap_for_clone": [], "never_copy": ["the exact music track, real faces, logos, verbatim script, anything else protected"]}`

const STYLES = new Set(['hard_cuts', 'hidden_changes', 'fades', 'near_still'])

export interface WatchOverview {
  format: string; layout: string; change_style: Array<'hard_cuts' | 'hidden_changes' | 'fades' | 'near_still'>
  looks: Array<{ label: string; approx_start_s: number; approx_end_s: number; outfit?: string; expression?: string; start_pose?: string; end_pose?: string; moves?: Array<{ t_s: number; limb: string; direction: string; how: string }>; leg_side?: string }>
  subject_box: [number, number, number, number] | null
  story: { setup: string; cause: string; payoff: string }
  moments: Array<{ t_s: number; what: string; why_it_matters: string }>
  setting: Record<string, string>
  props: Array<{ prop: string; where: string; when: string; stays_in_place?: boolean }>
  trick: string; sound: string; voice_lines: string | null; on_screen_text: string[]
  music: { mood: string; genre: string; instruments: string; has_vocals: boolean | null; song_name: string | null }
  keep_for_clone: string[]; swap_for_clone: string[]; never_copy: string[]
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0))

export function normalizeOverview(v: Record<string, unknown>): WatchOverview {
  const box = Array.isArray(v.subject_box) && v.subject_box.length === 4 ? (v.subject_box.map(clamp) as [number, number, number, number]) : null
  const story = (v.story && typeof v.story === 'object' ? v.story : {}) as Record<string, unknown>
  return {
    format: str(v.format), layout: str(v.layout) || 'full frame',
    change_style: arr<string>(v.change_style).filter((s) => STYLES.has(s)) as WatchOverview['change_style'],
    looks: arr<WatchOverview['looks'][number]>(v.looks).filter((l) => l && typeof l.approx_start_s === 'number'),
    subject_box: box,
    story: { setup: str(story.setup), cause: str(story.cause), payoff: str(story.payoff) },
    moments: arr(v.moments), setting: (v.setting && typeof v.setting === 'object' ? v.setting : {}) as Record<string, string>,
    props: arr(v.props), trick: str(v.trick), sound: str(v.sound),
    music: (() => { const m = (v.music && typeof v.music === 'object' ? v.music : {}) as Record<string, unknown>; return { mood: str(m.mood), genre: str(m.genre), instruments: str(m.instruments), has_vocals: typeof m.has_vocals === 'boolean' ? m.has_vocals : null, song_name: typeof m.song_name === 'string' && m.song_name ? m.song_name : null } })(),
    voice_lines: typeof v.voice_lines === 'string' ? v.voice_lines : null,
    on_screen_text: arr<string>(v.on_screen_text).filter((t) => typeof t === 'string'),
    keep_for_clone: arr(v.keep_for_clone), swap_for_clone: arr(v.swap_for_clone), never_copy: arr(v.never_copy),
  }
}

export async function watchVideo(video: Pick<FetchedVideo, 'filePath' | 'youtubeUrl' | 'durationS'>, tenantId?: string, fetchImpl?: typeof fetch): Promise<WatchOverview> {
  const { raw } = await askGeminiVideo({ video: video.youtubeUrl ? { youtubeUrl: video.youtubeUrl } : { filePath: video.filePath }, durationS: video.durationS, prompt: WATCH_PROMPT, tenantId, agentId: 'watch-video', fetchImpl })
  return normalizeOverview(asObject(parseModelJson(raw), 'looks'))
}

export const watchVideoTool = createTool({
  id: 'watch_video',
  description: 'Watch and listen to a whole video once and return its overview: format, how scenes change, each look (outfit, expression, start/end pose, moves, leg side), story, moments, setting, props, the trick, sound and on-screen text. Rough times only — exact times come from find_cuts / find_hidden_cuts / sound_timeline.',
  inputSchema: z.object({ fileId: z.string().optional(), url: z.string().url().optional() }),
  outputSchema: z.object({ success: z.boolean(), overview: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const conversationId = (execContext?.requestContext?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    try {
      const video = await fetchVideo(input, { idToken, scopeId: tenantId ?? sessionId, conversationId })
      if (video.tooLong) return { success: false, error: `The video is ${Math.round(video.durationS)}s long. Ask the user which part (up to 90s) to break down.` }
      return { success: true, overview: await watchVideo(video, tenantId) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/watchVideo.test.ts && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoBreakdown/watchVideo.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/watchVideo.test.ts
git commit -m "feat(orchestrator): watch_video tool — whole-video overview with looks, moves, story"
```

---

### Task 5: ai-service — authenticated media endpoints and `/sound`

**Files:**
- Create: `apps/ai-service/media/__init__.py`, `media/auth.py`, `media/paths.py`, `media/sound.py`, `media/router.py`
- Modify: `apps/ai-service/main.py` (include the router), `apps/ai-service/requirements.txt`
- Create: `apps/ai-service/tests/conftest.py`, `tests/test_sound.py`, `tests/test_auth_paths.py`

**Interfaces:**
- Produces HTTP (all `POST`, header `x-internal-service-key` must equal env `INTERNAL_SERVICE_KEY`, body `{"path": "<absolute path under MEDIA_DIR>"}` plus extras):
  - `/media/sound` → `{"curve_db": [..per 0.5s..], "events": [{"at_s", "change_db", "kind": "drop|jump"}], "rhythm": [{"from_s","to_s","every_s"}], "silent_from_s": float|null, "bpm": float|null, "beats_s": [float], "has_audio": bool}` — tempo and beats feed the phase-3 music options (spec §9a).
- Env `MEDIA_DIR` defaults to `~/.project-context/media/inbound` (same as the orchestrator's `MEDIA_DIR`).

- [ ] **Step 1: Write the failing tests**

`tests/conftest.py`:
```python
import os, subprocess, pathlib, pytest
from fastapi.testclient import TestClient

@pytest.fixture()
def media_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("MEDIA_DIR", str(tmp_path))
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "k")
    return tmp_path

@pytest.fixture()
def client(media_dir):
    import importlib, main
    importlib.reload(main)
    return TestClient(main.app)

def ff(args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)
```

`tests/test_auth_paths.py`:
```python
def test_rejects_missing_key(client, media_dir):
    r = client.post("/media/sound", json={"path": str(media_dir / "a.mp4")})
    assert r.status_code == 401

def test_rejects_path_outside_media_dir(client):
    r = client.post("/media/sound", json={"path": "/etc/passwd"}, headers={"x-internal-service-key": "k"})
    assert r.status_code == 400

def test_rejects_traversal(client, media_dir):
    r = client.post("/media/sound", json={"path": str(media_dir / ".." / "x.mp4")}, headers={"x-internal-service-key": "k"})
    assert r.status_code == 400
```

`tests/test_sound.py`:
```python
from conftest import ff

def test_tone_then_silence(client, media_dir):
    p = media_dir / "tone.mp4"
    # 3s of tone then 2s of silence, with a black video track
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
        "-f", "lavfi", "-i", "color=black:s=160x120:d=5",
        "-filter_complex", "[1]atrim=0:2[s];[0][s]concat=n=2:v=0:a=1[a]", "-map", "2:v", "-map", "[a]", "-shortest", str(p)])
    r = client.post("/media/sound", json={"path": str(p)}, headers={"x-internal-service-key": "k"})
    assert r.status_code == 200
    d = r.json()
    assert d["silent_from_s"] == 3.0
    assert any(e["kind"] == "drop" and 2.5 <= e["at_s"] <= 3.5 for e in d["events"])

def test_tempo_of_a_120_bpm_click(client, media_dir):
    p = media_dir / "click.mp4"
    # 8s of a short 1 kHz blip every 0.5s = 120 BPM
    ff(["-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.03),sin(2*PI*1000*t),0)':s=44100:d=8",
        "-f", "lavfi", "-i", "color=black:s=160x120:d=8", "-map", "1:v", "-map", "0:a", "-shortest", str(p)])
    d = client.post("/media/sound", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert d["bpm"] is not None and abs(d["bpm"] - 120) < 6
    assert len(d["beats_s"]) >= 12

def test_no_audio_track(client, media_dir):
    p = media_dir / "mute.mp4"
    ff(["-f", "lavfi", "-i", "color=black:s=160x120:d=2", str(p)])
    d = client.post("/media/sound", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert d == {"curve_db": [], "events": [], "rhythm": [], "silent_from_s": None, "bpm": None, "beats_s": [], "has_audio": False}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/ai-service && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt pytest && python -m pytest tests -q`
Expected: FAIL (404 on `/media/sound`).

- [ ] **Step 3: Implement**

`requirements.txt` (append):
```
numpy==2.1.3
opencv-python-headless==4.10.0.84
torch==2.5.1
transnetv2-pytorch==1.0.5
ffmpeg-python==0.2.0
pytest==8.3.3
librosa==0.10.2.post1
```

`media/auth.py`:
```python
import os
from fastapi import Header, HTTPException

def require_internal_key(x_internal_service_key: str | None = Header(default=None)):
    expected = os.environ.get("INTERNAL_SERVICE_KEY")
    if not expected or x_internal_service_key != expected:
        raise HTTPException(status_code=401, detail="unauthorized")
```

`media/paths.py`:
```python
import os
from pathlib import Path
from fastapi import HTTPException

def media_dir() -> Path:
    return Path(os.environ.get("MEDIA_DIR", str(Path.home() / ".project-context" / "media" / "inbound"))).resolve()

def safe_media_path(raw: str) -> Path:
    p = Path(raw).resolve()
    root = media_dir()
    if root not in p.parents or not p.is_file():
        raise HTTPException(status_code=400, detail="path must be an existing file inside the media cache")
    return p
```

`media/sound.py`:
```python
import subprocess, json, tempfile, os

STEP = 0.5

def has_audio(path: str) -> bool:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", path], capture_output=True, text=True, check=True).stdout
    return bool(json.loads(out).get("streams"))

def loudness_curve(path: str) -> list[float]:
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as t:
        out = t.name
    try:
        sr = 44100
        subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-af",
                        f"asetnsamples={int(sr*STEP)},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file={out}",
                        "-f", "null", "-"], check=True, timeout=300)
        vals = []
        for line in open(out):
            if "RMS_level" in line:
                v = line.strip().split("=")[1]
                vals.append(-100.0 if v in ("-inf", "inf", "nan") else max(-100.0, float(v)))
        return vals
    finally:
        os.unlink(out)

def summarize(vals: list[float]) -> dict:
    events, rhythm = [], []
    for i in range(1, len(vals)):
        d = vals[i] - vals[i - 1]
        if abs(d) >= 8 and max(vals[i], vals[i - 1]) > -60:
            events.append({"at_s": round(i * STEP, 2), "change_db": round(d), "kind": "drop" if d < 0 else "jump"})
    # group alternating jump/drop events spaced by one step into a rhythm entry (e.g. a ticking clock)
    i = 0
    while i < len(events):
        j = i
        while j + 1 < len(events) and events[j + 1]["at_s"] - events[j]["at_s"] <= 2 * STEP and events[j + 1]["kind"] != events[j]["kind"]:
            j += 1
        if j - i >= 3:
            rhythm.append({"from_s": events[i]["at_s"], "to_s": events[j]["at_s"], "every_s": round((events[j]["at_s"] - events[i]["at_s"]) / (j - i), 2)})
            del events[i:j + 1]
        else:
            i += 1
    silent_from = None
    for k in range(len(vals)):
        if all(v < -55 for v in vals[k:]) and k < len(vals):
            silent_from = round(k * STEP, 2)
            break
    return {"curve_db": [round(v) for v in vals], "events": events, "rhythm": rhythm, "silent_from_s": silent_from, "has_audio": True}

def tempo_and_beats(path: str) -> tuple[float | None, list[float]]:
    import librosa
    y, sr = librosa.load(path, sr=22050, mono=True)
    if y.size == 0 or float(abs(y).max()) < 1e-4:
        return None, []
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
    beats = [round(float(t), 2) for t in librosa.frames_to_time(frames, sr=sr)]
    t = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
    return (round(t, 1) if beats else None), beats

def sound_timeline(path: str) -> dict:
    if not has_audio(path):
        return {"curve_db": [], "events": [], "rhythm": [], "silent_from_s": None, "bpm": None, "beats_s": [], "has_audio": False}
    out = summarize(loudness_curve(path))
    out["bpm"], out["beats_s"] = tempo_and_beats(path)
    return out
```

`media/router.py`:
```python
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from .auth import require_internal_key
from .paths import safe_media_path
from . import sound

router = APIRouter(prefix="/media", dependencies=[Depends(require_internal_key)])

class PathBody(BaseModel):
    path: str

@router.post("/sound")
def post_sound(body: PathBody):
    return sound.sound_timeline(str(safe_media_path(body.path)))
```

`main.py` — after the CORS middleware:
```python
from media.router import router as media_router
app.include_router(media_router)
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/ai-service && . .venv/bin/activate && pip install -r requirements.txt && python -m pytest tests -q`
Expected: 6 passed. (If the tone test's silence boundary lands at 3.0 ± 0.5, adjust only the assertion range, never the summarizer, and note it in the commit.)

- [ ] **Step 5: Commit**

```bash
git add apps/ai-service/media apps/ai-service/tests apps/ai-service/main.py apps/ai-service/requirements.txt
git commit -m "feat(ai-service): authenticated /media/sound loudness timeline"
```

---

### Task 6: ai-service — `/media/cuts` (TransNetV2)

**Files:**
- Create: `apps/ai-service/media/cuts.py`, `apps/ai-service/tests/test_cuts.py`
- Modify: `apps/ai-service/media/router.py`

**Interfaces:**
- Produces: `POST /media/cuts` `{path, threshold?: 0.5}` → `{"cuts": [seconds], "fades": [[from_s, to_s]], "duration_s": float}`

- [ ] **Step 1: Write the failing test**

```python
from conftest import ff

def test_finds_hard_cuts_and_not_noise(client, media_dir):
    p = media_dir / "cuts.mp4"
    # three solid-colour shots of 2s each: cuts at 2.0 and 4.0
    ff(["-f", "lavfi", "-i", "color=red:s=320x240:d=2:r=25", "-f", "lavfi", "-i", "color=blue:s=320x240:d=2:r=25",
        "-f", "lavfi", "-i", "testsrc=s=320x240:d=2:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    d = client.post("/media/cuts", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert len(d["cuts"]) == 2
    assert abs(d["cuts"][0] - 2.0) < 0.1 and abs(d["cuts"][1] - 4.0) < 0.1
    assert abs(d["duration_s"] - 6.0) < 0.1
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests/test_cuts.py -q`
Expected: FAIL (404).

- [ ] **Step 3: Implement `media/cuts.py`**

```python
import os, subprocess
import numpy as np

_MODEL = None

def _model():
    global _MODEL
    if _MODEL is None:
        import torch, transnetv2_pytorch as T
        from transnetv2_pytorch import TransNetV2
        m = TransNetV2(device="cpu")
        m.load_state_dict(torch.load(os.path.join(os.path.dirname(T.__file__), "transnetv2-pytorch-weights.pth"), map_location="cpu"))
        m.eval()
        _MODEL = m
    return _MODEL

def _fps(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip()
    n, d = out.split("/")
    return float(n) / float(d)

def find_cuts(path: str, threshold: float = 0.5) -> dict:
    import torch
    m = _model()
    with torch.no_grad():
        _, single, allp = m.predict_video(path, quiet=True)
    single = np.asarray(single).ravel()
    allp = np.asarray(allp).ravel()
    fps = _fps(path)
    scenes = m.predictions_to_scenes(single, threshold=threshold)
    cuts = [round(float(s[0]) / fps, 2) for s in scenes[1:]]
    fades, i, on = [], 0, allp > 0.3
    while i < len(on):
        if on[i]:
            j = i
            while j < len(on) and on[j]:
                j += 1
            if j - i >= 4:  # multi-frame span = gradual transition
                fades.append([round(i / fps, 2), round((j - 1) / fps, 2)])
            i = j
        else:
            i += 1
    return {"cuts": cuts, "fades": fades, "duration_s": round(len(single) / fps, 2)}
```

`router.py` — add:
```python
from . import cuts

class CutsBody(PathBody):
    threshold: float = 0.5

@router.post("/cuts")
def post_cuts(body: CutsBody):
    return cuts.find_cuts(str(safe_media_path(body.path)), body.threshold)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests -q`
Expected: all pass (first run downloads nothing — weights ship in the wheel; it takes ~10s on CPU).

- [ ] **Step 5: Commit**

```bash
git add apps/ai-service/media/cuts.py apps/ai-service/media/router.py apps/ai-service/tests/test_cuts.py
git commit -m "feat(ai-service): /media/cuts with TransNetV2 (hard cuts + fade spans)"
```

---

### Task 7: ai-service — `/media/hidden-cuts` (look matching)

**Files:**
- Create: `apps/ai-service/media/hidden_cuts.py`, `apps/ai-service/tests/test_hidden_cuts.py`
- Modify: `apps/ai-service/media/router.py`

**Interfaces:**
- Produces: `POST /media/hidden-cuts` `{path, looks: [{label, approx_start_s, approx_end_s}], subject_box?: [x0,y0,x1,y1]}` → `{"hidden_cuts": [{"from": label, "to": label, "at_s": float, "covered_s": [a, b]}], "cover_threshold": float}`.
- Rule: a look must be seen for ≥ 0.3s continuously before a switch to it counts (fixes the 4.58s false switch seen in the spike).

- [ ] **Step 1: Write the failing test**

```python
from conftest import ff

def test_finds_change_behind_a_cover(client, media_dir):
    p = media_dir / "hidden.mp4"
    # look A (red) 0-2.4s, covered (black) 2.4-2.8s, look B (green) 2.8-5s. No hard cut between A and B.
    ff(["-f", "lavfi", "-i", "color=red:s=180x320:d=2.4:r=25", "-f", "lavfi", "-i", "color=black:s=180x320:d=0.4:r=25",
        "-f", "lavfi", "-i", "color=green:s=180x320:d=2.2:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "looks": [{"label": "red", "approx_start_s": 0, "approx_end_s": 2.2}, {"label": "green", "approx_start_s": 3.0, "approx_end_s": 5.0}]}
    d = client.post("/media/hidden-cuts", json=body, headers={"x-internal-service-key": "k"}).json()
    assert len(d["hidden_cuts"]) == 1
    h = d["hidden_cuts"][0]
    assert h["from"] == "red" and h["to"] == "green"
    assert abs(h["at_s"] - 2.6) < 0.15

def test_ignores_a_one_frame_flash_of_another_look(client, media_dir):
    p = media_dir / "flash.mp4"
    ff(["-f", "lavfi", "-i", "color=red:s=180x320:d=2:r=25", "-f", "lavfi", "-i", "color=green:s=180x320:d=0.08:r=25",
        "-f", "lavfi", "-i", "color=red:s=180x320:d=2:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "looks": [{"label": "red", "approx_start_s": 0, "approx_end_s": 1.5}, {"label": "green", "approx_start_s": 2.0, "approx_end_s": 2.05}]}
    d = client.post("/media/hidden-cuts", json=body, headers={"x-internal-service-key": "k"}).json()
    assert d["hidden_cuts"] == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests/test_hidden_cuts.py -q`
Expected: FAIL (404).

- [ ] **Step 3: Implement `media/hidden_cuts.py`**

```python
import cv2
import numpy as np

MIN_STABLE_S = 0.3

def _feat(img, box):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = box
    c = img[int(h * y0):max(int(h * y1), int(h * y0) + 8), int(w * x0):max(int(w * x1), int(w * x0) + 8)]
    hist = cv2.calcHist([cv2.cvtColor(c, cv2.COLOR_BGR2HSV)], [0, 1], None, [30, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist

def find_hidden_cuts(path: str, looks: list[dict], subject_box=None) -> dict:
    if len(looks) < 2:
        return {"hidden_cuts": [], "cover_threshold": None}
    box = subject_box or [0.1, 0.1, 0.9, 0.9]
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    feats = []
    while True:
        ok, img = cap.read()
        if not ok:
            break
        feats.append(_feat(img, box))
    if not feats:
        raise ValueError("no frames")
    refs = [feats[min(len(feats) - 1, int((l["approx_start_s"] + l["approx_end_s"]) / 2 * fps))] for l in looks]
    sim = np.array([[cv2.compareHist(f, r, cv2.HISTCMP_CORREL) for r in refs] for f in feats])
    top, best = sim.max(1), sim.argmax(1)
    cover = min(0.6, float(np.median(top)) * 0.75)
    lab = np.where(top >= cover, best, -1)
    # keep only runs of a look that last at least MIN_STABLE_S
    min_run = max(1, int(round(MIN_STABLE_S * fps)))
    i = 0
    while i < len(lab):
        if lab[i] < 0:
            i += 1
            continue
        j = i
        while j < len(lab) and lab[j] == lab[i]:
            j += 1
        if j - i < min_run:
            lab[i:j] = -1
        i = j
    switches, prev, prev_i = [], None, 0
    for i, l in enumerate(lab):
        if l < 0:
            continue
        if prev is not None and l != prev:
            switches.append({"from": looks[prev]["label"], "to": looks[l]["label"], "at_s": round((prev_i + i) / 2 / fps, 2), "covered_s": [round(prev_i / fps, 2), round(i / fps, 2)]})
        prev, prev_i = l, i
    return {"hidden_cuts": switches, "cover_threshold": round(cover, 2)}
```

`router.py` — add:
```python
from typing import Optional
from . import hidden_cuts

class Look(BaseModel):
    label: str
    approx_start_s: float
    approx_end_s: float

class HiddenBody(PathBody):
    looks: list[Look]
    subject_box: Optional[list[float]] = None

@router.post("/hidden-cuts")
def post_hidden(body: HiddenBody):
    return hidden_cuts.find_hidden_cuts(str(safe_media_path(body.path)), [l.model_dump() for l in body.looks], body.subject_box)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/ai-service && . .venv/bin/activate && python -m pytest tests -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ai-service/media/hidden_cuts.py apps/ai-service/media/router.py apps/ai-service/tests/test_hidden_cuts.py
git commit -m "feat(ai-service): /media/hidden-cuts — look changes behind a cover, with a stable-run rule"
```

---

### Task 8: Orchestrator measuring tools (`find_cuts`, `find_hidden_cuts`, `sound_timeline`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/aiServiceClient.ts`, `measureTools.ts`, `measureTools.test.ts`

**Interfaces:**
- Consumes: `fetchVideo` (Task 3), the Task 5–7 endpoints.
- Produces:
  - `aiService<T>(route: '/media/cuts' | '/media/hidden-cuts' | '/media/sound', body: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<T>` — base URL env `AI_SERVICE_URL` (default `http://localhost:3004`), header `x-internal-service-key`, timeout 300s; throws `Error('ai-service <status>')`.
  - `interface CutsResult { cuts: number[]; fades: Array<[number, number]>; duration_s: number }`
  - `interface HiddenCutsResult { hidden_cuts: Array<{ from: string; to: string; at_s: number; covered_s: [number, number] }>; cover_threshold: number | null }`
  - `interface SoundResult { curve_db: number[]; events: Array<{ at_s: number; change_db: number; kind: 'drop' | 'jump' }>; rhythm: Array<{ from_s: number; to_s: number; every_s: number }>; silent_from_s: number | null; bpm: number | null; beats_s: number[]; has_audio: boolean }`
  - tools `find_cuts`, `find_hidden_cuts`, `sound_timeline`, each `{ success, result?, error? }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { aiService } from './aiServiceClient.js'

describe('aiService', () => {
  it('posts JSON with the internal key to AI_SERVICE_URL', async () => {
    process.env.AI_SERVICE_URL = 'http://ai:3004'
    process.env.INTERNAL_SERVICE_KEY = 'k'
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ cuts: [1.2], fades: [], duration_s: 5 })))
    const r = await aiService<{ cuts: number[] }>('/media/cuts', { path: '/m/a.mp4' }, fetchImpl)
    expect(r.cuts).toEqual([1.2])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://ai:3004/media/cuts')
    expect((init.headers as Record<string, string>)['x-internal-service-key']).toBe('k')
  })
  it('throws with the status on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }))
    await expect(aiService('/media/sound', { path: '/x' }, fetchImpl)).rejects.toThrow('ai-service 400')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/measureTools.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`aiServiceClient.ts`:
```ts
export async function aiService<T>(route: '/media/cuts' | '/media/hidden-cuts' | '/media/sound', body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const base = process.env.AI_SERVICE_URL ?? 'http://localhost:3004'
  const res = await fetchImpl(`${base}${route}`, {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`ai-service ${res.status}`)
  return await res.json() as T
}

export interface CutsResult { cuts: number[]; fades: Array<[number, number]>; duration_s: number }
export interface HiddenCutsResult { hidden_cuts: Array<{ from: string; to: string; at_s: number; covered_s: [number, number] }>; cover_threshold: number | null }
export interface SoundResult { curve_db: number[]; events: Array<{ at_s: number; change_db: number; kind: 'drop' | 'jump' }>; rhythm: Array<{ from_s: number; to_s: number; every_s: number }>; silent_from_s: number | null; bpm: number | null; beats_s: number[]; has_audio: boolean }
```

`measureTools.ts`:
```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchVideo } from './fetchVideo.js'
import { aiService, type CutsResult, type HiddenCutsResult, type SoundResult } from './aiServiceClient.js'

type Ctx = { idToken: string; scopeId: string; conversationId: string }

function ctxOf(execContext: unknown): Ctx | null {
  const rc = (execContext as { requestContext?: { get(k: string): unknown } })?.requestContext
  const idToken = rc?.get('idToken') as string | undefined
  const tenantId = rc?.get('tenantId') as string | undefined
  const sessionId = rc?.get('sessionId') as string | undefined
  const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
  if (!idToken || !sessionId || !conversationId) return null
  return { idToken, scopeId: tenantId ?? sessionId, conversationId }
}

const wrap = async <T>(fn: () => Promise<T>) => {
  try { return { success: true, result: await fn() } } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
}
const out = z.object({ success: z.boolean(), result: z.any().optional(), error: z.string().optional() })
const src = z.object({ fileId: z.string().optional(), url: z.string().url().optional() })

export const findCutsTool = createTool({
  id: 'find_cuts',
  description: 'Free: exact hard-cut times and fade spans in a video (TransNetV2). Use these instead of times from watch_video.',
  inputSchema: src, outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<CutsResult>('/media/cuts', { path: (await fetchVideo(input, ctx)).filePath }))
  },
})

export const findHiddenCutsTool = createTool({
  id: 'find_hidden_cuts',
  description: 'Free: exact times of look changes that happen behind something covering the camera (a fan blade, a hand, a door). Only use when watch_video says change_style includes hidden_changes. Needs the looks (with rough times) from watch_video.',
  inputSchema: src.extend({ looks: z.array(z.object({ label: z.string(), approx_start_s: z.number(), approx_end_s: z.number() })).min(2), subject_box: z.array(z.number()).length(4).optional() }),
  outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<HiddenCutsResult>('/media/hidden-cuts', { path: (await fetchVideo(input, ctx)).filePath, looks: input.looks, subject_box: input.subject_box }))
  },
})

export const soundTimelineTool = createTool({
  id: 'sound_timeline',
  description: 'Free: exact sound timing — loudness every 0.5s, big jumps and drops, rhythmic patterns, when it goes silent, and the music tempo (BPM) with beat times. Trust this over any model’s sound timing.',
  inputSchema: src, outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<SoundResult>('/media/sound', { path: (await fetchVideo(input, ctx)).filePath }))
  },
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/measureTools.test.ts && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoBreakdown/aiServiceClient.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/measureTools.ts apps/agent-orchestrator/src/mastra/tools/videoBreakdown/measureTools.test.ts
git commit -m "feat(orchestrator): find_cuts, find_hidden_cuts, sound_timeline tools via ai-service"
```

---

### Task 9: `describe_shots`, `check_short_shots` and the `break_down_video` composite

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/videoBreakdown/describeShots.ts`, `checkShortShots.ts`, `breakDownVideo.ts`, `breakDownVideo.test.ts`, `index.ts`

**Interfaces:**
- Consumes: Tasks 2–4, 8.
- Produces:
  - `mergeBounds(durationS: number, cuts: number[], hidden: number[], fadeStarts: number[]): number[]` — sorted `[0, ..., durationS]`; drops a hidden cut within 0.5s of a hard cut; drops any boundary closer than 0.15s to the previous one.
  - `interface Shot { n: number; start_s: number; end_s: number; size?: string; angle?: string; movement?: string; subject: string; action: string; sound?: string; on_screen_text?: string | null; story_role?: string; checker_fix?: { subject: string } }`
  - `fillMissingShots(bounds: number[], shots: Shot[]): Shot[]` — every segment present, missing ones as `{ subject: 'unclear', action: 'unclear' }`.
  - `describeShots(video, bounds, sound, tenantId?, fetchImpl?): Promise<{ shots: Shot[]; sound_arc: string }>`
  - `checkShortShots(video, shots, tenantId?, fetchImpl?): Promise<{ checked: number; status: 'ok' | 'unknown'; fixes: Array<{ n: number; subject: string }> }>` — model from env `SHOT_CHECK_MODEL` (default `openrouter/openai/gpt-6-sol`); on any failure returns `status: 'unknown'` and no fixes; only the SUBJECT is ever corrected.
  - `interface Breakdown { video: Omit<FetchedVideo,'filePath'>; overview: WatchOverview; measured: boolean; cuts: CutsResult | null; hidden_cuts: HiddenCutsResult['hidden_cuts']; sound: Omit<SoundResult,'curve_db'> | null; shots: Shot[]; sound_arc: string; short_shot_check: { checked: number; status: 'ok' | 'unknown' }; warnings: string[] }`
  - `breakDownVideo(input: { url?: string; fileId?: string }, ctx, tenantId?, deps?): Promise<Breakdown>`; tool id `break_down_video`.

- [ ] **Step 1: Write the failing tests** (`breakDownVideo.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mergeBounds, fillMissingShots, breakDownVideo } from './breakDownVideo.js'

const watch = vi.fn()
const ai = vi.fn()
const describeShots = vi.fn()
const checkShort = vi.fn()
vi.mock('./fetchVideo.js', () => ({ fetchVideo: vi.fn(async () => ({ fileId: 'f', filePath: '/m/a.mp4', durationS: 14.9, width: 720, height: 1280, fps: 30, hasAudio: true, caption: null, youtubeUrl: null, platform: 'instagram', tooLong: false })) }))
vi.mock('./watchVideo.js', () => ({ watchVideo: (...a: unknown[]) => watch(...a) }))
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
vi.mock('./describeShots.js', () => ({ describeShots: (...a: unknown[]) => describeShots(...a) }))
vi.mock('./checkShortShots.js', () => ({ checkShortShots: (...a: unknown[]) => checkShort(...a) }))

const ctx = { idToken: 't', scopeId: 's', conversationId: 'c' }
const overview = (styles: string[], looks = 4) => ({ change_style: styles, looks: Array.from({ length: looks }, (_, i) => ({ label: `l${i}`, approx_start_s: i * 3, approx_end_s: i * 3 + 2 })), subject_box: null })

beforeEach(() => {
  watch.mockReset(); ai.mockReset(); describeShots.mockReset(); checkShort.mockReset()
  describeShots.mockResolvedValue({ shots: [], sound_arc: '' })
  checkShort.mockResolvedValue({ checked: 0, status: 'ok', fixes: [] })
})

describe('mergeBounds', () => {
  it('merges cuts, hidden cuts and fade starts, dropping near-duplicates', () => {
    expect(mergeBounds(10, [2, 5], [5.3, 7], [9])).toEqual([0, 2, 5, 7, 9, 10])
    expect(mergeBounds(10, [2, 2.1], [], [])).toEqual([0, 2, 10])
  })
})

describe('fillMissingShots', () => {
  it('keeps every segment even when the model skipped some', () => {
    const shots = fillMissingShots([0, 1, 2, 3], [{ n: 2, start_s: 1, end_s: 2, subject: 'x', action: 'y' }])
    expect(shots.map((s) => s.n)).toEqual([1, 2, 3])
    expect(shots[0].subject).toBe('unclear')
  })
})

describe('breakDownVideo', () => {
  it('runs hidden-cut detection only when the overview says hidden_changes', async () => {
    watch.mockResolvedValue(overview(['hard_cuts'], 20))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [1, 2, 3], fades: [], duration_s: 14.9 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    await breakDownVideo({ url: 'https://www.facebook.com/reel/1' }, ctx)
    expect(ai.mock.calls.map((c) => c[0])).not.toContain('/media/hidden-cuts')
  })
  it('uses hidden cuts as shot bounds for a hidden-change video', async () => {
    watch.mockResolvedValue(overview(['hidden_changes']))
    ai.mockImplementation(async (route: string) => {
      if (route === '/media/cuts') return { cuts: [], fades: [], duration_s: 14.9 }
      if (route === '/media/hidden-cuts') return { hidden_cuts: [{ from: 'l0', to: 'l1', at_s: 5.43, covered_s: [4.5, 6.1] }], cover_threshold: 0.6 }
      return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
    })
    await breakDownVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    expect(describeShots.mock.calls[0][1]).toEqual([0, 5.43, 14.9])
  })
  it('still returns the overview, marked unmeasured, when ai-service is down', async () => {
    watch.mockResolvedValue(overview(['hard_cuts']))
    ai.mockRejectedValue(new Error('ai-service 502'))
    const b = await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(b.measured).toBe(false)
    expect(b.overview.change_style).toEqual(['hard_cuts'])
    expect(b.warnings.join(' ')).toMatch(/ai-service/)
  })
  it('a near-still video becomes one shot without calling describe_shots', async () => {
    watch.mockResolvedValue(overview(['near_still'], 1))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [], fades: [], duration_s: 19 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    const b = await breakDownVideo({ url: 'https://lnkd.in/p/x' }, ctx)
    expect(describeShots).not.toHaveBeenCalled()
    expect(b.shots).toHaveLength(1)
  })
})
```

Also add `checkShortShots.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('node:child_process', () => ({ execFile: (_f: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }) }))
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), readFileSync: vi.fn(() => Buffer.from('jpg')) }))
vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))
import { checkShortShots } from './checkShortShots.js'

const shots = [{ n: 1, start_s: 0, end_s: 0.5, subject: 'eye', action: 'twitches' }, { n: 2, start_s: 0.5, end_s: 3, subject: 'room', action: 'wide' }]
it('returns unknown, never ok, when the checker fails', async () => {
  const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }))
  const r = await checkShortShots({ filePath: '/m/a.mp4' }, shots, undefined, fetchImpl)
  expect(r.status).toBe('unknown')
  expect(r.fixes).toEqual([])
})
it('only checks shots under 1s and only corrects the subject', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"n":1,"ok":false,"subject":"woman with gum","action":"rests"}]' } }] })))
  const r = await checkShortShots({ filePath: '/m/a.mp4' }, shots, undefined, fetchImpl)
  expect(r.checked).toBe(1)
  expect(r.fixes).toEqual([{ n: 1, subject: 'woman with gum' }])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown/breakDownVideo.test.ts src/mastra/tools/videoBreakdown/checkShortShots.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`describeShots.ts`:
```ts
import { askGeminiVideo, parseModelJson, asObject } from './geminiVideo.js'
import type { FetchedVideo } from './fetchVideo.js'
import type { SoundResult } from './aiServiceClient.js'

export interface Shot { n: number; start_s: number; end_s: number; size?: string; angle?: string; movement?: string; subject: string; action: string; sound?: string; on_screen_text?: string | null; story_role?: string; checker_fix?: { subject: string } }

export async function describeShots(video: Pick<FetchedVideo, 'filePath' | 'youtubeUrl' | 'durationS'>, bounds: number[], sound: Pick<SoundResult, 'events' | 'rhythm'> | null, tenantId?: string, fetchImpl?: typeof fetch): Promise<{ shots: Shot[]; sound_arc: string }> {
  const list = bounds.slice(0, -1).map((b, i) => `${i + 1}. ${b.toFixed(2)}s - ${bounds[i + 1].toFixed(2)}s`).join('\n')
  const ev = sound ? [...sound.events.slice(0, 30).map((e) => `${e.kind} ${e.change_db}dB at ${e.at_s}s`), ...sound.rhythm.map((r) => `rhythm every ${r.every_s}s from ${r.from_s}s to ${r.to_s}s`)].join(', ') || 'none' : 'not measured'
  const prompt = `Exact shot boundaries (measured by tools — keep them, do not invent shots):
${list}
Measured loudness changes (exact — trust them over your own timing): ${ev}.
Describe EACH shot in order so it could be reshot for a different brand. Only what you see and hear in that window; write "unclear" if unsure; never invent brand or model names, numbers or times you cannot read. Use image-left/image-right for directions.
Return ONLY JSON: {"shots":[{"n":1,"start_s":0,"end_s":0,"size":"wide|medium|close-up|extreme close-up|insert|overhead","angle":"eye|high|low|top-down|dutch","movement":"static|push in|pull out|pan|tilt|track|handheld","subject":"","action":"","sound":"","on_screen_text":null,"story_role":"hook|setup|problem|build|climax|product|resolution|endcard"}],"sound_arc":""}`
  const { raw } = await askGeminiVideo({ video: video.youtubeUrl ? { youtubeUrl: video.youtubeUrl } : { filePath: video.filePath }, durationS: video.durationS, prompt, tenantId, agentId: 'describe-shots', fetchImpl })
  const o = asObject(parseModelJson(raw), 'shots')
  return { shots: Array.isArray(o.shots) ? (o.shots as Shot[]) : [], sound_arc: typeof o.sound_arc === 'string' ? o.sound_arc : '' }
}
```

`checkShortShots.ts`:
```ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseModelJson, asObject } from './geminiVideo.js'
import { persistCost } from '../../cost.js'
import type { Shot } from './describeShots.js'

const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MAX_LEN_S = 1.0

export async function checkShortShots(video: { filePath: string }, shots: Shot[], tenantId?: string, fetchImpl: typeof fetch = fetch): Promise<{ checked: number; status: 'ok' | 'unknown'; fixes: Array<{ n: number; subject: string }> }> {
  const short = shots.filter((s) => s.end_s - s.start_s < MAX_LEN_S && s.subject !== 'unclear')
  if (short.length === 0) return { checked: 0, status: 'ok', fixes: [] }
  const model = process.env.SHOT_CHECK_MODEL ?? 'openrouter/openai/gpt-6-sol'
  const dir = mkdtempSync(join(tmpdir(), 'shotcheck-'))
  try {
    const content: Array<Record<string, unknown>> = []
    for (const s of short) {
      const p = join(dir, `${s.n}.jpg`)
      await execFile('ffmpeg', ['-v', 'error', '-y', '-ss', String((s.start_s + s.end_s) / 2), '-i', video.filePath, '-frames:v', '1', '-vf', 'scale=480:-1', p], { timeout: 30_000 })
      content.push({ type: 'text', text: `Shot ${s.n} (${s.start_s}-${s.end_s}s): claimed subject "${s.subject}"` })
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(p).toString('base64')}` } })
    }
    content.push({ type: 'text', text: 'Each image is the middle frame of one short shot. Is the claimed SUBJECT (who/what is in the frame) right? Judge only the subject, not motion. Return ONLY JSON: [{"n":shot number,"ok":true|false,"subject":"corrected subject if wrong"}]' })
    const res = await fetchImpl(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(120_000), headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' }, body: JSON.stringify({ model, temperature: 0, max_tokens: 2000, messages: [{ role: 'user', content }] }) })
    if (!res.ok) return { checked: short.length, status: 'unknown', fixes: [] }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    if (tenantId && json.usage) persistCost({ tenantId, agentId: 'check-short-shots', workflowId: 'video-breakdown', model, inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 })
    const verdicts = asObject(parseModelJson(json.choices?.[0]?.message?.content ?? ''), 'verdicts').verdicts as Array<{ n: number; ok?: boolean; subject?: string }> | undefined
    if (!Array.isArray(verdicts)) return { checked: short.length, status: 'unknown', fixes: [] }
    const fixes = verdicts.filter((v) => v.ok === false && typeof v.subject === 'string' && v.subject).map((v) => ({ n: v.n, subject: v.subject as string }))
    return { checked: short.length, status: 'ok', fixes }
  } catch {
    return { checked: short.length, status: 'unknown', fixes: [] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
```

`breakDownVideo.ts`:
```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchVideo, type FetchedVideo } from './fetchVideo.js'
import { watchVideo, type WatchOverview } from './watchVideo.js'
import { aiService, type CutsResult, type HiddenCutsResult, type SoundResult } from './aiServiceClient.js'
import { describeShots, type Shot } from './describeShots.js'
import { checkShortShots } from './checkShortShots.js'

export interface Breakdown {
  video: Omit<FetchedVideo, 'filePath'>; overview: WatchOverview; measured: boolean
  cuts: CutsResult | null; hidden_cuts: HiddenCutsResult['hidden_cuts']; sound: Omit<SoundResult, 'curve_db'> | null
  shots: Shot[]; sound_arc: string; short_shot_check: { checked: number; status: 'ok' | 'unknown' }; warnings: string[]
}

export function mergeBounds(durationS: number, cuts: number[], hidden: number[], fadeStarts: number[]): number[] {
  const h = hidden.filter((x) => cuts.every((c) => Math.abs(x - c) > 0.5))
  const all = [...new Set([...cuts, ...h, ...fadeStarts])].filter((x) => x > 0 && x < durationS).sort((a, b) => a - b)
  const out = [0]
  for (const x of all) if (x - out[out.length - 1] >= 0.15) out.push(x)
  out.push(Math.round(durationS * 100) / 100)
  return out
}

export function fillMissingShots(bounds: number[], shots: Shot[]): Shot[] {
  const byN = new Map(shots.map((s) => [s.n, s]))
  return bounds.slice(0, -1).map((b, i) => byN.get(i + 1) ?? { n: i + 1, start_s: b, end_s: bounds[i + 1], subject: 'unclear', action: 'unclear' })
}

export async function breakDownVideo(input: { url?: string; fileId?: string }, ctx: { idToken: string; scopeId: string; conversationId: string }, tenantId?: string): Promise<Breakdown> {
  const video = await fetchVideo(input, ctx)
  if (video.tooLong) throw new Error(`The video is ${Math.round(video.durationS)}s long. Ask the user which part (up to 90s) to clone.`)
  const warnings: string[] = []
  const [overview, cuts, sound] = await Promise.all([
    watchVideo(video, tenantId),
    aiService<CutsResult>('/media/cuts', { path: video.filePath }).catch((e: Error) => { warnings.push(`cuts not measured (${e.message})`); return null }),
    aiService<SoundResult>('/media/sound', { path: video.filePath }).catch((e: Error) => { warnings.push(`sound not measured (${e.message})`); return null }),
  ])
  let hidden: HiddenCutsResult['hidden_cuts'] = []
  if (overview.change_style.includes('hidden_changes') && overview.looks.length > 1) {
    try {
      hidden = (await aiService<HiddenCutsResult>('/media/hidden-cuts', { path: video.filePath, looks: overview.looks.map((l) => ({ label: l.label, approx_start_s: l.approx_start_s, approx_end_s: l.approx_end_s })), subject_box: overview.subject_box ?? undefined })).hidden_cuts
    } catch (e) { warnings.push(`hidden cuts not measured (${(e as Error).message})`) }
  }
  const measured = cuts !== null && sound !== null
  const bounds = mergeBounds(video.durationS, cuts?.cuts ?? [], hidden.map((h) => h.at_s), (cuts?.fades ?? []).map((f) => f[0]))
  let shots: Shot[]
  let soundArc = ''
  if (overview.change_style.length === 1 && overview.change_style[0] === 'near_still' && bounds.length === 2) {
    shots = [{ n: 1, start_s: 0, end_s: video.durationS, subject: overview.format, action: 'near-still', story_role: 'endcard' }]
    soundArc = overview.sound
  } else {
    const d = await describeShots(video, bounds, sound, tenantId)
    shots = fillMissingShots(bounds, d.shots)
    soundArc = d.sound_arc
    if (shots.some((s) => s.subject === 'unclear')) warnings.push('some shots were skipped by the watcher and are marked unclear')
  }
  const check = await checkShortShots(video, shots, tenantId)
  for (const f of check.fixes) {
    const s = shots.find((x) => x.n === f.n)
    if (s) s.checker_fix = { subject: f.subject }
  }
  if (check.status === 'unknown') warnings.push('short-shot picture check unavailable')
  const { filePath: _fp, ...videoOut } = video
  const soundOut = sound ? (({ curve_db: _c, ...rest }) => rest)(sound) : null
  return { video: videoOut, overview, measured, cuts, hidden_cuts: hidden, sound: soundOut, shots, sound_arc: soundArc, short_shot_check: { checked: check.checked, status: check.status }, warnings }
}

export const breakDownVideoTool = createTool({
  id: 'break_down_video',
  description: 'Break down a reference video completely from a link or an attached file: format, story, moments, each look (outfit, expression, poses, moves, leg side), props, setting, the trick, exact cuts and hidden cuts, exact sound timing, and every shot. Use this first when the user wants to clone or recreate a video. Over 90s: ask which part.',
  inputSchema: z.object({ url: z.string().url().optional(), fileId: z.string().optional() }),
  outputSchema: z.object({ success: z.boolean(), breakdown: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const rc = execContext?.requestContext
    const idToken = rc?.get('idToken') as string | undefined
    const tenantId = rc?.get('tenantId') as string | undefined
    const sessionId = rc?.get('sessionId') as string | undefined
    const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    try {
      return { success: true, breakdown: await breakDownVideo(input, { idToken, scopeId: tenantId ?? sessionId, conversationId }, tenantId) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
```

`index.ts`:
```ts
export { fetchVideoTool } from './fetchVideo.js'
export { watchVideoTool } from './watchVideo.js'
export { findCutsTool, findHiddenCutsTool, soundTimelineTool } from './measureTools.js'
export { breakDownVideoTool } from './breakDownVideo.js'
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/videoBreakdown && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Verify the GPT checker model id (manual)**

Run: `curl -s localhost:4001/v1/chat/completions -H 'Content-Type: application/json' -H "x-internal-service-key: $INTERNAL_SERVICE_KEY" -d '{"model":"openrouter/openai/gpt-6-sol","max_tokens":5,"messages":[{"role":"user","content":"say ok"}]}' | head -c 300`
Expected: a reply containing "ok". If it errors, find the right id on openrouter.ai/models and set `SHOT_CHECK_MODEL` in `apps/agent-orchestrator/.env` and the VM env — the code default stays, the env wins. Record the working id in the commit message.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/videoBreakdown
git commit -m "feat(orchestrator): describe_shots, check_short_shots and break_down_video composite"
```

---

### Task 10: Wire into agents, replace `analyze_video` internals, append the skill step

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/directorAgent.ts:173` and `:194` (tool maps)
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts:197` (Olmo tool map)
- Modify: `apps/agent-orchestrator/src/mastra/tools/analyzeVideo.ts` (internals)
- Modify: `products/agent-platform/packages/api/seeds/official-skills/template-video.md` (append item 7)
- Modify: `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts` (assert the appended text)
- Test: `apps/agent-orchestrator/src/mastra/tools/analyzeVideo.test.ts` (create if absent), `apps/agent-orchestrator/src/mastra/agents/__tests__/directorAgent.test.ts`

**Interfaces:**
- Consumes: `index.ts` exports (Task 9), `askGeminiVideo` (Task 2).

- [ ] **Step 1: Write the failing tests**

In `directorAgent.test.ts` (follow the file's existing pattern for reading the tool map):
```ts
it('Director has the video breakdown tools', async () => {
  const tools = await getDirectorToolNames()   // use the helper the file already uses to list tool ids
  for (const t of ['fetch_video', 'watch_video', 'find_cuts', 'find_hidden_cuts', 'sound_timeline', 'break_down_video']) expect(tools).toContain(t)
})
```
In `analyzeVideo.test.ts`:
```ts
import { it, expect, vi } from 'vitest'
const ask = vi.fn(async () => ({ raw: 'A woman lies on a rug.', usage: { prompt_tokens: 1, completion_tokens: 1 } }))
vi.mock('./videoBreakdown/geminiVideo.js', () => ({ askGeminiVideo: (...a: unknown[]) => ask(...a) }))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async () => 'u'), downloadToSessionCache: vi.fn(async () => ({ filePath: '/m/a.mp4', buf: Buffer.from(''), mimeType: 'video/mp4' })) }))
vi.mock('node:child_process', () => ({ execFile: (_f: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '12.5\n', stderr: '' }) }))
import { analyzeVideoTool } from './analyzeVideo.js'

it('analyze_video sends the whole video (not frames) and keeps its output shape', async () => {
  const rc = new Map<string, string>([['idToken', 't'], ['sessionId', 's'], ['tenantId', 'tn']])
  const r = await (analyzeVideoTool as any).execute({ fileId: 'f', mode: 'deep' }, { requestContext: { get: (k: string) => rc.get(k) } })
  expect(r).toMatchObject({ success: true, summary: 'A woman lies on a rug.', durationSeconds: 12.5 })
  expect(ask.mock.calls[0][0]).toMatchObject({ video: { filePath: '/m/a.mp4' }, durationS: 12.5 })
})
```
In `officialSkillsSeed.test.ts`:
```ts
it('template-video skill tells Olmo to start with break_down_video', () => {
  const md = readFileSync(join(__dirname, '../seeds/official-skills/template-video.md'), 'utf8')
  expect(md).toContain('break_down_video')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm vitest run src/mastra/tools/analyzeVideo.test.ts src/mastra/agents/__tests__/directorAgent.test.ts && cd ../../products/agent-platform/packages/api && pnpm vitest run __tests__/officialSkillsSeed.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Agents: import from `../tools/videoBreakdown/index.js` and add to BOTH Director tool maps and Olmo's map:
```ts
fetch_video: fetchVideoTool, watch_video: watchVideoTool, find_cuts: findCutsTool, find_hidden_cuts: findHiddenCutsTool, sound_timeline: soundTimelineTool, break_down_video: breakDownVideoTool,
```

`analyzeVideo.ts` — replace the frame sampling + `callGatewayForFrames` path inside `execute` (keep the tool id, input and output schema unchanged) with:
```ts
const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 30_000 })
const durationSeconds = Math.round(parseFloat(stdout.trim()) * 100) / 100
const prompt = mode === 'quick'
  ? 'Watch and listen to this whole video. Give a brief 1-2 sentence summary of what happens.'
  : 'Watch and listen to this whole video. Describe it in detail — subjects, actions, sound, on-screen text and scene changes — with a rough timestamp range for every beat (e.g. "0.0s-3.2s: ...").'
const { raw } = await askGeminiVideo({ video: { filePath }, durationS: durationSeconds, prompt, tenantId, agentId: 'analyze-video', signal: controller.signal })
return { success: true, summary: raw, durationSeconds }
```
(import `execFile` via `promisify(execFileCb)` and `askGeminiVideo`; delete `callGatewayForFrames`, `extractVideoFrames` import and the frame constants; the outer try/catch and timeout handling stay.)

`template-video.md` — APPEND (do not edit earlier items):
```md

7. When the user shares a video link or attaches a video to clone (adds to steps 1 and 6): first call break_down_video with the link or fileId. Use its measured times (cuts, hidden_cuts, sound) over any times you or watch_video estimate. Read its overview.story, moments, looks (start_pose, end_pose, moves, leg_side), props and trick, and tell the user in two or three plain sentences what the video does and what makes it work. If it says the video is over 90 seconds, ask which part to clone before anything else. If fetch fails (TikTok, or a post that needs a login), pass on its message asking the user to attach the file.
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm vitest run && pnpm tsc --noEmit && cd ../../products/agent-platform/packages/api && pnpm vitest run __tests__/officialSkillsSeed.test.ts`
Expected: PASS (whole orchestrator suite green).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents apps/agent-orchestrator/src/mastra/tools/analyzeVideo.ts apps/agent-orchestrator/src/mastra/tools/analyzeVideo.test.ts products/agent-platform/packages/api/seeds/official-skills/template-video.md products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts
git commit -m "feat(orchestrator): register breakdown tools; analyze_video watches the whole video"
```

---

### Task 11: Real-video regression run and VM deploy notes

**Files:**
- Create: `apps/ai-service/tests/test_real_videos.py` (skipped unless `REAL_VIDEOS_DIR` is set)
- Create: `docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md`

**Interfaces:**
- Consumes: Tasks 5–7 endpoints.

- [ ] **Step 1: Write the regression test (expected values come from the spike)**

```python
import os, pytest
from pathlib import Path

REAL = os.environ.get("REAL_VIDEOS_DIR")
pytestmark = pytest.mark.skipif(not REAL, reason="set REAL_VIDEOS_DIR to the folder holding the spike videos")

def _copy(media_dir, name):
    src = Path(REAL) / name
    dst = media_dir / name
    dst.write_bytes(src.read_bytes())
    return str(dst)

def test_sony_ad_cuts(client, media_dir):
    d = client.post("/media/cuts", json={"path": _copy(media_dir, "sony.mp4")}, headers={"x-internal-service-key": "k"}).json()
    assert 28 <= len(d["cuts"]) <= 36                    # spike: 32 at threshold 0.5
    assert any(54.8 <= f[0] <= 55.8 for f in d["fades"])   # end-card fade ~55.3s

def test_fan_reel_hidden_cuts(client, media_dir):
    looks = [{"label": "jacket", "approx_start_s": 0.5, "approx_end_s": 4.0}, {"label": "saree", "approx_start_s": 6.2, "approx_end_s": 8.2},
             {"label": "sharara", "approx_start_s": 9.9, "approx_end_s": 11.8}, {"label": "cape", "approx_start_s": 13.2, "approx_end_s": 14.6}]
    d = client.post("/media/hidden-cuts", json={"path": _copy(media_dir, "fan_reel.mp4"), "looks": looks}, headers={"x-internal-service-key": "k"}).json()
    ats = [h["at_s"] for h in d["hidden_cuts"]]
    assert len(ats) == 3                                       # no false 4.58s switch
    for got, want in zip(ats, [5.4, 9.2, 12.7]):
        assert abs(got - want) < 0.4

def test_fan_reel_has_a_tempo(client, media_dir):
    d = client.post("/media/sound", json={"path": _copy(media_dir, "fan_reel.mp4")}, headers={"x-internal-service-key": "k"}).json()
    assert d["bpm"] is not None and 60 <= d["bpm"] <= 200

def test_sony_sound_drop(client, media_dir):
    d = client.post("/media/sound", json={"path": _copy(media_dir, "sony.mp4")}, headers={"x-internal-service-key": "k"}).json()
    assert d["silent_from_s"] is not None and 54 <= d["silent_from_s"] <= 58
```

- [ ] **Step 2: Run it against the spike videos**

```bash
mkdir -p /tmp/claude-501/real && S=/private/tmp/claude-501/-Users-suyash-Desktop-projects-01-products-project-context/e3a3d8a4-2e24-4634-a840-d85522838763/scratchpad/clone-spike
cp $S/source.mp4 /tmp/claude-501/real/sony.mp4 && cp $S/ig.mp4 /tmp/claude-501/real/fan_reel.mp4
cd apps/ai-service && . .venv/bin/activate && REAL_VIDEOS_DIR=/tmp/claude-501/real python -m pytest tests/test_real_videos.py -q
```
Expected: 4 passed. If the scratchpad copies are gone, re-download with `yt-dlp` (Sony: `https://www.youtube.com/watch?v=oYmU8Av_e84`; fan reel: `https://www.instagram.com/p/DdzH5VVgmYT/`).

- [ ] **Step 3: Write the deploy notes** (`…-phase1-DEPLOY.md`)

```md
# Phase 1 deploy (VM)

1. Gateway: deploy as usual (PM2 `inference-gateway` restart).
2. yt-dlp on the VM: `python3 -m pip install --user -U yt-dlp` and add a weekly cron `python3 -m pip install --user -U yt-dlp`. Check: `yt-dlp --version`.
3. ai-service:
   cd apps/ai-service && python3 -m venv .venv && . .venv/bin/activate
   pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 && pip install -r requirements.txt
   Env: INTERNAL_SERVICE_KEY (same value as Secrets Manager project-context/dev/internal-service-key), MEDIA_DIR=$HOME/.project-context/media/inbound
   pm2 start "/path/to/apps/ai-service/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 3004" --name ai-service
   Check: curl -s localhost:3004/health
4. Orchestrator env: AI_SERVICE_URL=http://127.0.0.1:3004, SHOT_CHECK_MODEL=<id verified in Task 9 Step 5>; then `pm2 restart` the orchestrator (deploy.sh does NOT restart it).
5. Seed the skill text (template-video.md) the same way as other Official skill updates.
6. Live test in chat: paste https://www.instagram.com/p/DdzH5VVgmYT/ and ask "break this down". Expect hidden cuts near 5.4 / 9.2 / 12.7s, the remote moment, and leg sides per look.
7. Test from the VM that YouTube and Instagram downloads are not blocked from the datacenter IP; if they are, note it — users then upload.
```

- [ ] **Step 4: Commit**

```bash
git add apps/ai-service/tests/test_real_videos.py docs/superpowers/plans/2026-10-14-social-video-clone-phase1-DEPLOY.md
git commit -m "test(ai-service): real-video regression for cuts, hidden cuts, sound; phase 1 deploy notes"
```

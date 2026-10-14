import { readFileSync, statSync } from 'node:fs'
import { ffmpegToFile } from './atomicFfmpeg.js'
import { persistCost } from '../../cost.js'

// Whole video plus audio to Gemini, never frames-as-images: about 11x cheaper
// and it hears the sound (spike 2026-10-11, spec §2).
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
  // Try the bracket that opens first: a bare list holds objects, so '{' alone would grab its first item.
  const shapes = ([['{', '}'], ['[', ']']] as const).slice().sort((x, y) => {
    const ix = s.indexOf(x[0]), iy = s.indexOf(y[0])
    return (ix < 0 ? Infinity : ix) - (iy < 0 ? Infinity : iy)
  })
  for (const [open, close] of shapes) {
    const a = s.indexOf(open), b = s.lastIndexOf(close)
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)) } catch { /* try the other shape */ }
    }
  }
  throw new Error('unreadable model reply')
}

// Models answer with a bare list or an object; callers read one shape.
export function asObject(v: unknown, listKey: string): Record<string, unknown> {
  if (Array.isArray(v)) {
    const first = v[0] as Record<string, unknown> | undefined
    // A one-item list wrapping the real object: it carries the list key itself, or nested data.
    if (v.length === 1 && first && typeof first === 'object' && !Array.isArray(first)
      && (listKey in first || Object.values(first).some((x) => x !== null && typeof x === 'object'))) {
      return first
    }
    return { [listKey]: v }
  }
  if (v && typeof v === 'object') return v as Record<string, unknown>
  throw new Error('unreadable model reply')
}

// The analysis copy keeps only what Gemini samples (its fps) at 480p with mono
// speech-grade audio, so minutes of video fit the inline limit (review I6), and
// it is written atomically so an aborted transcode is never reused (review I5).
export async function prepareAnalysisCopy(filePath: string, durationS: number, signal?: AbortSignal): Promise<string> {
  const out = `${filePath}.analysis.mp4`
  const fps = String(fpsForDuration(durationS))
  await ffmpegToFile(['-v', 'error', '-y', '-i', filePath, '-vf', 'scale=480:-2', '-r', fps, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-ac', '1', '-b:a', '48k'], out, { timeout: 180_000, signal })
  if (statSync(out).size > MAX_INLINE_BYTES) throw new Error('video too large to analyse inline; pick a shorter segment')
  return out
}

export async function askGeminiVideo(opts: {
  video: { filePath?: string; youtubeUrl?: string | null }
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
    const copy = await prepareAnalysisCopy(opts.video.filePath, opts.durationS, opts.signal)
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

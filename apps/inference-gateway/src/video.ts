import type { IncomingMessage, ServerResponse } from 'http'
import { geminiVideoBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const VIDEO_MODEL_ALLOWLIST = new Set(['gemini-omni-1.1-flash'])

export interface VideoGenerationRequest {
  model: string
  prompt: string
  task: 'text_to_video' | 'edit' | 'extend'
}

export type VideoGenerationResult =
  | { videoBase64: string; mimeType: string }
  | { refused: true; reason: string }

// Design note: unlike music.ts and images.ts, this adapter has no Vertex tier at
// all — an earlier draft of this task's brief assumed the Interactions API
// (gemini-omni-1.1-flash) was reachable on Vertex via service-account auth, but
// reading the bundled @google/genai SDK source directly showed the `interactions`
// resource only exists on the Gemini-API-key client (base URL
// generativelanguage.googleapis.com), not on the Vertex-auth client. The Vertex
// client instead exposes models.generateVideos(), a completely different
// predictLongRunning/fetchPredictOperation async job shape (Veo's pattern), which
// this feature does not use. So this file is API-key-only, mirroring
// images.ts's callGeminiApiKeyImageModel auth convention (?key=... query param)
// but hitting /v1beta/interactions instead of /v1beta/models/*:generateContent.
//
// Response shape derived from the @google/genai SDK source and the Interactions
// API's documented request/response format — NOT verified against a live
// response (no GEMINI_API_KEY available during implementation). Verify these
// field paths (steps[].content[].video.data / .mime_type) against a real
// response before this ships to production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyInteractionsVideoResponse(interactionResponse: any): VideoGenerationResult {
  const steps: unknown[] = interactionResponse?.steps ?? []
  if (steps.length === 0) return { refused: true, reason: 'NO_STEPS' }
  // Scan all steps' content blocks, not just steps[0] — the video block is not
  // guaranteed to land in the first step (e.g. a text step could precede it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoBlock = steps.flatMap((s: any) => s?.content ?? []).find((c: any) => c.type === 'video')
  if (!videoBlock?.video?.data) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
  return { videoBase64: videoBlock.video.data, mimeType: videoBlock.video.mime_type ?? 'video/mp4' }
}

async function callGeminiApiKeyVideoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  const key = process.env.GEMINI_API_KEY ?? ''
  const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      input: req.prompt,
      response_format: { type: 'video', resolution: '720p', delivery: 'base64' },
      generation_config: { video_config: { task: req.task } },
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Gemini API video generation failed: ${res.status} ${await res.text()}`)
  return classifyInteractionsVideoResponse(await res.json())
}

export class UnsupportedVideoModelError extends Error {}

// No fallback tier — gemini-omni-1.1-flash's Interactions API has no Vertex-auth
// equivalent (see header comment). A Gemini API-key failure or open circuit is a
// clean throw; there is nothing to fall back to.
export async function generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  if (!VIDEO_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedVideoModelError(`Unsupported video model: ${req.model}`)
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Video generation unavailable: no GEMINI_API_KEY configured')
  }
  if (!geminiVideoBreaker.isAvailable()) {
    throw new Error('Gemini video generation unavailable (circuit open)')
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

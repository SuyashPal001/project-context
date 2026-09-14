import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexVideoBreaker, geminiVideoBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const VIDEO_MODEL_ALLOWLIST = new Set(['gemini-omni-1.1-flash'])

const PROJECT  = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
const _auth    = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

// Veo 3 on Vertex AI — predictLongRunning + polling.
// Must stay strictly less than the 240s gateway timeout so we can complete or
// fail cleanly before the orchestrator's own AbortSignal fires.
const VEO_MODEL            = 'veo-2.0-generate-001'
const VERTEX_TIMEOUT_MS    = 200_000
const POLL_INTERVAL_MS     = 5_000

export interface VideoGenerationRequest {
  model: string
  prompt: string
  task: 'text_to_video' | 'edit' | 'extend'
}

export type VideoGenerationResult =
  | { videoBase64: string; mimeType: string }
  | { refused: true; reason: string }

// ---------------------------------------------------------------------------
// Gemini Interactions API path (gemini-omni-1.1-flash, API key auth)
// ---------------------------------------------------------------------------

// Response shape verified against a live response (Sep 2026):
// steps[].content[] = [{ type: 'video', data: '<base64>', mime_type: 'video/mp4' }]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyInteractionsVideoResponse(interactionResponse: any): VideoGenerationResult {
  const steps: unknown[] = interactionResponse?.steps ?? []
  if (steps.length === 0) return { refused: true, reason: 'NO_STEPS' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoBlock = steps.flatMap((s: any) => s?.content ?? []).find((c: any) => c.type === 'video')
  if (!videoBlock?.data) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
  return { videoBase64: videoBlock.data, mimeType: videoBlock.mime_type ?? 'video/mp4' }
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
      response_format: { type: 'video', resolution: '720p', delivery: 'inline' },
      generation_config: { video_config: { task: req.task } },
    }),
    signal: AbortSignal.timeout(240_000),
  })
  if (!res.ok) throw new Error(`Gemini API video generation failed: ${res.status} ${await res.text()}`)
  return classifyInteractionsVideoResponse(await res.json())
}

// ---------------------------------------------------------------------------
// Vertex AI Veo path (Veo 3, service account ADC auth)
// ---------------------------------------------------------------------------

async function getToken(): Promise<string> {
  const client = await _auth.getClient()
  const resp   = await client.getAccessToken()
  return resp.token ?? ''
}

async function downloadGcsVideo(uri: string): Promise<Buffer> {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/)
  if (!match) throw new Error(`unrecognised GCS URI: ${uri}`)
  const [, bucket, filePath] = match
  const token = await getToken()
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(filePath)}?alt=media`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`GCS download ${res.status}: ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

async function callVertexVeoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  const token    = await getToken()
  const startUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${VEO_MODEL}:predictLongRunning`

  const startRes = await fetch(startUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances:  [{ prompt: req.prompt }],
      parameters: { aspectRatio: '16:9', sampleCount: 1 },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!startRes.ok) throw new Error(`Veo predictLongRunning failed: ${startRes.status} ${await startRes.text()}`)

  const { name: operationName } = await startRes.json() as { name?: string }
  if (!operationName) throw new Error('Veo: no operation name in response')
  console.log(`[video] Veo operation started: ${operationName}`)

  const pollUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1/${operationName}`
  const deadline = Date.now() + VERTEX_TIMEOUT_MS

  while (Date.now() < deadline) {
    const freshToken = await getToken()
    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${freshToken}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!pollRes.ok) throw new Error(`Veo poll failed: ${pollRes.status} ${await pollRes.text()}`)

    const op = await pollRes.json() as {
      done?: boolean
      error?: { message?: string }
      response?: { videos?: Array<{ bytesBase64Encoded?: string; mimeType?: string; uri?: string }> }
    }

    if (op.done) {
      if (op.error) throw new Error(`Veo operation error: ${op.error.message}`)
      const video = op.response?.videos?.[0]
      if (!video) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
      const mimeType = video.mimeType ?? 'video/mp4'
      if (video.bytesBase64Encoded) {
        console.log('[video] Veo complete — inline base64')
        return { videoBase64: video.bytesBase64Encoded, mimeType }
      }
      if (video.uri) {
        console.log(`[video] Veo complete — downloading from GCS: ${video.uri}`)
        const buf = await downloadGcsVideo(video.uri)
        return { videoBase64: buf.toString('base64'), mimeType }
      }
      return { refused: true, reason: 'NO_VIDEO_CONTENT' }
    }

    const wait = Math.min(POLL_INTERVAL_MS, deadline - Date.now())
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
  }

  throw new Error('Veo video generation timed out')
}

// ---------------------------------------------------------------------------
// Unified generateVideo — Vertex Veo first, Gemini Interactions fallback
// ---------------------------------------------------------------------------

export class UnsupportedVideoModelError extends Error {}

export async function generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  if (!VIDEO_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedVideoModelError(`Unsupported video model: ${req.model}`)
  }

  let vertexFailureReason: string | null = null

  if (vertexVideoBreaker.isAvailable() && PROJECT) {
    try {
      const result = await callVertexVeoModel(req)
      vertexVideoBreaker.onSuccess()
      return result
    } catch (vertexErr) {
      vertexVideoBreaker.onFailure()
      vertexFailureReason = (vertexErr as Error).message
      console.warn('[video] Vertex Veo failed, trying Gemini API key fallback:', vertexFailureReason)
    }
  } else {
    vertexFailureReason = vertexVideoBreaker.isAvailable() ? 'no PROJECT configured' : 'circuit open'
    console.warn('[video] Vertex Veo skipped, trying Gemini API key fallback:', vertexFailureReason)
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(`Vertex Veo unavailable (${vertexFailureReason}) and no GEMINI_API_KEY fallback configured`)
  }
  if (!geminiVideoBreaker.isAvailable()) {
    throw new Error(`Vertex Veo unavailable (${vertexFailureReason}) and Gemini video circuit is open`)
  }

  try {
    const result = await callGeminiApiKeyVideoModel(req)
    geminiVideoBreaker.onSuccess()
    return result
  } catch (geminiErr) {
    geminiVideoBreaker.onFailure()
    throw new Error(`Vertex Veo failed (${vertexFailureReason}); Gemini API key fallback also failed (${(geminiErr as Error).message})`)
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

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

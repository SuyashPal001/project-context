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
  // 4xx errors (except 429) on the submit call are permanent refusals — a bad
  // video/audio URL or an unsupported format is caller error, not a
  // transient/vendor-side failure. Matches speech.ts's Cartesia mapping:
  // 429/5xx/network stay thrown so the adapter chain / caller can retry.
  if (!submitRes.ok && submitRes.status >= 400 && submitRes.status < 500 && submitRes.status !== 429) {
    const reason = await submitRes.text().catch(() => `HTTP ${submitRes.status}`)
    return { refused: true, reason: `fal.ai rejected: ${reason}` }
  }
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
  // Same 4xx-except-429 -> refused mapping as the fal.ai submit call above.
  if (!submitRes.ok && submitRes.status >= 400 && submitRes.status < 500 && submitRes.status !== 429) {
    const reason = await submitRes.text().catch(() => `HTTP ${submitRes.status}`)
    return { refused: true, reason: `Sync Labs rejected: ${reason}` }
  }
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
    // Refused results are still "success" from the gateway perspective — a valid
    // response that downstream can reason about. Only thrown errors count as failures.
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

import type { IncomingMessage, ServerResponse } from 'http'
import { requestsTotal, latency } from './metrics.js'

const LIPSYNC_MODEL_ALLOWLIST = new Set(['fal-ai/latentsync', 'sync-2.0'])

// Matches generateVideo.ts's in-turn blocking-timeout shape (270s), per the
// spec's explicit recommendation not to invent a new async pattern until the
// platform-wide async job layer exists. This runs inside a live SSE chat
// turn — there is no queue/watchdog bridge for this yet.
const POLL_TIMEOUT_MS = 270_000
const POLL_INTERVAL_MS = 5_000

// Ceiling for the downloaded result clip. Generous for a short (~30s)
// generated talking-head clip; scaled down from analyzeVideo.ts's
// MAX_VIDEO_BYTES (200MB, sized for arbitrary user uploads) since this is a
// bounded, short, vendor-generated output, not an arbitrary upload.
const MAX_RESULT_VIDEO_BYTES = 100 * 1024 * 1024

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

async function downloadResultVideo(url: string): Promise<LipsyncGenerationResult> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`lipsync result download failed: ${res.status}`)

  // Validate content-type and size before buffering — matches speech.ts's
  // pattern for its own downloaded-audio validation.
  const contentType = res.headers.get('content-type') ?? ''
  const contentLength = Number(res.headers.get('content-length') ?? 0)

  if (!contentType.startsWith('video/')) {
    return { refused: true, reason: `Unexpected content-type: ${contentType}` }
  }
  if (contentLength > MAX_RESULT_VIDEO_BYTES) {
    return { refused: true, reason: 'Video size exceeds limit' }
  }

  const buf = Buffer.from(await res.arrayBuffer())

  if (buf.byteLength > MAX_RESULT_VIDEO_BYTES) {
    return { refused: true, reason: 'Video size exceeds limit' }
  }

  return { videoBase64: buf.toString('base64'), mimeType: contentType }
}

// fal.ai's queue API: submit returns a request_id, poll a status endpoint
// until status is COMPLETED (or an error status). IMPORTANT: the status
// response itself does NOT carry the model output — it only carries
// {status, queue_position, logs, response_url}. Once COMPLETED, the actual
// result lives at response_url (or equivalently
// .../requests/{request_id} with no /status suffix), which must be fetched
// separately and THEN read for video.url. This shape is inferred from fal's
// documented queue-API pattern and has not been verified against a live
// key — needs one real smoke test with FAL_API_KEY set before Task 5
// depends on it in production.
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

  const statusUrl = `https://queue.fal.run/fal-ai/latentsync/requests/${requestId}/status`
  const fallbackResultUrl = `https://queue.fal.run/fal-ai/latentsync/requests/${requestId}`
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    const pollRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!pollRes.ok) throw new Error(`fal.ai lipsync poll failed: ${pollRes.status}`)
    const status = await pollRes.json() as { status?: string; response_url?: string; error?: string }
    if (status.status === 'COMPLETED') {
      const resultUrl = status.response_url ?? fallbackResultUrl
      const resultRes = await fetch(resultUrl, {
        headers: { Authorization: `Key ${key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!resultRes.ok) throw new Error(`fal.ai lipsync result fetch failed: ${resultRes.status}`)
      const result = await resultRes.json() as { video?: { url?: string } }
      if (!result.video?.url) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
      return downloadResultVideo(result.video.url)
    }
    if (status.status === 'FAILED' || status.error) {
      return { refused: true, reason: status.error ?? 'LIPSYNC_FAILED' }
    }
    // IN_QUEUE / IN_PROGRESS — keep polling
    const wait = Math.min(POLL_INTERVAL_MS, deadline - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  throw new LipsyncTimeoutError(`fal.ai lipsync job ${requestId} did not complete within ${POLL_TIMEOUT_MS}ms`)
}

// Sync Labs' v2 API (model name "sync-2.0" signals v2, not the legacy flat
// endpoint): POST https://api.sync.so/v2/generate with an `input` array of
// {type, url} entries, poll for status, result field outputUrl. Kept as a
// distinct function (not merged with the fal branch above) because the two
// vendors' actual field names differ even though the poll-loop shape is
// similar; a future third vendor is more likely to need its own function
// than to fit a forced-shared abstraction. This shape is inferred from Sync
// Labs' documented v2 API and has not been verified against a live key —
// needs one real smoke test with SYNC_LABS_API_KEY set before Task 5
// depends on it in production.
async function callSyncLabs(req: LipsyncGenerationRequest): Promise<LipsyncGenerationResult> {
  const key = process.env.SYNC_LABS_API_KEY ?? ''
  const submitRes = await fetch('https://api.sync.so/v2/generate', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'lipsync-2',
      input: [
        { type: 'video', url: req.videoUri },
        { type: 'audio', url: req.audioUri },
      ],
    }),
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

  const pollUrl = `https://api.sync.so/v2/generate/${jobId}`
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    const pollRes = await fetch(pollUrl, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(15_000),
    })
    if (!pollRes.ok) throw new Error(`Sync Labs poll failed: ${pollRes.status}`)
    const status = await pollRes.json() as { status?: string; outputUrl?: string; error?: string }
    if (status.status === 'COMPLETED') {
      if (!status.outputUrl) return { refused: true, reason: 'NO_VIDEO_CONTENT' }
      return downloadResultVideo(status.outputUrl)
    }
    if (status.status === 'FAILED' || status.error) {
      return { refused: true, reason: status.error ?? 'LIPSYNC_FAILED' }
    }
    const wait = Math.min(POLL_INTERVAL_MS, deadline - Date.now())
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
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

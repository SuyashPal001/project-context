import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexVideoBreaker, geminiVideoBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const VIDEO_MODEL_ALLOWLIST = new Set(['gemini-omni-1.1-flash'])

// Read at call time, not module load — the test suite sets these in
// beforeEach() so a captured-at-import constant would always be empty in tests
// regardless of setup, and callers configuring env at boot vs first-request
// see the same value either way.
const getProject  = () => process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
const _auth    = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

// Veo 3 on Vertex AI — predictLongRunning + polling.
// Must stay strictly less than the 240s gateway timeout so we can complete or
// fail cleanly before the orchestrator's own AbortSignal fires.
const VEO_MODEL            = 'veo-2.0-generate-001'
const VERTEX_TIMEOUT_MS    = 200_000
const POLL_INTERVAL_MS     = 5_000

const OMNI_MIN_DURATION_SECONDS = 3
const OMNI_MAX_DURATION_SECONDS = 10

function validateOmniDuration(durationSeconds: number): void {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < OMNI_MIN_DURATION_SECONDS ||
    durationSeconds > OMNI_MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `durationSeconds must be a whole number of seconds in ${OMNI_MIN_DURATION_SECONDS}..${OMNI_MAX_DURATION_SECONDS}, got ${durationSeconds}`,
    )
  }
}

const VEO_MIN_DURATION_SECONDS = 4
const VEO_MAX_DURATION_SECONDS = 8

// Veo 2 (veo-2.0-generate-001) has no duration parameter on predictLongRunning
// in this API version — it always renders its own default length. Validating
// here rejects an out-of-range request before spending a call, but does not
// yet control the actual output duration. Revisit once Veo exposes a real
// duration parameter, or drop this validation if Veo's fixed output length
// is confirmed acceptable for every caller.
function validateVeoDuration(durationSeconds: number): void {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < VEO_MIN_DURATION_SECONDS ||
    durationSeconds > VEO_MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `durationSeconds must be a whole number of seconds in ${VEO_MIN_DURATION_SECONDS}..${VEO_MAX_DURATION_SECONDS}, got ${durationSeconds}`,
    )
  }
}

export interface VideoGenerationRequest {
  model: string
  prompt: string
  task: 'text_to_video' | 'edit' | 'extend' | 'image_to_video'
  aspectRatio: '16:9' | '9:16'
  durationSeconds: number
  imageUri?: string
  imageMimeType?: string
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

// Gemini's API-key path (generativelanguage.googleapis.com) does not fetch
// arbitrary third-party HTTPS URLs for multimodal image input — confirmed by
// documented-behavior review in Task 4's spike (not yet live-verified; see
// apps/inference-gateway/scratch/image-conditioning-spike.md). Its only image
// input paths are inline base64 or a URI from Gemini's own Files API. This
// downloads the presigned source URL's bytes and re-uploads them to the
// Files API, mirroring Vertex Veo's own gs:// staging requirement.

// Narrow allowlist: whatever Gemini's caller passes as `mime_type` on the
// eventual generate call MUST match what we tell the Files API here, and
// Gemini only accepts these three for image input. Anything else canonicalises
// to jpeg — a wrong mimeType annotation on the image part previously caused
// Google to treat the whole multipart body as one JSON metadata blob and
// respond "Metadata part is too large".
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
function canonicalizeImageMime(mime: string | undefined): 'image/jpeg' | 'image/png' | 'image/webp' {
  const m = (mime ?? '').toLowerCase().split(';')[0].trim()
  if (m === 'image/jpg') return 'image/jpeg'
  return (ALLOWED_IMAGE_MIME.has(m) ? m : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp'
}
function canonicalFilename(mime: 'image/jpeg' | 'image/png' | 'image/webp'): 'ref.jpg' | 'ref.png' | 'ref.webp' {
  return mime === 'image/png' ? 'ref.png' : mime === 'image/webp' ? 'ref.webp' : 'ref.jpg'
}

async function stageImageForOmni(sourceUrl: string, mimeType: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY ?? ''
  const imageRes = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) })
  if (!imageRes.ok) throw new Error(`Failed to fetch source image for staging: ${imageRes.status}`)
  const imageBytes = await imageRes.arrayBuffer()

  const canonicalMime = canonicalizeImageMime(mimeType)
  const displayName = canonicalFilename(canonicalMime)
  const boundary = `boundary-${Date.now()}`
  const metadata = JSON.stringify({ file: { display_name: displayName } })
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${canonicalMime}\r\n\r\n`
  const bodyBuffer = Buffer.concat([
    Buffer.from(body, 'utf-8'),
    Buffer.from(imageBytes),
    Buffer.from(`\r\n--${boundary}--`, 'utf-8'),
  ])

  // `uploadType=multipart` is required — without it, the Files API doesn't
  // parse the multipart/related body and returns "Metadata part is too large"
  // as if the whole raw payload (image bytes and all) were a single metadata
  // JSON blob. Content-Type alone is not enough on this endpoint.
  const uploadRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: bodyBuffer,
    signal: AbortSignal.timeout(60_000),
  })
  if (!uploadRes.ok) throw new Error(`Gemini Files API upload failed: ${uploadRes.status} ${await uploadRes.text()}`)
  const uploadJson = await uploadRes.json() as { file: { uri: string } }
  return uploadJson.file.uri
}

async function callGeminiApiKeyVideoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  const key = process.env.GEMINI_API_KEY ?? ''
  const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${key}`
  const input = req.imageUri
    ? [
        { type: 'text', text: req.prompt },
        { type: 'image', uri: await stageImageForOmni(req.imageUri, req.imageMimeType ?? 'image/jpeg'), mime_type: req.imageMimeType ?? 'image/jpeg' },
      ]
    : req.prompt
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      input,
      response_format: {
        type: 'video',
        resolution: '720p',
        delivery: 'inline',
        aspect_ratio: req.aspectRatio,
        duration: `${req.durationSeconds}s`,
      },
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

// Not currently called from generateVideo() — selectBackend has only the
// Gemini Omni branch today. Kept implemented and tested so wiring in a real
// Vertex Veo branch later is a one-line change to selectBackend, not new code.
async function callVertexVeoModel(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  validateVeoDuration(req.durationSeconds)
  const token    = await getToken()
  const startUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${getProject()}/locations/${LOCATION}/publishers/google/models/${VEO_MODEL}:predictLongRunning`

  const startRes = await fetch(startUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances:  [{ prompt: req.prompt }],
      parameters: { aspectRatio: req.aspectRatio, sampleCount: 1 },
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
// selectBackend — capability-based routing. One real branch today
// (Gemini Omni Flash). Never falls back to a different vendor on failure or
// missing config — that is the cross-vendor substitution
// docs/media-generation/README.md forbids. A caller who needs Gemini and
// can't get it sees an error, not a Veo result it never asked for.
// ---------------------------------------------------------------------------

type VideoBackend = 'gemini-omni' | 'vertex-veo'

export class VideoBackendUnavailableError extends Error {}

function selectBackend(model: string): VideoBackend {
  if (model === 'gemini-omni-1.1-flash') return 'gemini-omni'
  throw new VideoBackendUnavailableError(`No backend registered for model: ${model}`)
}

export class UnsupportedVideoModelError extends Error {}

export async function generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
  if (!VIDEO_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedVideoModelError(`Unsupported video model: ${req.model}`)
  }
  validateOmniDuration(req.durationSeconds)

  const backend = selectBackend(req.model)

  if (backend === 'gemini-omni') {
    if (!process.env.GEMINI_API_KEY) {
      throw new VideoBackendUnavailableError('Gemini Omni unavailable: no GEMINI_API_KEY configured')
    }
    if (!geminiVideoBreaker.isAvailable()) {
      throw new VideoBackendUnavailableError('Gemini Omni unavailable: circuit open')
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

  // Unreachable today — selectBackend only ever returns 'gemini-omni' — kept
  // so adding a second real backend later is additive, not a rewrite of this
  // dispatch. See docs/superpowers/specs/2026-09-18-template-video-generation-design.md
  // Phase 0 for the planned shape of a second branch.
  throw new VideoBackendUnavailableError(`Backend not implemented: ${backend}`)
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

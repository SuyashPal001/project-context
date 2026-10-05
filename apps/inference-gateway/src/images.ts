import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexImageBreaker, geminiImageBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const IMAGE_MODEL_ALLOWLIST = new Set(['gemini-3-pro-image-preview', 'gpt-image-2'])

// Same fallback order index.ts:42 uses for embeddings — VERTEX_PROJECT first,
// GCLOUD_PROJECT second. images.ts previously used VERTEX_PROJECT only, which
// would silently 503 with a malformed URL on a VM where only GCLOUD_PROJECT is set.
const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
// See adapters/vertex.ts's API_HOST comment — 'global' has no region-prefixed host.
const API_HOST = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`

// gemini-3-pro-image's Vertex publisher model only resolves on the global
// endpoint, under its GA id with no "-preview" suffix — confirmed live against
// this project: us-central1 404s for both ids, global 404s for the -preview id,
// and only global + "gemini-3-pro-image" returns 200. This is independent of
// VERTEX_LOCATION (shared with video.ts/music.ts, which stay regional), the
// same reasoning vertex.ts's VERTEX_TEXT_LOCATION split used for chat models.
const VERTEX_IMAGE_HOST = 'aiplatform.googleapis.com'
const VERTEX_IMAGE_LOCATION = 'global'
const vertexImageModelId = (model: string) => model.replace(/-preview$/, '')
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

// Business/policy decision, not an engineering default — see spec §4.
// BLOCK_MEDIUM_AND_ABOVE chosen as a conservative starting point; revisit
// with whoever owns content policy before this ships broadly.
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
]

export interface ImageGenerationRequest {
  model: string
  prompt: string
  sourceImageBase64?: string
  sourceMimeType?: string
  // New: N identity/style-anchor reference images, pushed as additional
  // inline parts after any single sourceImageBase64. Capped at 3 by the
  // caller (generateImage.ts's Zod schema) — this gateway function itself
  // does not re-enforce a cap, it just forwards whatever array it's given.
  sourceImages?: Array<{ base64: string; mimeType: string }>
  // Optional output shape. Anything outside IMAGE_ASPECT_RATIOS is ignored (model default).
  aspectRatio?: string
  // Optional output resolution. Anything outside IMAGE_SIZES is ignored (model default, 1K).
  // 4K is left out on purpose: it costs more per image than 1K/2K, which bill the same.
  imageSize?: string
  // GPT Image only: 'medium' or 'high' (default high). Ignored for Gemini.
  quality?: string
}

export const IMAGE_ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9'])
export const IMAGE_SIZES = new Set(['1K', '2K'])

export type ImageGenerationResult =
  | { imageBase64: string; mimeType: string }
  | { refused: true; reason: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyGeminiImageResponse(geminiResponse: any): ImageGenerationResult {
  const candidate = geminiResponse?.candidates?.[0]
  if (!candidate) return { refused: true, reason: 'NO_CANDIDATES' }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    return { refused: true, reason: candidate.finishReason }
  }
  const parts: Array<{ inlineData?: { mimeType: string; data: string } }> = candidate.content?.parts ?? []
  const imagePart = parts.find(p => p.inlineData)
  if (!imagePart?.inlineData) return { refused: true, reason: 'NO_IMAGE_PART' }
  return { imageBase64: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType }
}

export function buildGeminiImageRequest(req: ImageGenerationRequest) {
  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }]
  if (req.sourceImageBase64 && req.sourceMimeType) {
    parts.push({ inlineData: { mimeType: req.sourceMimeType, data: req.sourceImageBase64 } })
  }
  for (const img of req.sourceImages ?? []) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } })
  }
  const imageConfig = {
    ...(req.aspectRatio && IMAGE_ASPECT_RATIOS.has(req.aspectRatio) ? { aspectRatio: req.aspectRatio } : {}),
    ...(req.imageSize && IMAGE_SIZES.has(req.imageSize) ? { imageSize: req.imageSize } : {}),
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    },
    safetySettings: SAFETY_SETTINGS,
  }
}

async function callVertexImageModel(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const url = `https://${VERTEX_IMAGE_HOST}/v1/projects/${PROJECT}/locations/${VERTEX_IMAGE_LOCATION}/publishers/google/models/${vertexImageModelId(req.model)}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiImageRequest(req)),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Vertex image generation failed: ${res.status} ${await res.text()}`)
  return classifyGeminiImageResponse(await res.json())
}

async function callGeminiApiKeyImageModel(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const key = process.env.GEMINI_API_KEY ?? ''
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiImageRequest(req)),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Gemini API image generation failed: ${res.status} ${await res.text()}`)
  return classifyGeminiImageResponse(await res.json())
}

// GPT Image 2, straight from OpenAI. Used for the avatar and character
// creators, where it beat Gemini on the look (2026-10). Any size works when
// both sides divide by 16 and the shape is between 1:3 and 3:1, so 9:16 is
// made directly (no padding). 2K is the same shape at 4/3 the pixels.
const GPT_IMAGE_SIZES: Record<string, [number, number]> = {
  '1:1': [1024, 1024], '3:4': [1152, 1536], '4:3': [1536, 1152], '9:16': [864, 1536], '16:9': [1536, 864],
}
export function gptImageSize(aspectRatio?: string, imageSize?: string): string {
  const [w, h] = GPT_IMAGE_SIZES[aspectRatio ?? ''] ?? GPT_IMAGE_SIZES['1:1']
  const k = imageSize === '2K' ? 4 / 3 : 1
  const r16 = (n: number) => Math.round(n * k / 16) * 16
  return `${r16(w)}x${r16(h)}`
}

async function callOpenAIImageModel(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const key = process.env.OPENAI_API_KEY ?? ''
  if (!key) throw new Error('GPT Image unavailable: no OPENAI_API_KEY configured')
  const size = gptImageSize(req.aspectRatio, req.imageSize)
  const quality = req.quality === 'medium' ? 'medium' : 'high'
  const refs = [
    ...(req.sourceImageBase64 && req.sourceMimeType ? [{ base64: req.sourceImageBase64, mimeType: req.sourceMimeType }] : []),
    ...(req.sourceImages ?? []),
  ]
  let res: Response
  if (refs.length) {
    // References go to the edits endpoint as image[] files; it composes a new
    // image from all of them and the prompt.
    const form = new FormData()
    form.append('model', req.model)
    form.append('prompt', req.prompt)
    form.append('size', size)
    form.append('quality', quality)
    refs.forEach((r, i) => {
      const ext = (r.mimeType.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'
      form.append('image[]', new Blob([Buffer.from(r.base64, 'base64')], { type: r.mimeType }), `ref${i}.${ext}`)
    })
    res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(240_000),
    })
  } else {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: req.model, prompt: req.prompt, size, quality, n: 1 }),
      signal: AbortSignal.timeout(240_000),
    })
  }
  return classifyOpenAIImageResponse(res.status, await res.json().catch(() => ({})))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyOpenAIImageResponse(status: number, body: any): ImageGenerationResult {
  if (status === 400 && /moderation|safety|content_policy/i.test(String(body?.error?.code ?? '') + String(body?.error?.message ?? ''))) {
    return { refused: true, reason: 'SAFETY' }
  }
  if (status < 200 || status >= 300) throw new Error(`OpenAI image generation failed: ${status} ${JSON.stringify(body?.error ?? body).slice(0, 300)}`)
  const b64 = body?.data?.[0]?.b64_json
  if (typeof b64 !== 'string') return { refused: true, reason: 'NO_IMAGE_PART' }
  // Token usage is logged so the per-call credit rate can be checked against the real bill.
  if (body.usage) console.log(`[images] gpt-image usage: ${JSON.stringify(body.usage)}`)
  return { imageBase64: b64, mimeType: `image/${body.output_format ?? 'png'}` }
}

// No Ollama tail here, unlike getAdapterChain's chat-completions chain
// (router.ts:49-58) — Ollama cannot generate images. If both breakers are
// open (or both calls fail), the caller gets a clean throw, handled by
// handleImageGenerations below as a 503.
export class UnsupportedImageModelError extends Error {}

export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  if (!IMAGE_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedImageModelError(`Unsupported image model: ${req.model}`)
  }
  if (req.model.startsWith('gpt-image')) return callOpenAIImageModel(req)

  // Vertex first, Gemini-API-key second — flipped 2026-10-02. The API-key
  // project's prepaid credits are depleted (402 RESOURCE_EXHAUSTED) with no
  // top-up scheduled, so Vertex (fixed the same day — see vertexImageModelId
  // above for the GA id + global location it needs) is the entry point now.
  // Swap back once the API key has credits again, if API-key-first ever
  // matters for latency.
  let vertexFailureReason: string | null = null

  if (vertexImageBreaker.isAvailable()) {
    try {
      const result = await callVertexImageModel(req)
      vertexImageBreaker.onSuccess()
      return result
    } catch (vertexErr) {
      vertexImageBreaker.onFailure()
      vertexFailureReason = (vertexErr as Error).message
      console.warn('[images] Vertex failed, trying Gemini API key fallback:', vertexFailureReason)
    }
  } else {
    vertexFailureReason = 'circuit open'
    console.warn('[images] Vertex skipped, trying Gemini API key fallback:', vertexFailureReason)
  }

  if (!process.env.GEMINI_API_KEY || !geminiImageBreaker.isAvailable()) {
    const reason = !process.env.GEMINI_API_KEY ? 'no GEMINI_API_KEY configured' : 'circuit open'
    throw new Error(`Vertex image generation unavailable (${vertexFailureReason}) and Gemini API key is unavailable (${reason})`)
  }

  try {
    const result = await callGeminiApiKeyImageModel(req)
    geminiImageBreaker.onSuccess()
    return result
  } catch (geminiErr) {
    geminiImageBreaker.onFailure()
    throw new Error(`Vertex image generation failed (${vertexFailureReason}); Gemini API key fallback also failed (${(geminiErr as Error).message})`)
  }
}

export async function handleImageGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: ImageGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await generateImage(payload)
    latency.observe({ adapter: 'image' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'image', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'image' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'image', status: 'failure' })
    if (err instanceof UnsupportedImageModelError) {
      console.warn('[images] rejected:', err.message)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[images] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}

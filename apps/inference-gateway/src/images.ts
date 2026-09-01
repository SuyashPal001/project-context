import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexImageBreaker, geminiImageBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const IMAGE_MODEL_ALLOWLIST = new Set(['gemini-3-pro-image-preview'])

// Same fallback order index.ts:42 uses for embeddings — VERTEX_PROJECT first,
// GCLOUD_PROJECT second. images.ts previously used VERTEX_PROJECT only, which
// would silently 503 with a malformed URL on a VM where only GCLOUD_PROJECT is set.
const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
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
}

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

function buildGeminiImageRequest(req: ImageGenerationRequest) {
  const parts: Array<Record<string, unknown>> = [{ text: req.prompt }]
  if (req.sourceImageBase64 && req.sourceMimeType) {
    parts.push({ inlineData: { mimeType: req.sourceMimeType, data: req.sourceImageBase64 } })
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
    safetySettings: SAFETY_SETTINGS,
  }
}

async function callVertexImageModel(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${req.model}:generateContent`
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

// No Ollama tail here, unlike getAdapterChain's chat-completions chain
// (router.ts:49-58) — Ollama cannot generate images. If both breakers are
// open (or both calls fail), the caller gets a clean throw, handled by
// handleImageGenerations below as a 503.
export class UnsupportedImageModelError extends Error {}

export async function generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
  if (!IMAGE_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedImageModelError(`Unsupported image model: ${req.model}`)
  }

  let vertexFailureReason: string | null = null

  if (vertexImageBreaker.isAvailable()) {
    try {
      const result = await callVertexImageModel(req)
      vertexImageBreaker.onSuccess()
      return result
    } catch (vertexErr) {
      vertexImageBreaker.onFailure()
      vertexFailureReason = (vertexErr as Error).message
      console.warn('[images] vertex failed, trying gemini API key fallback:', vertexFailureReason)
    }
  } else {
    vertexFailureReason = 'circuit open'
    console.warn('[images] vertex circuit open, trying gemini API key fallback')
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(`Vertex image generation unavailable (${vertexFailureReason}) and no GEMINI_API_KEY fallback configured`)
  }
  if (!geminiImageBreaker.isAvailable()) {
    throw new Error(`Vertex image generation unavailable (${vertexFailureReason}) and Gemini API key circuit is open`)
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

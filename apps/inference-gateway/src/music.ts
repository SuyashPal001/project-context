import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexMusicBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'

const MUSIC_MODEL_ALLOWLIST = new Set(['lyria-002'])

const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

export interface MusicGenerationRequest {
  model: string
  prompt: string
}

export type MusicGenerationResult =
  | { audioBase64: string; mimeType: string }
  | { refused: true; reason: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyVertexMusicResponse(vertexResponse: any): MusicGenerationResult {
  const prediction = vertexResponse?.predictions?.[0]
  if (!prediction) return { refused: true, reason: 'NO_PREDICTIONS' }
  if (typeof prediction.bytesBase64Encoded !== 'string') return { refused: true, reason: 'NO_AUDIO_BYTES' }
  return { audioBase64: prediction.bytesBase64Encoded, mimeType: prediction.mimeType ?? 'audio/wav' }
}

async function callVertexMusicModel(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${req.model}:predict`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt: req.prompt }] }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`Vertex music generation failed: ${res.status} ${await res.text()}`)
  return classifyVertexMusicResponse(await res.json())
}

export class UnsupportedMusicModelError extends Error {}

// No fallback tier — lyria-002 has no Gemini-API-key equivalent (see spec's
// "No Gemini-API-key fallback tier" note). A Vertex failure or open circuit
// is a clean throw; there is nothing to fall back to.
export async function generateMusic(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  if (!MUSIC_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedMusicModelError(`Unsupported music model: ${req.model}`)
  }
  if (!vertexMusicBreaker.isAvailable()) {
    throw new Error('Vertex music generation unavailable (circuit open)')
  }
  try {
    const result = await callVertexMusicModel(req)
    vertexMusicBreaker.onSuccess()
    return result
  } catch (err) {
    vertexMusicBreaker.onFailure()
    throw err
  }
}

export async function handleMusicGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: MusicGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await generateMusic(payload)
    latency.observe({ adapter: 'music' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'music', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'music' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'music', status: 'failure' })
    if (err instanceof UnsupportedMusicModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[music] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}

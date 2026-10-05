import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { vertexMusicBreaker } from './router.js'
import { requestsTotal, latency } from './metrics.js'
import { isContentBlocked } from './contentBlocked.js'

export const LYRIA3_MODEL = 'lyria-3-clip-preview'
const MUSIC_MODEL_ALLOWLIST = new Set(['lyria-002', LYRIA3_MODEL])

const PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1'
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

export interface MusicGenerationRequest {
  model: string
  prompt: string
  // lyria-3-clip-preview only: sung in order, after a "Lyrics:" heading. lyria-002 ignores it.
  lyrics?: string[]
}

export type MusicGenerationResult =
  | { audioBase64: string; mimeType: string; lyricsText?: string }
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
// Thrown when Lyria rejects the prompt (500 "Could not generate audio") after
// retries — agent should ask the user to rephrase rather than call it transient.
export class LyriaPromptRejectedError extends Error {}

// Lyria 3 (sung, any language) is a Gemini-style model: generateContent at
// location global only, and it must be asked for TEXT as well as AUDIO or
// Vertex answers a bare 400. The text parts carry timed lyric lines,
// e.g. "[9.4:14.9] Chai Nation, mazaa baar baar" (verified 2026-10-05).
export function lyria3Url(project: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${LYRIA3_MODEL}:generateContent`
}

export function lyria3Body(prompt: string, lyrics?: string[]) {
  const text = lyrics?.length ? `${prompt}\n\nLyrics:\n[Chorus]\n${lyrics.join('\n')}` : prompt
  return { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO', 'TEXT'] } }
}

const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyLyria3Response(json: any): MusicGenerationResult {
  if (json?.promptFeedback?.blockReason) return { refused: true, reason: 'CONTENT_BLOCKED' }
  const candidate = json?.candidates?.[0]
  if (!candidate) return { refused: true, reason: 'NO_PREDICTIONS' }
  if (BLOCKED_FINISH.has(candidate.finishReason)) return { refused: true, reason: 'CONTENT_BLOCKED' }
  const parts: Array<{ text?: unknown; inlineData?: { data?: unknown; mimeType?: unknown } }> = candidate.content?.parts ?? []
  const audio = parts.find((p) => typeof p?.inlineData?.data === 'string')
  if (!audio) return { refused: true, reason: 'NO_AUDIO_BYTES' }
  const lyricsText = parts.filter((p) => typeof p?.text === 'string').map((p) => p.text as string).join('\n')
  return { audioBase64: audio.inlineData!.data as string, mimeType: (audio.inlineData!.mimeType as string | undefined) ?? 'audio/mpeg', lyricsText }
}

async function callLyria3(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const res = await fetch(lyria3Url(PROJECT), {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(lyria3Body(req.prompt, req.lyrics)),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    const text = await res.text()
    if (isContentBlocked(text)) return { refused: true, reason: 'CONTENT_BLOCKED' }
    throw new Error(`Vertex music generation failed: ${res.status} ${text}`)
  }
  return classifyLyria3Response(await res.json())
}

const callFor = (req: MusicGenerationRequest) => (req.model === LYRIA3_MODEL ? callLyria3 : callVertexMusicModel)

async function callVertexMusicModelWithRetry(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  const call = callFor(req)
  try {
    return await call(req)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    // Lyria's transient 500 — retry once after a short delay
    if (msg.includes('500') && msg.includes('Could not generate audio')) {
      console.warn('[music] Lyria 500, retrying once…')
      await new Promise(r => setTimeout(r, 2_000))
      try {
        return await call(req)
      } catch (retryErr) {
        const retryMsg = (retryErr as Error).message ?? ''
        if (retryMsg.includes('500') && retryMsg.includes('Could not generate audio')) {
          throw new LyriaPromptRejectedError(
            'Lyria could not generate audio for this prompt. Ask the user to try a different style or description.'
          )
        }
        throw retryErr
      }
    }
    throw err
  }
}

// No fallback tier — lyria-002 has no Gemini-API-key equivalent (see spec's
// "No Gemini-API-key fallback tier" note). A Vertex failure or open circuit
// is a clean throw; there is nothing to fall back to.
// lyria-3-clip-preview has no fallback tier either; it shares the breaker and the one transient-500 retry.
export async function generateMusic(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
  if (!MUSIC_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedMusicModelError(`Unsupported music model: ${req.model}`)
  }
  if (!vertexMusicBreaker.isAvailable()) {
    throw new Error('Vertex music generation unavailable (circuit open)')
  }
  try {
    const result = await callVertexMusicModelWithRetry(req)
    vertexMusicBreaker.onSuccess()
    return result
  } catch (err) {
    // Don't penalise the breaker for prompt rejections — those are user errors, not infra failures
    if (err instanceof LyriaPromptRejectedError) throw err
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
    if (err instanceof LyriaPromptRejectedError) {
      res.writeHead(422, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'prompt_rejected' } }))
      return
    }
    console.error('[music] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}

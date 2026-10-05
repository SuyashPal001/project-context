import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { requestsTotal, latency } from './metrics.js'

// gemini-2.5-flash was retired for new users ("no longer available", 404),
// which failed every transcription and left captions without timings
// (2026-10-05). 3.6-flash is the model the rest of the platform already runs.
const TRANSCRIBE_MODEL_ALLOWLIST = new Set(['gemini-3.6-flash', 'gemini-3.8-flash'])
const DEFAULT_TRANSCRIBE_MODEL = 'gemini-3.6-flash'

// The caller (transcribe_audio.ts, Task 5) always sends audio-only bytes —
// never a full video — specifically so this stays far under Gemini's
// inline-request ceiling. 20MB decoded is already generous for a 30s AAC
// track (typically well under 1MB); this cap exists to refuse a caller
// mistake (e.g. sending the video itself) cleanly rather than passing an
// oversized payload to Gemini and getting a cryptic 4xx back.
const MAX_TRANSCRIBE_AUDIO_BYTES = 20 * 1024 * 1024

export interface TranscribeRequest {
  audioBase64: string
  mimeType: string
  model?: string
}

export interface TranscribeWord {
  word: string
  startSeconds: number
  endSeconds: number
}

export type TranscribeResult =
  | { text: string; words: TranscribeWord[] }
  | { refused: true; reason: string }

export class UnsupportedTranscribeModelError extends Error {}
export class TranscribeBackendUnavailableError extends Error {}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    words: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          startSeconds: { type: 'NUMBER' },
          endSeconds: { type: 'NUMBER' },
        },
        required: ['word', 'startSeconds', 'endSeconds'],
      },
    },
  },
  required: ['text', 'words'],
}

function isValidTranscribePayload(value: unknown): value is { text: string; words: TranscribeWord[] } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.text !== 'string' || !Array.isArray(v.words)) return false
  return v.words.every((w) => {
    if (typeof w !== 'object' || w === null) return false
    const word = w as Record<string, unknown>
    return typeof word.word === 'string' && typeof word.startSeconds === 'number' && typeof word.endSeconds === 'number'
  })
}

// Vertex first: the 3.x Flash models are served there (the rest of the
// gateway reaches them through Vertex), while the developer API key path
// failed every transcription on the VM (2026-10-05, captions skipped twice;
// the same request on Vertex returned word timings in 16s). The API key is
// kept as the fallback for a gateway without a Vertex project.
const _auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

async function transcribeEndpoint(model: string): Promise<{ url: string; headers: Record<string, string> }> {
  const project = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
  if (project) {
    const token = (await (await _auth.getClient()).getAccessToken()).token ?? ''
    return {
      url: `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    }
  }
  const key = process.env.GEMINI_API_KEY ?? ''
  if (!key) {
    throw new TranscribeBackendUnavailableError('Gemini transcription unavailable: no VERTEX_PROJECT or GEMINI_API_KEY configured')
  }
  return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, headers: { 'Content-Type': 'application/json' } }
}

export async function transcribeAudio(req: TranscribeRequest): Promise<TranscribeResult> {
  const model = req.model ?? DEFAULT_TRANSCRIBE_MODEL
  if (!TRANSCRIBE_MODEL_ALLOWLIST.has(model)) {
    throw new UnsupportedTranscribeModelError(`Unsupported transcribe model: ${model}`)
  }

  // Decoded-size check before any network call — a caller sending video by
  // mistake gets a clean refusal here, not a confusing Gemini 4xx.
  const decodedBytes = Math.floor(req.audioBase64.length * 3 / 4)
  if (decodedBytes > MAX_TRANSCRIBE_AUDIO_BYTES) {
    return { refused: true, reason: 'Source audio exceeds transcription size limit' }
  }

  const { url, headers } = await transcribeEndpoint(model)
  const geminiRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: req.mimeType, data: req.audioBase64 } },
          { text: 'Transcribe the spoken audio in this file exactly as spoken, word for word. Return strict JSON matching the response schema: text is the full transcript, words is every spoken word in order with its start and end time in seconds as decimals. Do not include any commentary outside the JSON.' },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!geminiRes.ok) throw new Error(`Gemini transcription failed: ${geminiRes.status} ${await geminiRes.text()}`)

  const data = await geminiRes.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (typeof rawText !== 'string') {
    return { refused: true, reason: 'Gemini returned no transcript text' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { refused: true, reason: 'Gemini response failed schema validation: not valid JSON' }
  }

  if (!isValidTranscribePayload(parsed)) {
    return { refused: true, reason: 'Gemini response failed schema validation: shape mismatch' }
  }

  return parsed
}

export async function handleTranscribeGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: TranscribeRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await transcribeAudio(payload)
    latency.observe({ adapter: 'transcribe' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'transcribe', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'transcribe' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'transcribe', status: 'failure' })
    if (err instanceof UnsupportedTranscribeModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[transcribe] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}

import type { IncomingMessage, ServerResponse } from 'http'
import { requestsTotal, latency } from './metrics.js'

const SPEECH_MODEL_ALLOWLIST = new Set(['sonic-3.5'])

// Cartesia-Version for /tts/bytes endpoint — matches the proven-working value
// in apps/web/app/api/creative/voices/preview/route.ts (2026-03-01).
// Note: apps/web's /voices list endpoints use 2026-08-14, but this adapter
// mimics /tts/bytes specifically.
const CARTESIA_VERSION = '2026-03-01'

const MAX_AUDIO_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB cap, matching apps/web

export interface SpeechGenerationRequest {
  model: string
  transcript: string
  voiceId: string
  language?: string
}

export type SpeechGenerationResult =
  | { audioBase64: string; mimeType: string; durationSeconds: number }
  | { refused: true; reason: string }

export class UnsupportedSpeechModelError extends Error {}

// Reads duration from a WAV header by validating chunk layout first.
// A WAV with an unexpected chunk before data (LIST/fact/bext) silently
// produces garbage if trusted naively. This implementation asserts the
// fmt chunk at offset 12 and data chunk at offset 36, throwing if either
// is missing.
export function readWavDurationSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file')
  }
  // Validate fmt chunk is where we expect it (at offset 12)
  if (buf.toString('ascii', 12, 16) !== 'fmt ') {
    throw new Error('Unexpected WAV chunk layout')
  }
  // Validate data chunk is where we expect it (at offset 36)
  if (buf.toString('ascii', 36, 40) !== 'data') {
    throw new Error('Unexpected WAV chunk layout')
  }
  const numChannels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)
  const dataSize = buf.readUInt32LE(40)
  // Sanity check: dataSize should not exceed buffer minus the 44-byte header
  if (dataSize > buf.length - 44) {
    throw new Error('WAV data chunk size exceeds buffer')
  }
  const bytesPerSample = bitsPerSample / 8
  const numSamples = dataSize / (bytesPerSample * numChannels)
  return numSamples / sampleRate
}

async function callCartesia(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  const key = process.env.CARTESIA_API_KEY ?? ''
  const language = req.language ?? 'en'
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: req.model,
      transcript: req.transcript,
      voice: { mode: 'id', id: req.voiceId },
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
      language,
    }),
    signal: AbortSignal.timeout(30_000),
  })

  // 4xx errors (except 429) are permanent refusals — bad voiceId, content moderation, etc.
  // Map them to the refused arm rather than throwing.
  if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 429) {
    const reason = await res.text().catch(() => `HTTP ${res.status}`)
    return { refused: true, reason: `Cartesia rejected: ${reason}` }
  }

  if (!res.ok) {
    throw new Error(`Cartesia speech generation failed: ${res.status} ${await res.text()}`)
  }

  // Validate response content-type and size before buffering
  const contentType = res.headers.get('content-type') ?? ''
  const contentLength = Number(res.headers.get('content-length') ?? 0)

  if (!contentType.startsWith('audio/')) {
    return { refused: true, reason: `Unexpected content-type: ${contentType}` }
  }

  if (contentLength > MAX_AUDIO_SIZE_BYTES) {
    return { refused: true, reason: 'Audio size exceeds limit' }
  }

  const buf = Buffer.from(await res.arrayBuffer())

  if (buf.byteLength > MAX_AUDIO_SIZE_BYTES) {
    return { refused: true, reason: 'Audio size exceeds limit' }
  }

  const durationSeconds = readWavDurationSeconds(buf)
  return { audioBase64: buf.toString('base64'), mimeType: 'audio/wav', durationSeconds }
}

export async function generateSpeech(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  if (!SPEECH_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedSpeechModelError(`Unsupported speech model: ${req.model}`)
  }
  return callCartesia(req)
}

export async function handleSpeechGenerations(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let body: string
  try { body = await readBody(req) } catch (err) {
    const status = (err as Error).message === 'PAYLOAD_TOO_LARGE' ? 413 : 400
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }))
    return
  }
  let payload: SpeechGenerationRequest
  try { payload = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await generateSpeech(payload)
    latency.observe({ adapter: 'speech' }, Date.now() - t0)
    // Refused results are still "success" from the gateway perspective — a valid
    // response that downstream can reason about. Only thrown errors count as failures.
    requestsTotal.inc({ adapter: 'speech', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'speech' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'speech', status: 'failure' })
    if (err instanceof UnsupportedSpeechModelError) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }))
      return
    }
    console.error('[speech] generation failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}

import type { IncomingMessage, ServerResponse } from 'http'
import { requestsTotal, latency } from './metrics.js'

const SPEECH_MODEL_ALLOWLIST = new Set(['sonic-3.5'])

// Cartesia's own versioning header — one value, used consistently, unlike
// apps/web's two existing Cartesia call sites which currently disagree
// (2026-03-01 vs 2026-08-14). Picking the more recent one deliberately;
// apps/web's inconsistency is out of scope to fix here (see spec's Open
// Questions).
const CARTESIA_VERSION = '2026-08-14'

export interface SpeechGenerationRequest {
  model: string
  transcript: string
  voiceId: string
}

export type SpeechGenerationResult =
  | { audioBase64: string; mimeType: string; durationSeconds: number }
  | { refused: true; reason: string }

export class UnsupportedSpeechModelError extends Error {}

// Reads duration from a canonical 44-byte WAV header (RIFF/WAVE, one fmt
// chunk before data) rather than trusting any vendor-reported duration field
// — Cartesia's /tts/bytes response is the raw audio file, not a JSON
// envelope with metadata. sampleRate and numChannels come straight from the
// fmt chunk so this works regardless of what output_format was requested.
export function readWavDurationSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file')
  }
  const numChannels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)
  const dataSize = buf.readUInt32LE(40)
  const bytesPerSample = bitsPerSample / 8
  const numSamples = dataSize / (bytesPerSample * numChannels)
  return numSamples / sampleRate
}

async function callCartesia(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  const key = process.env.CARTESIA_API_KEY ?? ''
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: req.model,
      transcript: req.transcript,
      voice: { mode: 'id', id: req.voiceId },
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
      language: 'en',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`Cartesia speech generation failed: ${res.status} ${await res.text()}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
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

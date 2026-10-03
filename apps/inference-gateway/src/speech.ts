import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { requestsTotal, latency } from './metrics.js'

const SPEECH_MODEL_ALLOWLIST = new Set(['sonic-3.5', 'gemini-3.8-flash-tts'])

// Gemini 3.8 Flash TTS: Vertex publisher model on the global endpoint only
// (verified live 2026-10-03 against this project). It takes a natural-language
// delivery direction in speechMetadata.style, kept apart from the transcript so
// it is never spoken, and inline vocal tags in the transcript (<breath>,
// <laugh>, <sigh>, <short pause>). It detects the language itself, and its
// voices (core names like "Leda" and library ids like "en-in-commercial-2")
// speak every language.
const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts'
const VERTEX_PROJECT = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

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
  // Sonic-3 delivery controls (generation_config). Out-of-range or unknown
  // values are dropped rather than refused, so a bad hint never fails a read.
  emotion?: string
  speed?: number
  volume?: number
  // Gemini only: how the line should be performed, in plain English.
  direction?: string
}

// Cartesia's documented emotion values (English only).
export const CARTESIA_EMOTIONS = new Set([
  'neutral', 'happy', 'excited', 'enthusiastic', 'elated', 'euphoric', 'triumphant', 'amazed', 'surprised',
  'flirtatious', 'curious', 'content', 'peaceful', 'serene', 'calm', 'grateful', 'affectionate', 'trust',
  'sympathetic', 'anticipation', 'mysterious', 'angry', 'mad', 'outraged', 'frustrated', 'agitated',
  'threatened', 'disgusted', 'contempt', 'envious', 'sarcastic', 'ironic', 'sad', 'dejected', 'melancholic',
  'disappointed', 'hurt', 'guilty', 'bored', 'tired', 'rejected', 'nostalgic', 'wistful', 'apologetic',
  'hesitant', 'insecure', 'confused', 'resigned', 'anxious', 'panicked', 'alarmed', 'scared', 'proud',
  'confident', 'distant', 'skeptical', 'contemplative', 'determined',
])

export function generationConfig(req: SpeechGenerationRequest, language: string): Record<string, string | number> | undefined {
  const config: Record<string, string | number> = {}
  if (typeof req.speed === 'number' && req.speed >= 0.6 && req.speed <= 1.5) config.speed = req.speed
  if (typeof req.volume === 'number' && req.volume >= 0.5 && req.volume <= 2) config.volume = req.volume
  const emotion = req.emotion?.toLowerCase()
  if (emotion && language === 'en' && CARTESIA_EMOTIONS.has(emotion)) config.emotion = emotion
  return Object.keys(config).length ? config : undefined
}

export type SpeechGenerationResult =
  | { audioBase64: string; mimeType: string; durationSeconds: number }
  | { refused: true; reason: string }

export class UnsupportedSpeechModelError extends Error {}

// Reads duration from a WAV header by walking chunks. Some producers
// (Cartesia among them) emit non-PCM fmt chunk sizes, or insert LIST/fact/
// bext/JUNK chunks between fmt and data — asserting fixed offsets 12/36
// throws on all of those. Walk the chunk list instead, locate fmt and data
// by id, and derive duration from data.size / (channels * sampleRate *
// bytesPerSample). Fails only when the file isn't RIFF/WAVE, is truncated
// mid-chunk, or is missing fmt or data outright.
export function readWavDurationSeconds(buf: Buffer): number {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file')
  }
  let offset = 12
  let numChannels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataSize = -1
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    if (chunkId === 'data') {
      // Cartesia (and other TTS producers) sometimes emit a data chunkSize
      // larger than the delivered buffer — the header is written eagerly for
      // streaming clients that fill the remainder later. Clamp to what we
      // actually received so duration is computed from real bytes; the audio
      // bytes themselves are passed through untouched to the caller.
      dataSize = Math.min(chunkSize, buf.length - chunkStart)
      break
    }
    if (chunkStart + chunkSize > buf.length) throw new Error(`WAV chunk ${chunkId} exceeds buffer`)
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('WAV fmt chunk too small')
      numChannels = buf.readUInt16LE(chunkStart + 2)
      sampleRate = buf.readUInt32LE(chunkStart + 4)
      bitsPerSample = buf.readUInt16LE(chunkStart + 14)
    }
    // Chunk sizes are padded to even byte boundaries per the RIFF spec.
    offset = chunkStart + chunkSize + (chunkSize % 2)
  }
  if (numChannels === 0 || sampleRate === 0 || bitsPerSample === 0) throw new Error('WAV missing fmt chunk')
  if (dataSize < 0) throw new Error('WAV missing data chunk')
  const bytesPerSample = bitsPerSample / 8
  const numSamples = dataSize / (bytesPerSample * numChannels)
  return numSamples / sampleRate
}

async function callCartesia(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  const key = process.env.CARTESIA_API_KEY ?? ''
  const language = req.language ?? 'en'
  const config = generationConfig(req, language)
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
      ...(config ? { generation_config: config } : {}),
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

// Gemini has no emotion/speed fields; a request that only carries Cartesia-style
// hints still gets a direction built from them.
export function geminiStyle(req: SpeechGenerationRequest): string | undefined {
  const direction = req.direction?.trim()
  if (direction) return direction.slice(0, 1000)
  const bits: string[] = []
  if (req.emotion) bits.push(`${req.emotion.toLowerCase()} delivery`)
  if (typeof req.speed === 'number' && req.speed >= 1.05) bits.push('a little faster than normal')
  if (typeof req.speed === 'number' && req.speed <= 0.95) bits.push('a little slower than normal')
  return bits.length ? `Natural, human read: ${bits.join(', ')}.` : undefined
}

// Gemini returns audio/wav, or raw 16-bit PCM ("audio/L16;rate=24000") on some
// paths; wrap the latter so every caller gets a playable WAV.
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function callGeminiTts(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  const style = geminiStyle(req)
  const client = await _auth.getClient()
  const tokenResp = await client.getAccessToken()
  const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${GEMINI_TTS_MODEL}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: req.transcript, ...(style ? { speechMetadata: { style } } : {}) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voiceId } } },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 429) {
    const reason = await res.text().catch(() => `HTTP ${res.status}`)
    return { refused: true, reason: `Gemini TTS rejected: ${reason.slice(0, 500)}` }
  }
  if (!res.ok) throw new Error(`Gemini TTS failed: ${res.status} ${(await res.text()).slice(0, 500)}`)
  const data = await res.json() as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> }
  const audio = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData
  if (!audio?.data) return { refused: true, reason: `Gemini TTS returned no audio (finishReason: ${data.candidates?.[0]?.finishReason ?? 'none'})` }
  let buf: Buffer = Buffer.from(audio.data, 'base64')
  const mime = audio.mimeType ?? ''
  if (!mime.includes('wav') && buf.toString('ascii', 0, 4) !== 'RIFF') {
    buf = pcmToWav(buf, Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000))
  }
  if (buf.byteLength > MAX_AUDIO_SIZE_BYTES) return { refused: true, reason: 'Audio size exceeds limit' }
  return { audioBase64: buf.toString('base64'), mimeType: 'audio/wav', durationSeconds: readWavDurationSeconds(buf) }
}

export async function generateSpeech(req: SpeechGenerationRequest): Promise<SpeechGenerationResult> {
  if (!SPEECH_MODEL_ALLOWLIST.has(req.model)) {
    throw new UnsupportedSpeechModelError(`Unsupported speech model: ${req.model}`)
  }
  return req.model === GEMINI_TTS_MODEL ? callGeminiTts(req) : callCartesia(req)
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

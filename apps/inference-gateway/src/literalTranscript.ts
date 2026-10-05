import type { IncomingMessage, ServerResponse } from 'http'
import { GoogleAuth } from 'google-auth-library'
import { requestsTotal, latency } from './metrics.js'

// A literal transcript: what was actually said, not what should have been.
// Gemini corrects a slurred word to the word it expects ("bright" said as
// "briny" came back as "bright" under every prompt, 2026-10-05). Cloud Speech
// Chirp 2 has no idea what the script was, so it writes "briny". check_clip
// compares this with the approved line to find mispronounced words.
const CHIRP_LOCATION = 'us-central1'
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const _auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

export interface LiteralTranscriptRequest {
  audioBase64: string
  language?: string
}

export async function literalTranscript(req: LiteralTranscriptRequest): Promise<{ text: string } | { refused: true; reason: string }> {
  const project = process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''
  if (!project) return { refused: true, reason: 'No VERTEX_PROJECT configured' }
  if (Math.floor(req.audioBase64.length * 3 / 4) > MAX_AUDIO_BYTES) return { refused: true, reason: 'Audio too large' }
  const token = (await (await _auth.getClient()).getAccessToken()).token ?? ''
  const res = await fetch(`https://${CHIRP_LOCATION}-speech.googleapis.com/v2/projects/${project}/locations/${CHIRP_LOCATION}/recognizers/_:recognize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-goog-user-project': project },
    body: JSON.stringify({
      config: { autoDecodingConfig: {}, languageCodes: [req.language || 'en-US'], model: 'chirp_2' },
      content: req.audioBase64,
    }),
  })
  if (!res.ok) throw new Error(`Chirp ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json() as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
  const text = (data.results ?? []).map(r => r.alternatives?.[0]?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim()
  return { text }
}

export async function handleLiteralTranscript(req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<string>): Promise<void> {
  let payload: LiteralTranscriptRequest
  try {
    payload = JSON.parse(await readBody(req))
    if (typeof payload.audioBase64 !== 'string') throw new Error('audioBase64 required')
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message } }))
    return
  }
  const t0 = Date.now()
  try {
    const result = await literalTranscript(payload)
    latency.observe({ adapter: 'literal-transcript' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'literal-transcript', status: 'success' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    latency.observe({ adapter: 'literal-transcript' }, Date.now() - t0)
    requestsTotal.inc({ adapter: 'literal-transcript', status: 'failure' })
    console.error('[literal-transcript] failed:', (err as Error).message)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'api_error' } }))
  }
}

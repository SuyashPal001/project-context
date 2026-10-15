// Veo 3.1 Fast first+last frame on Vertex AI (spec §5.4; the body was proven in the clone spike
// 2026-10-13 and Fast tested on the same pair 2026-10-15): inline images, no audio, 720p,
// polled with fetchPredictOperation. Fast is $0.10/s vs standard $0.40/s at the same result.
import { GoogleAuth } from 'google-auth-library'

export const VEO_31_MODEL = 'veo-3.1-fast-generate-001'
const LOCATION = 'us-central1'
const TIMEOUT_MS = 200_000 // under the gateway's 240s
const POLL_MS = 6_000
const _auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })
const project = () => process.env.VERTEX_PROJECT ?? process.env.GCLOUD_PROJECT ?? ''

export interface InlineImage { data: string; mime: string }

export function veoTransitionBody(o: { prompt: string; start: InlineImage; last: InlineImage | null; seconds: number; aspectRatio: '16:9' | '9:16' }) {
  return {
    instances: [{
      prompt: o.prompt,
      image: { bytesBase64Encoded: o.start.data, mimeType: o.start.mime },
      ...(o.last ? { lastFrame: { bytesBase64Encoded: o.last.data, mimeType: o.last.mime } } : {}),
    }],
    parameters: { aspectRatio: o.aspectRatio, durationSeconds: o.seconds, sampleCount: 1, generateAudio: false, resolution: '720p', personGeneration: 'allow_adult' },
  }
}

export async function fetchInline(url: string): Promise<InlineImage> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`)
  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: mime.startsWith('image/') ? mime : 'image/jpeg' }
}

async function token(): Promise<string> {
  const t = await (await _auth.getClient()).getAccessToken()
  if (!t.token) throw new Error('no Vertex access token')
  return t.token
}

export type VeoResult = { videoBase64: string; mimeType: string } | { refused: true; reason: string }

export async function callVeoTransition(o: { prompt: string; startUri: string; lastUri?: string; seconds: number; aspectRatio: '16:9' | '9:16' }): Promise<VeoResult> {
  const [start, last] = await Promise.all([fetchInline(o.startUri), o.lastUri ? fetchInline(o.lastUri) : Promise.resolve(null)])
  const base = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project()}/locations/${LOCATION}/publishers/google/models/${VEO_31_MODEL}`
  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`Veo ${res.status} ${await res.text()}`)
    return res.json() as Promise<Record<string, unknown>>
  }
  const started = await post(`${base}:predictLongRunning`, veoTransitionBody({ prompt: o.prompt, start, last, seconds: o.seconds, aspectRatio: o.aspectRatio }))
  const operationName = started.name as string | undefined
  if (!operationName) throw new Error('Veo: no operation name')
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const op = await post(`${base}:fetchPredictOperation`, { operationName }) as { done?: boolean; error?: { message?: string }; response?: { videos?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> } }
    if (op.done) {
      if (op.error) throw new Error(`Veo operation error: ${op.error.message}`)
      const v = op.response?.videos?.[0]
      if (!v?.bytesBase64Encoded) return { refused: true, reason: 'CONTENT_BLOCKED' }
      return { videoBase64: v.bytesBase64Encoded, mimeType: v.mimeType ?? 'video/mp4' }
    }
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('Veo generation timed out')
}

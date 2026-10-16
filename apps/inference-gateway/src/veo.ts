// Veo 3.1 Fast first+last frame on Vertex AI (spec §5.4; the body was proven in the clone spike
// 2026-10-13 and Fast tested on the same pair 2026-10-15): inline images, no audio, 720p,
// polled with fetchPredictOperation. Fast is $0.10/s vs standard $0.40/s at the same result.
import { GoogleAuth } from 'google-auth-library'

export const VEO_31_MODEL = 'veo-3.1-fast-generate-001'
const LOCATION = 'us-central1'
// The whole call (image fetches, start, polling) is budgeted from the request start, under the
// orchestrator's 270s abort, so the orchestrator never refunds a clip the gateway then delivers.
export const VEO_TOTAL_BUDGET_MS = 225_000
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
  const deadline = Date.now() + VEO_TOTAL_BUDGET_MS
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
  while (Date.now() < deadline) {
    // A poll error is transient: the generation is still running (and billed), so keep polling
    // until the deadline instead of throwing it away.
    let polled: Record<string, unknown>
    try {
      polled = await post(`${base}:fetchPredictOperation`, { operationName })
    } catch (err) {
      console.warn('[veo] poll failed, retrying:', (err as Error).message)
      await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))))
      continue
    }
    const op = polled as { done?: boolean; error?: { message?: string }; response?: { videos?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> } }
    if (op.done) {
      if (op.error) throw new Error(`Veo operation error: ${op.error.message}`)
      const v = op.response?.videos?.[0]
      if (!v?.bytesBase64Encoded) {
        // Google's "Child" support codes (58061214 on the input, 17301594 on the output): the person may
        // read as under 18. Said apart so the caller can ask for an older-looking person, not reword.
        const why = JSON.stringify((op.response as { raiMediaFilteredReasons?: unknown } | undefined)?.raiMediaFilteredReasons ?? '')
        return { refused: true, reason: /\b(17301594|58061214)\b/.test(why) ? 'MINOR_BLOCKED' : 'CONTENT_BLOCKED' }
      }
      return { videoBase64: v.bytesBase64Encoded, mimeType: v.mimeType ?? 'video/mp4' }
    }
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('Veo generation timed out')
}

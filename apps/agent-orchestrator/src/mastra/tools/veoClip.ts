// One Veo 3.1 Fast clip between two stills (spec §5.4). Charge-first, refund on every failure
// (same settled rule as generateVideo.ts). Not an agent tool: only the remake workflow
// calls it, after its own prompt gate and approval.
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { stableToolCallId } from '../../credits.js'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { refundVideoCharge } from './videoCredits.js'
import type { MediaExecContext } from './batchRunner.js'

export const VEO_CLIP_MODEL = 'google/veo-3.1-fast-generate-001'
const GATEWAY_MODEL_ID = 'veo-3.1-fast-generate-001'
const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'

export async function generateVeoClipItem(
  input: { prompt: string; startImageFileId: string; endImageFileId?: string; durationSeconds: 4 | 6 | 8; aspectRatio: '9:16' | '16:9'; title: string },
  exec: MediaExecContext, itemIndex: number,
): Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }> {
  const rc = exec.requestContext
  const tenantId = (rc?.get('tenantId') as string | undefined) ?? ''
  const agentId = rc?.get('agentId') as string | undefined
  const conversationId = (rc?.get('conversationId') as string | undefined) ?? 'unknown'
  const idToken = rc?.get('idToken') as string | undefined
  if (!idToken) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
  const chargeKey = `veo:${conversationId}:${stableToolCallId(exec.agent?.toolCallId ?? 'unknown')}:${itemIndex}`

  let imageUri: string, lastFrameUri: string | undefined
  try {
    imageUri = await fetchPresignedUrl(input.startImageFileId, idToken)
    lastFrameUri = input.endImageFileId ? await fetchPresignedUrl(input.endImageFileId, idToken) : undefined
  } catch {
    return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
  }

  let charged = false, rateId: string | null = null, rateVersion: number | null = null, amount = 0n
  if (!(await isUnlimited(tenantId))) {
    const rate = await resolveRate('video_generation', VEO_CLIP_MODEL)
    if (!rate) {
      console.error(`[credits] UNBILLED VIDEO GENERATION: no active video_generation rate for model=${VEO_CLIP_MODEL} tenantId=${tenantId}`)
    } else {
      rateId = rate.id; rateVersion = rate.version; amount = costMicro(rate.schema, { count: 1 })
      try {
        await spendCredits({ tenantId, amountMicro: -amount, key: chargeKey, kind: 'debit', actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'video_generation' })
        charged = true
      } catch (err) {
        if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
        throw err
      }
    }
  }
  const refund = async () => { if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion) }

  let out: { videoBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/video/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({ model: GATEWAY_MODEL_ID, prompt: input.prompt, task: 'image_to_video', aspectRatio: input.aspectRatio, durationSeconds: input.durationSeconds, imageUri, lastFrameUri }),
      signal: AbortSignal.timeout(270_000),
    })
    if (!res.ok) throw new Error(`gateway returned ${res.status}`)
    out = await res.json()
  } catch (err) {
    console.error('[veoClip] gateway call failed:', (err as Error).message)
    await refund()
    return { refused: true, refusalReason: 'GENERATION_FAILED' }
  }
  if (out.refused || typeof out.videoBase64 !== 'string') {
    await refund()
    return { refused: true, refusalReason: out.refused ? (out.reason ?? 'CONTENT_BLOCKED') : 'GENERATION_FAILED' }
  }
  const att = await uploadGeneratedFile(idToken, { conversationId, title: input.title, content: Buffer.from(out.videoBase64, 'base64'), contentType: out.mimeType ?? 'video/mp4', extension: 'mp4' })
  if (!att) { await refund(); return { refused: true, refusalReason: 'UPLOAD_FAILED' } }
  return { fileId: att.fileId, creditsUsedMicro: String(amount) }
}

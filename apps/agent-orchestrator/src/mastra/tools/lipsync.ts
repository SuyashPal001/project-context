import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { refundLipsyncCharge } from './lipsyncCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const DEFAULT_LIPSYNC_MODEL = 'fal-ai/latentsync'

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  model: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw (not just wrapped in the tool) so a test can call
// .safeParse on it directly — generateNarration.ts's first pass didn't do
// this and needed a review-round fix for it. See task-4 brief for the same
// lesson.
export const inputSchema = z.object({
  videoFileId: z.string(),
  audioFileId: z.string(),
  model: z.string().default(DEFAULT_LIPSYNC_MODEL).describe(
    'A gateway-allowlisted lip-sync model id. Default is cheaper and fully managed; relative output quality against the alternate (sync-2.0) is untested.'
  ),
})

export const lipsync = createTool({
  id: 'lipsync',
  description: 'Matches a silent video\'s mouth motion to a separate audio track. For talking-head, use once on the fully assembled silent video against the full narration track — never per-clip. For animation-character, use on exactly one beat clip (the hook beat) against that beat\'s single narration line — never on more than one beat in the same ad.',
  inputSchema,
  outputSchema,
  requireApproval: async (input, ctx) => {
    const { model } = input as z.infer<typeof inputSchema>
    return shouldRequireApproval({ resourceType: 'lipsync_generation', subject: model ?? DEFAULT_LIPSYNC_MODEL }, ctx)
  },
  execute: async (inputData, execContext) => {
    const { videoFileId, audioFileId, model } = inputData as z.infer<typeof inputSchema>
    const resolvedModel = model ?? DEFAULT_LIPSYNC_MODEL

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    // Left undefined, never '' — see generateVideo.ts's identical comment:
    // spendCredits' actorId does `?? null` internally so undefined casts
    // cleanly to ::uuid, but '' hits Postgres as ''::uuid and throws.
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) {
      // No idToken means fetchPresignedUrl below can never succeed — refuse
      // before any charge happens, same as generateVideo.ts's identical
      // check ahead of its own reference-image resolution.
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    let videoUri: string, audioUri: string
    try {
      ;[videoUri, audioUri] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(audioFileId, idToken),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] lipsync: failed to resolve source files:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Charge BEFORE the vendor call — same settled rule generateVideo.ts and
    // generateNarration.ts follow. generateSong.ts charges after and is a
    // known-divergent tool, not a template.
    const attempt = 0
    const chargeKey = `lipsync:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('lipsync_generation', resolvedModel)
      if (!rate) {
        console.error(`[credits] UNBILLED LIPSYNC GENERATION: no active lipsync_generation rate for model=${resolvedModel} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'lipsync_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let genResult: { videoBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/video/lipsync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: resolvedModel, videoUri, audioUri }),
        // Strictly larger than the gateway's own real worst-case runtime —
        // same directional pattern generateVideo.ts's 270s client timeout
        // uses against the gateway's 240s Gemini timeout (client timeout
        // must exceed the gateway's internal one, not just its poll loop).
        // The gateway's worst case (apps/inference-gateway/src/lipsync.ts)
        // is 270s poll budget + up to 15s for the COMPLETED status's
        // separate result-fetch call + up to 60s for downloadResultVideo's
        // own fetch/validation ≈ 345s. 355s gives real headroom over that,
        // so this clock never aborts a job that would have legitimately
        // succeeded.
        signal: AbortSignal.timeout(355_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] lipsync gateway call failed:`, (err as Error).message)
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.videoBase64 !== 'string') {
      console.error(`[session:${sessionId}] lipsync: gateway returned a non-refused response with no videoBase64`)
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = Buffer.from(genResult.videoBase64, 'base64')
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Lip-Synced Video', content: buffer,
      contentType: genResult.mimeType ?? 'video/mp4', extension: 'mp4',
    })

    if (!attachment) {
      if (charged) await refundLipsyncCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      model: resolvedModel,
      jobId,
    }
  },
})

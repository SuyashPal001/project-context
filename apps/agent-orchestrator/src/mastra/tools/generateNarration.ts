import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { refundNarrationCharge } from './narrationCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const SPEECH_MODEL = 'sonic-3.5'

const outputSchema = z.object({
  fileId: z.string().optional(),
  durationSeconds: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

export const inputSchema = z.object({
  script: z.string().max(500).describe(
    'The full narration script — one continuous read, not pre-split into clip-sized segments. ~500 characters is roughly 30-35 seconds of speech at typical ad pacing, matching this skill\'s 30s ceiling.'
  ),
  voiceId: z.string().describe('A Cartesia voice id, from the existing curated voice list.'),
})

export const generateNarration = createTool({
  id: 'generate-narration',
  description: 'Generates a full narration/voiceover audio clip from a script using Cartesia. Use for the talking-head skill\'s single continuous narration track — not for per-beat dialogue, which uses generate_video\'s native speech instead.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'narration_generation', subject: SPEECH_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { script, voiceId } = inputData as z.infer<typeof inputSchema>

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

    // Charge BEFORE the vendor call — same settled rule generateVideo.ts
    // follows. generateSong.ts charges after and is a known-divergent tool,
    // not a template.
    const attempt = 0
    const chargeKey = `narration:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('narration_generation', SPEECH_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED NARRATION GENERATION: no active narration_generation rate for model=${SPEECH_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'narration_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let genResult: { audioBase64?: string; mimeType?: string; durationSeconds?: number; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: SPEECH_MODEL, transcript: script, voiceId }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateNarration gateway call failed:`, (err as Error).message)
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.audioBase64 !== 'string' || typeof genResult.durationSeconds !== 'number') {
      console.error(`[session:${sessionId}] generateNarration: gateway returned a non-refused response with no audioBase64/durationSeconds`)
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (!conversationId || !idToken) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = Buffer.from(genResult.audioBase64, 'base64')
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Generated Narration', content: buffer,
      contentType: genResult.mimeType ?? 'audio/wav', extension: 'wav',
    })

    if (!attachment) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId,
      durationSeconds: genResult.durationSeconds,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})

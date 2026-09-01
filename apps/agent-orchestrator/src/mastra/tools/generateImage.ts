import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { refundImageCharge } from './imageCredits.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const IMAGE_MODEL = 'gemini-3-pro-image-preview'

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})

export const generateImage = createTool({
  id: 'generate-image',
  description: 'Generates a new image from a text prompt using Gemini 3 Pro Image. Use when the user asks Director to create, draw, or generate an image.',
  inputSchema: z.object({
    prompt: z.string().describe('Full description of the image to generate'),
  }),
  outputSchema,
  execute: async (inputData, execContext) => {
    const { prompt } = inputData as { prompt: string }
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'

    let genResult: { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateImage gateway call failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    if (genResult.refused) {
      return { refused: true, refusalReason: genResult.reason ?? 'unknown' }
    }

    // Validate the success shape BEFORE any charge lands — a missing
    // imageBase64 on a non-refused response must never leave the tenant
    // charged for nothing. (Currently unreachable given the gateway's
    // exhaustive response union, but this keeps the charged→throw window
    // closed regardless.)
    if (typeof genResult.imageBase64 !== 'string') {
      console.error(`[session:${sessionId}] generateImage: gateway returned a non-refused response with no imageBase64`)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    // Success — charge now, before the (best-effort) upload.
    const chargeKey = `image:${sessionId}:${randomUUID()}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('image_generation', IMAGE_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED IMAGE GENERATION: no active image_generation rate for model=${IMAGE_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        const amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'image_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
          throw err
        }
      }
    }

    const buffer = Buffer.from(genResult.imageBase64, 'base64')
    const extension = (genResult.mimeType ?? 'image/png').split('/')[1] ?? 'png'
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, {
          conversationId, title: 'Generated Image', content: buffer,
          contentType: genResult.mimeType, extension,
        })
      : null

    if (!attachment) {
      if (charged) await refundImageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED' }
    }

    return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
  },
})

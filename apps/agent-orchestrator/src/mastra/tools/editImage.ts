import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { getPool } from '../../usage.js'
import { resolveSourceImage } from '../../media.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const IMAGE_MODEL = 'gemini-3-pro-image-preview'
// Spec §4: cap the source image's byte size before it's even sent to the
// gateway. Enforced here (not in the Zod input schema, which only carries a
// fileId) right after resolveSourceImage returns the actual bytes.
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})

export const editImage = createTool({
  id: 'edit-image',
  description: 'Edits an existing image (from a file already in the conversation) using Gemini 3 Pro Image, given an editing instruction. Use when the user asks Director to modify, edit, or change an image that already exists.',
  inputSchema: z.object({
    prompt: z.string().describe('Instruction describing how to edit the source image'),
    sourceFileId: z.string().describe('fileId of the source image already present in the conversation'),
    sourceMimeType: z.string().describe('MIME type of the source image, e.g. image/png'),
  }),
  outputSchema,
  execute: async (inputData, execContext) => {
    const { prompt, sourceFileId, sourceMimeType } = inputData as { prompt: string; sourceFileId: string; sourceMimeType: string }
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'

    const source = await resolveSourceImage(idToken ?? '', sourceFileId, sourceMimeType, sessionId)
    if (!source) {
      return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
    }
    if (Buffer.byteLength(source.base64, 'base64') > MAX_SOURCE_IMAGE_BYTES) {
      return { refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }
    }

    let genResult: { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({
          model: IMAGE_MODEL, prompt,
          sourceImageBase64: source.base64, sourceMimeType: source.mimeType,
        }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] editImage gateway call failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    if (genResult.refused) {
      return { refused: true, refusalReason: genResult.reason ?? 'unknown' }
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

    const buffer = Buffer.from(genResult.imageBase64!, 'base64')
    const extension = (genResult.mimeType ?? 'image/png').split('/')[1] ?? 'png'
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, {
          conversationId, title: 'Edited Image', content: buffer,
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

// Mirrors refundTask's read-back pattern (products/agent-platform/packages/credits/refund.ts:109-169):
// the refund amount and expiry are read back from the ledger, never trusted
// from in-memory state, and the refund grant inherits the SHORTEST expiry
// among the grants the original debit drew from — a refund must never hand
// back a permanent grant for what was an expiring one.
async function refundImageCharge(
  tenantId: string, agentId: string, chargeKey: string,
  rateId: string | null, rateVersion: number | null,
): Promise<void> {
  try {
    const pool = getPool()
    const res = await pool.query<{ amount_micro: string; expires_at: string | null }>(
      `select cl.amount_micro, cg.expires_at
         from credit_ledger cl
         left join credit_grants cg on cg.id = cl.grant_id
        where cl.tenant_id = $1 and cl.idempotency_key = $2 and cl.kind = 'debit'`,
      [tenantId, chargeKey],
    )
    const net = res.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n) // negative — what was charged
    if (net >= 0n) return // nothing was actually charged
    const expiresAts = res.rows.map(row => row.expires_at)
    let expiresAt: Date | null = null
    for (const raw of expiresAts) {
      if (raw == null) continue
      const d = new Date(raw)
      if (expiresAt === null || d.getTime() < expiresAt.getTime()) expiresAt = d
    }
    await spendCredits({
      tenantId, amountMicro: -net, key: `${chargeKey}:refund`, kind: 'refund',
      actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'image_generation',
      grantType: 'refund', expiresAt,
    })
  } catch (err) {
    console.error(
      `[credits] UNREFUNDED IMAGE CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} — ` +
      `refund write failed and was swallowed; tenant is still down for a generation that ` +
      `could not be saved. Cause:`, (err as Error).message,
    )
  }
}

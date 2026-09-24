import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { resolveSourceImage } from '../../media.js'
import { refundImageCharge } from './imageCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import type { MediaExecContext } from './batchRunner.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
export const IMAGE_MODEL = 'gemini-3-pro-image-preview'

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024 // matches editImage.ts's existing per-file cap
// Aggregate cap across ALL resolved references in one call. The gateway's
// HTTP body-read limit (apps/inference-gateway/src/index.ts:180) is 40MB
// total, sized for one base64-inflated image — three references at the
// per-file cap above could inflate to ~80MB combined and 413 after the user
// already approved cost. 25MB decoded total leaves headroom under the
// gateway's 40MB raw-body cap once JSON/base64 overhead is included.
const MAX_TOTAL_REFERENCE_BYTES = 25 * 1024 * 1024

export const imageOutputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  model: z.string().optional(),
})

export const imageItemSchema = z.object({
  prompt: z.string().describe('Full description of the image to generate'),
  aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional()
    .describe('Output shape. Set it whenever the user stated or chose a size (e.g. 9:16 for stories/reels, 16:9 for banners/ads, 1:1 for posts). Omit only if truly unspecified.'),
  referenceFileIds: z.array(z.string().uuid()).min(1).max(3).optional()
    .describe('Existing files rows used as identity/style anchors — the model composes a new image informed by all of them.'),
  identityAnchor: z.object({
    terseTag: z.string(),
    styleLock: z.string(),
  }).optional().describe('When set, prompt MUST contain both strings verbatim — enforced in code. Required whenever referenceFileIds includes a cast sheet.'),
})

export type ImageItemInput = z.infer<typeof imageItemSchema>

export async function generateImageItem(
  inputData: ImageItemInput,
  execContext: MediaExecContext | undefined,
  itemIndex: number,
) {
    const { prompt, aspectRatio, referenceFileIds, identityAnchor } = inputData

    // Identity-anchor gate — enforced in tool code, not prose, mirroring
    // generateVideo.ts's extractQuotedSpans/approvedDialogue check. Refuses
    // before any charge or gateway call.
    if (identityAnchor && (!prompt.includes(identityAnchor.terseTag) || !prompt.includes(identityAnchor.styleLock))) {
      return { refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' }
    }

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    // Left undefined, not defaulted to '' — matches generateVideo.ts's fix
    // for the same field: spendCredits' actorId param does `?? null`
    // internally, so undefined casts cleanly to ::uuid, but '' hits Postgres
    // as ''::uuid and throws, aborting the whole charge before the gateway
    // is ever called. generateImage.ts's PRE-EXISTING `?? ''` on this same
    // line was a real, separate latent bug — fixed here.
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    // toolCallId lives on execContext.agent.toolCallId, not execContext.toolCallId
    // and not requestContext — same gotcha generateVideo.ts documents. Reading
    // the wrong location silently returns 'unknown' every time, which would
    // make chargeKey constant per conversation instead of per call.
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'

    // Not a refusal — referenceFileIds without identityAnchor is legitimate
    // (e.g. a non-cast-sheet reference), but it's also exactly what an
    // accidentally-omitted identityAnchor looks like. Flag it so a trace
    // review can spot omissions.
    if (referenceFileIds?.length && !identityAnchor) {
      console.warn(`[session:${sessionId}] generateImage: referenceFileIds set with no identityAnchor — verify this omission was intentional`)
    }

    let sourceImages: Array<{ base64: string; mimeType: string }> = []
    if (referenceFileIds?.length) {
      if (!idToken) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
      let totalBytes = 0
      for (const fileId of referenceFileIds) {
        const source = await resolveSourceImage(idToken, fileId, 'image/png', sessionId)
        if (!source) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
        const decodedBytes = Buffer.byteLength(source.base64, 'base64')
        if (decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
          return { refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }
        }
        totalBytes += decodedBytes
        if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
          return { refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }
        }
        sourceImages.push(source)
      }
    }

    let genResult: { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, ...(aspectRatio ? { aspectRatio } : {}), ...(sourceImages.length ? { sourceImages } : {}) }),
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

    // Success — charge now, before the (best-effort) upload. Deterministic
    // (conversationId + toolCallId + item index) rather than a random uuid,
    // so the key is stable per call and has the same shape as
    // generateVideo.ts's video:${jobId}:${attempt}. The item index occupies
    // the last slot; the single tool passes 0.
    const chargeKey = `image:${conversationId ?? sessionId}:${toolCallId}:${itemIndex}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('image_generation', IMAGE_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED IMAGE GENERATION: no active image_generation rate for model=${IMAGE_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
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
    const extension = (genResult.mimeType ?? 'image/png').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
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

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      model: IMAGE_MODEL,
    }
}

export const generateImage = createTool({
  id: 'generate-image',
  description: 'Generates a new image from a text prompt using Gemini 3 Pro Image, optionally anchored on 1-3 reference images for identity/style consistency. Use when the user asks Director to create, draw, or generate an image.',
  inputSchema: imageItemSchema,
  outputSchema: imageOutputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'image_generation', subject: IMAGE_MODEL }, ctx),
  execute: async (inputData, execContext) =>
    generateImageItem(inputData as ImageItemInput, execContext as unknown as MediaExecContext, 0),
})

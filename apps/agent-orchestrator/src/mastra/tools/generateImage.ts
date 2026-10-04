import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fileTitleSchema, fileTitle } from './fileTitle.js'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { resolveSourceImage } from '../../media.js'
import { refundImageCharge } from './imageCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import type { MediaExecContext } from './batchRunner.js'
import { emitGenerationStarted } from './generationStarted.js'
import { stableToolCallId } from '../../credits.js'
import { resolveAvatarReferences } from './avatarReferences.js'
import { withIdentityAnchor } from './identityAnchor.js'

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
  imageSize: z.enum(['1K', '2K']).optional()
    .describe('Output resolution; omit for the default 1K. Use 2K only for dense images with many small panels or text, such as a character reference sheet — it costs the same.'),
  referenceFileIds: z.array(z.string().uuid()).min(1).max(3).optional()
    .describe('Existing files rows used as identity/style anchors — the model composes a new image informed by all of them.'),
  identityAnchor: z.object({
    terseTag: z.string(),
    styleLock: z.string(),
  }).optional().describe('When set, both strings are added to the prompt automatically when missing. Required whenever referenceFileIds includes a cast sheet.'),
  skipAvatarExpansion: z.boolean().optional()
    .describe("Set true when the reference image must NOT be treated as the same person (e.g. a new person inspired by a reference's look): skips adding the avatar's reference sheet and identity sentence."),
  title: fileTitleSchema,
})

export type ImageItemInput = z.infer<typeof imageItemSchema>

export async function generateImageItem(
  inputData: ImageItemInput,
  execContext: MediaExecContext | undefined,
  itemIndex: number,
) {
    const { prompt: rawPrompt, aspectRatio, imageSize, referenceFileIds, identityAnchor, skipAvatarExpansion, title } = inputData

    // Identity anchor — enforced in tool code, not prose: any missing
    // terseTag/styleLock is added to the prompt rather than refused.
    const prompt = withIdentityAnchor(rawPrompt, identityAnchor)

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

    // An attached tenant avatar brings its reference sheet along, and its
    // identity anchor (terseTag/styleLock), if any (avatarReferences.ts).
    // skipAvatarExpansion (the "inspired by" intent — a new person, not the
    // same person as the reference) bypasses this entirely: the reference is
    // used exactly as given, with no sheet added and no identity sentence.
    const { fileIds: resolvedReferenceIds, anchor } = referenceFileIds?.length && !skipAvatarExpansion
      ? await resolveAvatarReferences(tenantId, referenceFileIds)
      : { fileIds: referenceFileIds, anchor: null }

    // The caller's own identityAnchor always wins and is already enforced
    // (verbatim in `prompt`) by the gate above. Only when the caller passed
    // none do we fold in the resolved avatar's anchor — and only into the
    // prompt sent to the gateway, never the user-visible input, and never if
    // the prompt already carries the terseTag (avoid a duplicated sentence).
    // Trailing periods on terseTag/styleLock are stripped first — both
    // already end sentences composed here, so a stored trailing period would
    // otherwise yield "..".
    const gatewayPrompt = !identityAnchor && anchor && !prompt.includes(anchor.terseTag)
      ? `${prompt} Same person as the reference: ${anchor.terseTag.replace(/\.+$/, '')}. ${anchor.styleLock.replace(/\.+$/, '')}.`
      : prompt

    let sourceImages: Array<{ base64: string; mimeType: string }> = []
    if (resolvedReferenceIds?.length) {
      if (!idToken) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
      let totalBytes = 0
      for (const fileId of resolvedReferenceIds) {
        // A sheet expandAvatarReferences added on top of the user/model-supplied
        // referenceFileIds is best-effort: if it can't be resolved or would push
        // the call over a byte cap, skip it (the original references were fine)
        // rather than refusing the whole call. An ORIGINAL id keeps today's
        // refusal behaviour exactly.
        const isAddedByExpansion = !referenceFileIds?.includes(fileId)
        const source = await resolveSourceImage(idToken, fileId, 'image/png', sessionId)
        if (!source) {
          if (isAddedByExpansion) {
            console.warn(`[session:${sessionId}] generateImage: skipping avatar reference sheet ${fileId} — could not be resolved`)
            continue
          }
          return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
        }
        const decodedBytes = Buffer.byteLength(source.base64, 'base64')
        if (decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
          if (isAddedByExpansion) {
            console.warn(`[session:${sessionId}] generateImage: skipping avatar reference sheet ${fileId} — exceeds the per-file cap`)
            continue
          }
          return { refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }
        }
        if (totalBytes + decodedBytes > MAX_TOTAL_REFERENCE_BYTES) {
          if (isAddedByExpansion) {
            console.warn(`[session:${sessionId}] generateImage: skipping avatar reference sheet ${fileId} — would exceed the total reference cap`)
            continue
          }
          return { refused: true, refusalReason: 'SOURCE_IMAGE_TOO_LARGE' }
        }
        totalBytes += decodedBytes
        sourceImages.push(source)
      }
    }

    // Charge BEFORE the vendor call — docs/media-generation/README.md's
    // settled rule, same as generateVideo.ts. This tool used to charge after
    // the image came back, so any non-balance spendCredits error threw away
    // an image the vendor had already been paid for (seen live 2026-09-25).
    // Now such an error fails before any vendor spend, and every failure
    // below refunds. Deterministic (conversationId + toolCallId + item
    // index) rather than a random uuid, so the key is stable per call and
    // has the same shape as generateVideo.ts's video:${jobId}:${attempt}.
    // The item index occupies the last slot; the single tool passes 0.
    // stableToolCallId: a Gemini 3.x toolCallId carries the thoughtSignature and
    // can be ~7KB, over Postgres's btree limit on credit_ledger's idempotency
    // index. That made every charge on Olmo's direct generate_image throw after
    // the image was already generated (seen live 2026-09-25).
    const chargeKey = `image:${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}:${itemIndex}`
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

    let genResult: { imageBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt: gatewayPrompt, ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}), ...(sourceImages.length ? { sourceImages } : {}) }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateImage gateway call failed:`, (err as Error).message)
      if (charged) await refundImageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    if (genResult.refused) {
      if (charged) await refundImageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown' }
    }

    // Currently unreachable given the gateway's exhaustive response union,
    // but a missing imageBase64 must never leave the tenant charged for nothing.
    if (typeof genResult.imageBase64 !== 'string') {
      console.error(`[session:${sessionId}] generateImage: gateway returned a non-refused response with no imageBase64`)
      if (charged) await refundImageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    const buffer = Buffer.from(genResult.imageBase64, 'base64')
    const extension = (genResult.mimeType ?? 'image/png').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, {
          conversationId, title: fileTitle(title, 'Generated Image'), content: buffer,
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
  execute: async (inputData, execContext) => {
    emitGenerationStarted(execContext, { aspectRatio: (inputData as { aspectRatio?: unknown }).aspectRatio })
    return generateImageItem(inputData as ImageItemInput, execContext as unknown as MediaExecContext, 0)
  },
})

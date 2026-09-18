import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { refundVideoCharge } from './videoCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
// Namespaced per docs/media-generation/README.md's convention. This is a new
// row alongside the old bare 'gemini-omni-1.1-flash' subject in
// packages/foundation/database/seeds/credit-rates.ts and the gateway's own
// VIDEO_MODEL_ALLOWLIST — see Task 7. Never rename the old row in place.
const VIDEO_MODEL = 'google/gemini-omni-1.1-flash'
const GATEWAY_MODEL_ID = 'gemini-omni-1.1-flash' // the bare id the gateway's allowlist/wire format still expects

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

const inputSchema = z.object({
  mode: z.enum(['text_to_video', 'animate_frame', 'composite_references']),
  prompt: z.string().describe('Description of the video to generate'),
  aspectRatio: z.enum(['16:9', '9:16']),
  durationSeconds: z.number().int().min(3).max(10),
  startImageFileId: z.string().optional().describe('Required for animate_frame — an existing files row to use as the literal first frame'),
  referenceFileIds: z.array(z.string()).min(1).max(3).optional().describe('Required for composite_references — identity-anchor images the model builds a new scene around'),
  approvedDialogue: z.string().optional().describe('The exact spoken line the user approved, if the prompt includes quoted dialogue — required to match a quoted line in prompt byte-for-byte'),
}).refine(
  (v) => (v.mode === 'animate_frame') === (v.startImageFileId !== undefined),
  { message: 'startImageFileId is required for animate_frame and only for animate_frame' },
).refine(
  (v) => (v.mode === 'composite_references') === (v.referenceFileIds !== undefined),
  { message: 'referenceFileIds is required for composite_references and only for composite_references' },
)

// Extracts EVERY quoted span, not just the first — a prompt is only clean if
// every quoted span matches the approved line. A first-match-only check would
// let a second, unapproved quoted phrase slip through undetected if the first
// one happened to match.
// Matches straight ASCII double-quotes (the expected/primary case) and also
// curly/smart double-quotes (U+201C/U+201D) as defense in depth — a model
// that renders smart quotes instead of straight ones shouldn't be able to
// bypass the dialogue-approval gate below.
function extractQuotedSpans(prompt: string): string[] {
  return [...prompt.matchAll(/"([^"]+)"|“([^”]+)”/g)].map((m) => m[1] ?? m[2])
}

export const generateVideo = createTool({
  id: 'generate-video',
  description: 'Generates a short video clip from a text description, optionally conditioned on a product/reference image, using Gemini Omni Flash. Use when the user asks Director to create or generate a video.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { mode, prompt, aspectRatio, durationSeconds, startImageFileId, referenceFileIds, approvedDialogue } =
      inputData as z.infer<typeof inputSchema>

    // jobId is derived purely from execContext (no charge or gateway call
    // involved), so it's safe to compute it before the dialogue gate below —
    // this lets every refusal path, including DIALOGUE_NOT_APPROVED, report a
    // jobId without disturbing the charge-before-call ordering.
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    // toolCallId lives on execContext.agent.toolCallId, not execContext.toolCallId
    // and not requestContext — confirmed against @mastra/core's
    // AgentToolExecutionContext type (dist/tools/types.d.ts). Reading the wrong
    // location silently returns 'unknown' every time, which makes chargeKey
    // constant per conversation — spendCredits is idempotent on that key, so
    // every video generation after the first in the same conversation would be
    // free. This was caught by review before implementation; do not read
    // toolCallId from anywhere except execContext.agent.toolCallId.
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    // Content/dialogue approval gate — enforced in tool code, not prose.
    // Director's own instructions (see TEMPLATE_CLONING_SECTION in
    // directorAgent.ts) restrict double-quote marks in the prompt to spoken
    // dialogue only, but this check does NOT trust that rule to always hold —
    // a fresh implementer subagent working on Director's instructions later,
    // or a future edit, could reintroduce a stray quoted phrase. So every
    // quoted span in the prompt is checked, and any mismatch refuses before
    // any charge or gateway call happens.
    const quotedSpans = extractQuotedSpans(prompt)
    if (quotedSpans.some((span) => span !== approvedDialogue)) {
      return { refused: true, refusalReason: 'DIALOGUE_NOT_APPROVED', jobId }
    }

    let imageUri: string | undefined
    if (mode === 'animate_frame' || mode === 'composite_references') {
      if (!idToken) {
        // No idToken means fetchPresignedUrl below can never succeed — without
        // this check the tool would silently skip image resolution, proceed to
        // charge full price, and hand back a text-only result the user
        // believes is product-conditioned. Refuse before any charge happens,
        // same as every other failure in this resolution block.
        return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE', jobId }
      }
      const referenceFileId = startImageFileId ?? referenceFileIds?.[0]
      if (referenceFileId) {
        try {
          imageUri = await fetchPresignedUrl(referenceFileId, idToken)
        } catch (err) {
          console.error(`[session:${sessionId}] generateVideo: failed to resolve reference image ${referenceFileId}:`, (err as Error).message)
          return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE', jobId }
        }
      }
    }

    // Charge BEFORE the vendor call — docs/media-generation/README.md's
    // settled rule. `attempt` is hardcoded to 0 for now, so chargeKey today
    // only guarantees a distinct key per toolCallId — it does NOT yet prevent
    // a refunded-then-retried call from being charged twice. Incrementing
    // `attempt` on retry (so a bare re-execution under the same toolCallId
    // gets a fresh key after a refund) is deferred, per Task 7's original
    // plan text — not implemented here.
    const attempt = 0
    const chargeKey = `video:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('video_generation', VIDEO_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED VIDEO GENERATION: no active video_generation rate for model=${VIDEO_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'video_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    const task = mode === 'text_to_video' ? 'text_to_video' : 'image_to_video'
    let genResult: { videoBase64?: string; mimeType?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/video/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        // No imageMimeType field: the presigned-url resolution above
        // (fetchPresignedUrl, mediaCache.ts) only returns the URL string —
        // apps/api's GET /files/:id/presigned-url route never returns the
        // file's content type, and this codebase has no established pattern
        // for guessing mime type from a URL/filename extension (the
        // extension derivation near the video-upload path below reads it off
        // a real mimeType returned by the gateway, not off a URL). Rather
        // than fabricate a guess, this is left unset; the gateway's
        // stageImageForOmni (apps/inference-gateway/src/video.ts) falls back
        // to 'image/jpeg' when imageMimeType is absent. Fixing this for real
        // requires either the presigned-url route or storageService to
        // surface the stored file's content type.
        body: JSON.stringify({ model: GATEWAY_MODEL_ID, prompt, task, aspectRatio, durationSeconds, imageUri }),
        // Must stay strictly larger than the gateway's own upstream timeout
        // (240s in apps/inference-gateway/src/video.ts) — otherwise this
        // clock, which starts first since the gateway call is nested inside
        // it, can abort before the gateway's Gemini call even completes,
        // discarding a response that might have succeeded.
        signal: AbortSignal.timeout(270_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateVideo gateway call failed:`, (err as Error).message)
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.videoBase64 !== 'string') {
      console.error(`[session:${sessionId}] generateVideo: gateway returned a non-refused response with no videoBase64`)
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    const buffer = Buffer.from(genResult.videoBase64, 'base64')
    const extension = (genResult.mimeType ?? 'video/mp4').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'mp4'
    const attachment = conversationId && idToken
      ? await uploadGeneratedFile(idToken, {
          conversationId, title: 'Generated Video', content: buffer,
          contentType: genResult.mimeType, extension,
        })
      : null

    if (!attachment) {
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      model: VIDEO_MODEL,
      jobId,
    }
  },
})

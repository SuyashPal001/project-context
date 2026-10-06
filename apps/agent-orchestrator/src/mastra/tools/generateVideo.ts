import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fileTitleSchema, fileTitle } from './fileTitle.js'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { resolveAvatarReferences } from './avatarReferences.js'
import { refundVideoCharge } from './videoCredits.js'
import { isReviewedAdFlow, markVideoMade, videoBlockedThisTurn, SHOW_FIRST_REFUSAL } from './oneVideoPerTurn.js'
import { shouldRequireApproval } from './generationApproval.js'
import type { MediaExecContext } from './batchRunner.js'
import { stableToolCallId } from '../../credits.js'
import { emitGenerationStarted } from './generationStarted.js'
import { cleanSpokenStart, recordSpoken } from './spokenScript.js'
import { withIdentityAnchor } from './identityAnchor.js'
import { stripStudioLighting } from './adRealism.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
// Namespaced per docs/media-generation/README.md's convention. This is a new
// row alongside the old bare 'gemini-omni-1.1-flash' subject in
// packages/foundation/database/seeds/credit-rates.ts and the gateway's own
// VIDEO_MODEL_ALLOWLIST — see Task 7. Never rename the old row in place.
export const VIDEO_MODEL = 'google/gemini-omni-1.1-flash'
const GATEWAY_MODEL_ID = 'gemini-omni-1.1-flash' // the bare id the gateway's allowlist/wire format still expects

export const videoOutputSchema = z.object({
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
  interactionId: z.string().optional().describe('Pass as continueFrom (mode "continue") to continue this video with the same person and voice'),
  note: z.string().optional(),
})

export const videoItemSchema = z.object({
  mode: z.enum(['text_to_video', 'animate_frame', 'composite_references', 'continue']),
  prompt: z.string().describe('Description of the video to generate'),
  aspectRatio: z.enum(['16:9', '9:16']),
  durationSeconds: z.number().int().min(3).max(10),
  startImageFileId: z.string().optional().describe('Required for animate_frame — an existing files row to use as the literal first frame'),
  productFileId: z.string().optional().describe('animate_frame only: the product photo. The video is then anchored on [start still, product photo] so the product keeps its material, shape and label (Omni drifted glass to plastic from a start still alone, 2026-10-05)'),
  referenceFileIds: z.array(z.string()).min(1).max(3).optional().describe('Required for composite_references — identity-anchor images the model builds a new scene around. A storyboard sheet may go first: the clip then plays its panels in order as shots (never showing the grid).'),
  continueFrom: z.string().optional().describe('Required for continue — the interactionId a previous generate_video returned. The model continues THAT video (same person, voice, room and light) for durationSeconds more and may speak a new approved line; the result is the whole video so far, not just the new part.'),
  approvedDialogue: z.string().optional().describe('The exact spoken line the user approved, if the prompt includes quoted dialogue — required to match a quoted line in prompt byte-for-byte'),
  identityAnchor: z.object({
    terseTag: z.string(),
    styleLock: z.string(),
  }).optional().describe('When set, both strings are added to the prompt automatically when missing.'),
  title: fileTitleSchema,
}).refine(
  (v) => (v.mode === 'animate_frame') === (v.startImageFileId !== undefined),
  { message: 'startImageFileId is required for animate_frame and only for animate_frame' },
).refine(
  (v) => (v.mode === 'composite_references') === (v.referenceFileIds !== undefined),
  { message: 'referenceFileIds is required for composite_references and only for composite_references' },
).refine(
  (v) => (v.mode === 'continue') === (v.continueFrom !== undefined),
  { message: 'continueFrom is required for continue and only for continue' },
).refine(
  (v) => v.productFileId === undefined || v.mode === 'animate_frame',
  { message: 'productFileId is only for animate_frame' },
)

export const PRODUCT_ANCHOR_PREFIX = 'The first image is the exact opening frame and scene. The second image is the exact product; it stays unchanged and visible — same material, shape, closure and label — the whole time. '

export type VideoItemInput = z.infer<typeof videoItemSchema>

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

// A spoken line needs room to finish. 2026-10-05: a 23-word Hinglish line
// with a laugh got 8s (planned to hit a 15s total) and the video ended
// mid-sentence. Natural Omni speech ran 2.1-2.9 words a second, so a line is
// given at least words / 2.5 seconds (numbers count as two words, "%" as
// one more), within generate_video's 3-10s range.
export function spokenSecondsFloor(line: string): number {
  const words = line.replace(/<[^>]+>/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  const count = words.reduce((n, w) => n + (/\d/.test(w) ? 2 : 1) + (w.includes('%') ? 1 : 0), 0)
  return Math.min(10, Math.max(3, Math.ceil(count / 2.5)))
}

/** Seconds for a spoken part: at least the line's floor, at most one more. */
export function spokenSeconds(line: string, requested: number): number {
  const floor = spokenSecondsFloor(line)
  return Math.min(10, Math.max(floor, Math.min(requested, floor + 1)))
}

export async function generateVideoItem(
  inputData: VideoItemInput,
  execContext: MediaExecContext | undefined,
  itemIndex: number,
) {
    const { mode, prompt: rawPrompt, aspectRatio, durationSeconds: requestedSeconds, startImageFileId, productFileId, referenceFileIds, approvedDialogue, identityAnchor, continueFrom } =
      inputData
    // A spoken part gets the time its line needs, not the time left over in
    // the ad: too little cut the sentence off, too much (8s for a 5s line,
    // 2026-10-05) made Omni fill it with a mid-line pause and a silent smile.
    const durationSeconds = approvedDialogue ? spokenSeconds(approvedDialogue, requestedSeconds) : requestedSeconds

    // jobId is derived purely from execContext (no charge or gateway call
    // involved), so it's safe to compute it before the dialogue gate below —
    // this lets every refusal path, including DIALOGUE_NOT_APPROVED, report a
    // jobId without disturbing the charge-before-call ordering.
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    // Left undefined (not defaulted to '') when the caller's requestContext
    // doesn't set agentId — spendCredits' own actorId param does `?? null`
    // internally, so undefined becomes a real SQL NULL and casts cleanly to
    // ::uuid. An empty string is neither null nor undefined, so it would
    // bypass that safety net and hit Postgres as `''::uuid`, which throws
    // "invalid input syntax for type uuid" and aborts the whole charge
    // before the gateway is ever called — this is exactly what happened
    // when driven from a caller that doesn't populate agentId (confirmed
    // live via Mastra Studio's minimal test harness, but the same crash
    // would hit any real caller with the same gap).
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
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
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    // Content/dialogue approval gate — enforced in tool code, not prose.
    // Director's own instructions (see TEMPLATE_CLONING_SECTION in
    // directorAgent.ts) restrict double-quote marks in the prompt to spoken
    // dialogue only, but this check does NOT trust that rule to always hold —
    // a fresh implementer subagent working on Director's instructions later,
    // or a future edit, could reintroduce a stray quoted phrase. So every
    // quoted span in the prompt is checked, and any mismatch refuses before
    // any charge or gateway call happens.
    const quotedSpans = extractQuotedSpans(rawPrompt)
    if (quotedSpans.some((span) => span !== approvedDialogue)) {
      return { refused: true, refusalReason: 'DIALOGUE_NOT_APPROVED', jobId }
    }

    // Identity anchor: a missing terseTag/styleLock is added, not refused —
    // a refusal here comes after the user already approved the paid card.
    const spokenLine = approvedDialogue ? cleanSpokenStart(approvedDialogue) : undefined
    const spokenPrompt = approvedDialogue && spokenLine !== approvedDialogue ? rawPrompt.split(`"${approvedDialogue}"`).join(`"${spokenLine}"`) : rawPrompt
    const anchored = withIdentityAnchor(spokenPrompt, identityAnchor)
    const prompt = isReviewedAdFlow(execContext?.agent?.messages) ? stripStudioLighting(anchored) : anchored

    // Not a refusal — a reference image without identityAnchor is legitimate
    // (e.g. a b-roll beat), but it's also exactly what an accidentally-omitted
    // identityAnchor looks like. Flag it so a trace review can spot omissions.
    if ((startImageFileId || referenceFileIds?.length) && !identityAnchor) {
      console.warn(`[session:${sessionId}] generateVideo: reference image set with no identityAnchor — verify this omission was intentional`)
    }

    let imageUri: string | undefined
    let referenceImageUris: string[] | undefined
    if (mode === 'animate_frame' || mode === 'composite_references') {
      if (!idToken) {
        // No idToken means fetchPresignedUrl below can never succeed — without
        // this check the tool would silently skip image resolution, proceed to
        // charge full price, and hand back a text-only result the user
        // believes is product-conditioned. Refuse before any charge happens,
        // same as every other failure in this resolution block.
        return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE', jobId }
      }
      // composite_references sends every reference to Omni's reference_to_video
      // (up to 3), with a saved avatar's character sheet added right after its
      // portrait, the same way generate_image does. It used to send only the
      // first reference as an image_to_video start frame, so the model pinned
      // that still as frame one instead of building a new scene around it.
      if (mode === 'composite_references' && referenceFileIds?.length) {
        const ids = (await resolveAvatarReferences(tenantId, referenceFileIds)).fileIds.slice(0, 3)
        try {
          referenceImageUris = await Promise.all(ids.map((id) => fetchPresignedUrl(id, idToken)))
        } catch (err) {
          console.error(`[session:${sessionId}] generateVideo: failed to resolve reference images ${ids.join(',')}:`, (err as Error).message)
          return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE', jobId }
        }
      }
      const referenceFileId = mode === 'animate_frame' ? startImageFileId : undefined
      if (referenceFileId) {
        try {
          imageUri = await fetchPresignedUrl(referenceFileId, idToken)
        } catch (err) {
          console.error(`[session:${sessionId}] generateVideo: failed to resolve reference image ${referenceFileId}:`, (err as Error).message)
          return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE', jobId }
        }
      }
      if (mode === 'animate_frame' && productFileId && imageUri) {
        try {
          referenceImageUris = [imageUri, await fetchPresignedUrl(productFileId, idToken)]
          imageUri = undefined
        } catch (err) {
          console.error(`[session:${sessionId}] generateVideo: failed to resolve product image ${productFileId}:`, (err as Error).message)
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
    // plan text — not implemented here. In a batch call the item index
    // occupies this slot so each item has its own key; the single tool
    // passes 0. If a retry counter is ever added, this key needs a different
    // shape (e.g. a :r<attempt> suffix) so item 1 / attempt 0 cannot collide
    // with item 0 / attempt 1.
    const attempt = itemIndex
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

    const task = mode === 'text_to_video' ? 'text_to_video' : (mode === 'composite_references' || referenceImageUris?.length) ? 'reference_to_video' : 'image_to_video'
    const sentPrompt = referenceImageUris?.length && mode === 'animate_frame' ? PRODUCT_ANCHOR_PREFIX + prompt : prompt
    let genResult: { videoBase64?: string; mimeType?: string; interactionId?: string; refused?: boolean; reason?: string }
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
        body: JSON.stringify({ model: GATEWAY_MODEL_ID, prompt: sentPrompt, task, aspectRatio, durationSeconds, imageUri, referenceImageUris, ...(mode === 'continue' ? { previousInteractionId: continueFrom } : {}) }),
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
      const reason = genResult.reason === 'CONTENT_BLOCKED' ? "CONTENT_BLOCKED: rephrase the shot (no ages or minors' activities)" : (genResult.reason ?? 'unknown')
      return { refused: true, refusalReason: reason, jobId }
    }

    if (typeof genResult.videoBase64 !== 'string') {
      console.error(`[session:${sessionId}] generateVideo: gateway returned a non-refused response with no videoBase64`)
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    // Distinguish "no session to save into" (expected for a caller with no
    // real conversation/auth — e.g. Mastra Studio's test harness, which has
    // no browser session) from "a real upload attempt failed" (a genuine
    // storage/network/auth problem worth investigating). Both used to
    // collapse into the same STORAGE_FAILED code, which cost real debugging
    // time chasing a "storage outage" that was actually just a missing
    // session — see generateVideo.test.ts for the regression test.
    if (!conversationId || !idToken) {
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = Buffer.from(genResult.videoBase64, 'base64')
    const extension = (genResult.mimeType ?? 'video/mp4').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'mp4'
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: fileTitle(inputData.title, 'Generated Video'), content: buffer,
      contentType: genResult.mimeType, extension,
    })

    if (!attachment) {
      if (charged) await refundVideoCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    if (conversationId) recordSpoken(conversationId, { continueFrom, approvedDialogue: spokenLine, interactionId: genResult.interactionId, fileId: attachment.fileId })

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      model: VIDEO_MODEL,
      jobId,
      ...(genResult.interactionId ? { interactionId: genResult.interactionId } : {}),
      // The user saw "part 2" replay part 1 and thought it was a duplicate (2026-10-05).
      ...(mode === 'continue' ? { note: 'This file is the whole ad so far (every part up to this one), not only the new part. Show it as "the ad so far", never as a separate part.' } : {}),
    }
}

export const generateVideo = createTool({
  id: 'generate-video',
  description: 'Generates a short video clip from a text description, optionally conditioned on a product/reference image, using Gemini Omni Flash. Use when the user asks Director to create or generate a video.',
  inputSchema: videoItemSchema,
  outputSchema: videoOutputSchema,
  requireApproval: async (_input, ctx) =>
    !videoBlockedThisTurn(ctx?.requestContext) && shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    if (videoBlockedThisTurn(execContext?.requestContext)) return SHOW_FIRST_REFUSAL
    emitGenerationStarted(execContext, { aspectRatio: (inputData as { aspectRatio?: unknown }).aspectRatio })
    const result = await generateVideoItem(inputData as VideoItemInput, execContext as unknown as MediaExecContext, 0)
    if ((result as { fileId?: string }).fileId) markVideoMade(execContext?.requestContext, (execContext as unknown as { agent?: { messages?: unknown } })?.agent?.messages)
    return result
  },
})

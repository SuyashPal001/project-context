import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundCompositeEndCardCharge } from './compositeEndCardCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'
import { chooseCardColumn, faceBoxes, gatewayAsk, sampleFrames } from './tvcChecks.js'

const execFile = promisify(execFileCb)

const COMPOSITE_SUBJECT = 'ffmpeg-composite-end-card'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// How long before the clip's own end the real photo dissolves in — a
// fixed value for v1 rather than scene-cut detection (the spec's
// pseudocode scene-detects the cut; this simplifies to "the last N
// seconds of the beat" which is safe because animation-character's beat
// 4 is always the payoff/CTA beat, always ends on a hold).
const DISSOLVE_WINDOW_SECONDS = 1.5
const DISSOLVE_DURATION_SECONDS = 0.4

/** O1: the column an end card's fitted box sits in, and its ffmpeg overlay x
 * expression — a side third stays clear of a face detected in the other two
 * thirds (see chooseCardColumn in tvcChecks.ts). */
export function cardOverlayX(column: 'center' | 'left' | 'right'): string {
  return column === 'left' ? 'W*0.04' : column === 'right' ? 'W-w-W*0.04' : '(W-w)/2'
}

/** A full-frame card: the photo blurred and dimmed to fill the frame behind
 * the photo itself, fitted to 86% of the width. Scaling the photo alone left
 * a white-backed product shot pasted as a box over the scene (2026-10-05).
 * `card`, when given (O1, avoidFaces with a face detected), overrides the
 * fitted box's size and horizontal position so it sits in a side third away
 * from the face instead of the default centered 86%-width box. */
export function endCardGraph(width: number, height: number, dissolveStart: number, holdSeconds = 0, card?: { scale: string; x: string }): string {
  const fit = Math.round(width * 0.86 / 2) * 2
  // holdSeconds > 0: the clip's last frame holds that long and the card comes
  // in over the hold, so it never covers a presenter's last words.
  const base = holdSeconds > 0 ? `[0:v]tpad=stop_mode=clone:stop_duration=${holdSeconds}[base];` : ''
  const baseLabel = holdSeconds > 0 ? '[base]' : '[0:v]'
  // F2: when a face override is in effect (avoidFaces found a face and chose
  // a side column or shrink), the full-frame blurred [bg] layer is dropped —
  // it is opaque and fills the whole frame, so even a shrunk, side-column
  // [fg] sitting on top of it still hides the face underneath. The override
  // lays the scaled [fg] straight over the base video instead (the pre-merge
  // shape). With no override, the default centred 86% card with [bg] is
  // unchanged.
  if (card) {
    return base + `[1:v]scale=${card.scale}:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=${dissolveStart}:d=${DISSOLVE_DURATION_SECONDS}:alpha=1[card];` +
      `${baseLabel}[card]overlay=${card.x}:(H-h)/2:enable='gte(t,${dissolveStart})'[outv]`
  }
  return base + `[1:v]split[bgsrc][fgsrc];` +
    `[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=40:2,eq=brightness=-0.12[bg];` +
    `[fgsrc]scale=${fit}:${height}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba,fade=t=in:st=${dissolveStart}:d=${DISSOLVE_DURATION_SECONDS}:alpha=1[card];` +
    `${baseLabel}[card]overlay=0:0:enable='gte(t,${dissolveStart})'[outv]`
}

// Deviation from the spec, stated explicitly per the writing-plans
// self-review rule: the spec asks for the end card to be "matched in
// scale to the rendered product's bounding box" with "background color
// sampled and matched to avoid a visible seam." v1 does neither — it
// scales the real photo to fit the full frame (against the base clip's
// actual probed dimensions — see the ffprobe call below, not a hardcoded
// nominal size) with `force_original_aspect_ratio=decrease` and centers
// it, with no bounding-box detection or background color matching.
// Bounding-box detection needs either a vision-model call (a new
// charge-bearing step this plan doesn't budget for) or manual coordinates
// nothing upstream currently produces. Full-frame centered against the
// clip's real dimensions is correctly scaled and positioned in all cases;
// the only remaining visible artifact is a possible background seam where
// the photo's own background meets the animated frame behind it. Revisit
// if a real ad's end card looks bad in testing, not preemptively.

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('Beat 4\'s muxed (audio-bearing) clip.'),
  productPhotoFileId: z.string().describe('The real, unedited product photo — never an AI-rendered one, to avoid wordmark garbling.'),
  aspectRatio: z.enum(['16:9', '9:16']),
  holdSeconds: z.number().min(0).max(3).optional().describe('For an ad that ends on speech (UGC, talking-head): seconds added after the video ends, its last frame held, with the card dissolving in as the video ends, so the card never covers the last words. Omit for the animated ad\'s beat 4.'),
  avoidFaces: z.boolean().optional().describe('When a person is on the last frame, shrink the card to a third and put it beside them, never over a face'),
})

export const compositeEndCard = createTool({
  id: 'composite-end-card',
  description: 'Overlays the real product photo onto the last beat\'s clip, dissolving in over its final second and a half — the end card is always composited from the real photo, never AI-rendered, to avoid wordmark/brand-name garbling. Animated ad: run BEFORE assemble_clips, on beat 4 only. UGC or talking-head ad: run on the finished (tightened) ad with holdSeconds 1.5, so the card follows the last words.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: COMPOSITE_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, productPhotoFileId, aspectRatio, holdSeconds = 0, avoidFaces } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string, photoPath: string
    try {
      const [videoUrl, photoUrl] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(productPhotoFileId, idToken),
      ])
      ;[{ filePath: videoPath }, { filePath: photoPath }] = await Promise.all([
        downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES),
        downloadToSessionCache(scopeId, productPhotoFileId, photoUrl, MAX_SOURCE_BYTES),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `composite-end-card:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', COMPOSITE_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED COMPOSITE-END-CARD: no active clip_assembly/${COMPOSITE_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'clip_assembly',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'end-card-'))
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'COMPOSITE_FAILED', jobId }
    }
    const outputPath = join(workDir, 'carded.mp4')
    try {
      // Probe duration AND the base clip's real pixel dimensions in one
      // call. Nothing upstream normalizes resolution before this tool runs
      // — mux_beat_audio preserves the source clip's actual dimensions (no
      // scale filter) and assemble_clips is where normalization to the
      // nominal aspectRatio size finally happens, but that runs AFTER this
      // tool in the pipeline. Scaling the card to the nominal 1920x1080 /
      // 1080x1920 constants instead of the clip's real dimensions was a
      // real, reproduced bug: whenever generate_video's actual output
      // isn't exactly that nominal size, the card gets scaled to the wrong
      // size and overlaid at the wrong (often negative) offsets onto a
      // differently-sized base, silently cropping the product photo's
      // edges — exactly the wordmark/brand-edge content this tool exists
      // to protect. The card must always be scaled against [0:v]'s real
      // width/height, never the aspectRatio constants.
      const { stdout: probeOut } = await execFile('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json', videoPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const probe = JSON.parse(probeOut) as {
        streams?: Array<{ width?: number; height?: number }>
        format?: { duration?: string }
      }
      const clipDurationSeconds = parseFloat(probe.format?.duration ?? '')
      if (!(clipDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${probeOut}`)
      const dissolveStart = holdSeconds > 0 ? Math.max(0, clipDurationSeconds - 0.1) : Math.max(0, clipDurationSeconds - DISSOLVE_WINDOW_SECONDS)
      const totalSeconds = clipDurationSeconds + holdSeconds

      // Nominal aspectRatio dimensions are only a fallback for the
      // (expected-never) case where ffprobe doesn't report stream
      // dimensions — the real scale target is always the probed clip size.
      const [nominalW, nominalH] = aspectRatio === '9:16' ? [1080, 1920] : [1920, 1080]
      const probedW = probe.streams?.[0]?.width
      const probedH = probe.streams?.[0]?.height
      if (!probedW || !probedH) {
        console.error(`[session:${sessionId}] compositeEndCard: ffprobe returned no stream dimensions, falling back to nominal ${nominalW}x${nominalH}:`, probeOut)
      }
      const videoWidth = probedW || nominalW
      const videoHeight = probedH || nominalH

      // O1: a face on the last frame keeps the card from covering it — shrink
      // to a third and move it into whichever side third is clear. Any
      // failure here (gateway, sampling, parse) keeps the default centered
      // 86%-width card; it must never fail the composite.
      let cardOverride: { scale: string; x: string } | undefined
      if (avoidFaces) {
        try {
          const [frame] = await sampleFrames(videoPath, [Math.min(clipDurationSeconds - 0.05, dissolveStart + 0.2)], workDir)
          const faces = await faceBoxes(gatewayAsk(tenantId), frame)
          if (faces.length) {
            const column = chooseCardColumn(faces)
            const cardScale = `${Math.round(videoWidth / 3)}:${Math.round(videoHeight * 0.8)}`
            cardOverride = { scale: cardScale, x: cardOverlayX(column) }
          }
        } catch (err) {
          console.warn(`[session:${sessionId}] compositeEndCard: face check failed, keeping the centred card:`, (err as Error).message)
        }
      }

      const filterComplex = endCardGraph(videoWidth, videoHeight, dissolveStart, holdSeconds, cardOverride)

      // A plain image input (-i photoPath with no -loop) is a single frame
      // at PTS 0 with no real duration — fade's st=/d= timestamps and
      // overlay's enable='gte(t,...)' gate never see the timeline moving,
      // so the card either never appears or appears fully transparent
      // forever. -loop 1 -framerate 30 -t <clip duration> turns it into a
      // real video-length input with real timestamps BEFORE it's fed into
      // the filter graph — this flag placement matters: it must come
      // before this -i, not after.
      await execFile('ffmpeg', [
        '-y', '-i', videoPath,
        '-loop', '1', '-framerate', '30', '-t', String(totalSeconds), '-i', photoPath,
        '-filter_complex', filterComplex,
        '-map', '[outv]', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        ...(holdSeconds > 0 ? ['-af', `apad=pad_dur=${holdSeconds}`, '-c:a', 'aac', '-b:a', '192k', '-t', String(totalSeconds)] : ['-c:a', 'copy']),
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'COMPOSITE_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: failed to read output:`, (err as Error).message)
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'COMPOSITE_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Beat with End Card', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundCompositeEndCardCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})

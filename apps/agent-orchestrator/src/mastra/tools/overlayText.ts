import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundOverlayTextCharge } from './overlayTextCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'

const execFile = promisify(execFileCb)

const OVERLAY_SUBJECT = 'ffmpeg-overlay-text'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
const MAX_TEXT_LENGTH = 200

// Font sizes are in ASS PlayRes units (1080x1920 canvas), which libass
// scales to the real frame — so text is visually smaller on landscape
// video than on portrait.
const FONT_SIZES = { small: 64, medium: 88, large: 120 } as const
// ASS numpad alignment: 2 = bottom-center, 5 = middle-center, 8 = top-center.
const ALIGNMENTS = { bottom: 2, center: 5, top: 8 } as const

export interface TextOverlay {
  text: string
  startSeconds: number
  endSeconds: number
  position: keyof typeof ALIGNMENTS
  size?: keyof typeof FONT_SIZES
}

// Copy goes into an ASS Dialogue line, never into an inline ffmpeg filter
// argument (drawtext's text= quoting is what breaks on apostrophes and
// colons). Inside ASS text the only special syntax is `{...}` override
// blocks and backslash escapes; the text field is the last comma-delimited
// field, so commas in it are safe.
export function escapeAssText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .trim()
}

export function formatAssTimestamp(seconds: number): string {
  const totalCs = Math.round(Math.max(0, seconds) * 100)
  const h = Math.floor(totalCs / 360_000)
  const m = Math.floor((totalCs % 360_000) / 6_000)
  const s = Math.floor((totalCs % 6_000) / 100)
  const cs = totalCs % 100
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

export function buildAss(overlays: TextOverlay[]): string {
  const styles = (Object.keys(ALIGNMENTS) as (keyof typeof ALIGNMENTS)[])
    .flatMap((pos) => (Object.keys(FONT_SIZES) as (keyof typeof FONT_SIZES)[]).map((size) =>
      `Style: ${pos}-${size},DejaVu Sans,${FONT_SIZES[size]},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,${ALIGNMENTS[pos]},60,60,${pos === 'center' ? 0 : 160},1`))
  const events = overlays.map((o) =>
    `Dialogue: 0,${formatAssTimestamp(o.startSeconds)},${formatAssTimestamp(o.endSeconds)},${o.position}-${o.size ?? 'medium'},,0,0,0,,${escapeAssText(o.text)}`)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    '',
  ].join('\n')
}

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

export const inputSchema = z.object({
  videoFileId: z.string().describe('The finished video to overlay text onto. Text is composited in post, never rendered by the generation model.'),
  overlays: z.array(z.object({
    text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('The on-screen copy, e.g. a hook line. Plain text; no markup.'),
    startSeconds: z.number().min(0),
    endSeconds: z.number().min(0),
    position: z.enum(['top', 'center', 'bottom']),
    size: z.enum(['small', 'medium', 'large']).optional().describe('Defaults to medium.'),
  }).refine((o) => o.endSeconds > o.startSeconds, { message: 'endSeconds must be greater than startSeconds' }))
    .min(1).max(12),
})

export const overlayText = createTool({
  id: 'overlay-text',
  description: 'Burns one or more timed text overlays (e.g. hook copy) onto an existing video at a chosen position and time window. Composited in post over a clean plate — on-screen text is never baked into generation, so a copy edit is a re-run of this tool, not a re-render. Heavy sans-serif, white fill, dark outline.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: OVERLAY_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, overlays } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    // Defense in depth: a direct execute() call bypasses schema validation.
    if (overlays.some((o) => !(o.endSeconds > o.startSeconds) || !escapeAssText(o.text))) {
      return { refused: true, refusalReason: 'INVALID_OVERLAY', jobId }
    }

    const scopeId = tenantId || sessionId
    let videoPath: string
    try {
      const videoUrl = await fetchPresignedUrl(videoFileId, idToken)
      ;({ filePath: videoPath } = await downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES))
    } catch (err) {
      console.error(`[session:${sessionId}] overlayText: failed to download source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `overlay-text:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', OVERLAY_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED OVERLAY-TEXT: no active clip_assembly/${OVERLAY_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
      workDir = mkdtempSync(join(tmpdir(), 'overlay-text-'))
    } catch (err) {
      console.error(`[session:${sessionId}] overlayText: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundOverlayTextCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'OVERLAY_FAILED', jobId }
    }
    const outputPath = join(workDir, 'overlaid.mp4')
    try {
      const assPath = join(workDir, 'overlay.ass')
      writeFileSync(assPath, buildAss(overlays))
      const escapedAssPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
      await execFile('ffmpeg', [
        '-y', '-i', videoPath,
        '-vf', `subtitles=${escapedAssPath}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] overlayText: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundOverlayTextCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      // Same libass-less-ffmpeg detection as burnCaptions.ts.
      const stderr = (err as { stderr?: string }).stderr ?? ''
      if (
        stderr.includes("filterchain 'subtitles=") ||
        stderr.includes("No such filter: 'subtitles'") ||
        stderr.includes("Unknown filter 'subtitles'")
      ) {
        return { refused: true, refusalReason: 'SUBTITLES_FILTER_UNAVAILABLE', jobId }
      }
      return { refused: true, refusalReason: 'OVERLAY_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundOverlayTextCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] overlayText: failed to read output:`, (err as Error).message)
      if (charged) await refundOverlayTextCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'OVERLAY_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Video with Text Overlay', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundOverlayTextCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})

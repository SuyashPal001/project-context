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
import { refundTrimClipCharge } from './trimClipCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'

const execFile = promisify(execFileCb)

const TRIM_SUBJECT = 'ffmpeg-trim-clip'
// Matches assembleClips.ts's own raised value (Task 2) — this tool takes
// the same class of input (real uploaded camera footage, up to 500MB),
// and output-side -ss/-to seeking (see below) decodes the whole file up
// to the in-point before it can start trimming, so a long source clip
// needs the same generous margin.
const FFMPEG_TIMEOUT_MS = 180_000
const MAX_SOURCE_BYTES = 500 * 1024 * 1024

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

// Exported raw so tests can .safeParse() it directly — createTool's wrapped
// type has no .safeParse (see this plan's Global Constraints).
export const inputSchema = z.object({
  sourceFileId: z.string().describe('An uploaded footage clip to trim a segment from.'),
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
}).refine((v) => v.endSeconds > v.startSeconds, { message: 'endSeconds must be greater than startSeconds' })

export const trimClip = createTool({
  id: 'trim-clip',
  description: 'Trims one uploaded footage clip to an in/out segment, producing a new clip. Used in short-drama-stitch to cut down a selected segment from a larger uploaded clip before assembly.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: TRIM_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { sourceFileId, startSeconds, endSeconds } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let sourcePath: string
    try {
      const presignedUrl = await fetchPresignedUrl(sourceFileId, idToken)
      ;({ filePath: sourcePath } = await downloadToSessionCache(scopeId, sourceFileId, presignedUrl, MAX_SOURCE_BYTES))
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to download source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Probe-before-trim: Mode A's AI-proposed timestamps are approximate
    // (see analyzeVideo.ts's timestamp labeling), so this is the real
    // correctness backstop, not just defensive padding. Also checks for an
    // audio stream up front — a source clip with no audio produces a
    // video-only trimmed output that would only fail later, inside
    // assemble_clips's MISSING_AUDIO_STREAM path, AFTER this tool (and
    // potentially several sibling trim_clip calls) has already been
    // charged. Refusing here instead avoids charging for a trim whose
    // output can never be used downstream (short-drama-stitch always sets
    // preserveAudio: true).
    let sourceDurationSeconds: number
    let hasAudioStream: boolean
    try {
      const { stdout: probeOut } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', sourcePath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const probe = JSON.parse(probeOut) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> }
      sourceDurationSeconds = parseFloat(probe.format?.duration ?? '')
      if (!(sourceDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${probeOut}`)
      hasAudioStream = (probe.streams ?? []).some(s => s.codec_type === 'audio')
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to probe source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }
    if (endSeconds > sourceDurationSeconds) {
      return { refused: true, refusalReason: 'INVALID_TRIM_RANGE', jobId }
    }
    if (!hasAudioStream) {
      return { refused: true, refusalReason: 'MISSING_AUDIO_STREAM', jobId }
    }

    // Charge BEFORE running ffmpeg — same settled ordering as every other
    // generation tool.
    const attempt = 0
    const chargeKey = `trim-clip:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', TRIM_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED TRIM-CLIP: no active clip_assembly/${TRIM_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
      workDir = mkdtempSync(join(tmpdir(), 'trim-clip-'))
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'TRIM_FAILED', jobId }
    }
    const outputPath = join(workDir, 'trimmed.mp4')
    try {
      // Output-side seeking (-ss/-to after -i) for frame-accurate trims —
      // input-side seeking (-ss before -i) is faster but can land on the
      // wrong keyframe, which matters here since trim points come from
      // approximate AI-proposed timestamps as often as exact user ones.
      await execFile('ffmpeg', [
        '-y', '-i', sourcePath,
        '-ss', String(startSeconds), '-to', String(endSeconds),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'TRIM_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] trimClip: failed to read output:`, (err as Error).message)
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'TRIM_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Trimmed Clip', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundTrimClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})

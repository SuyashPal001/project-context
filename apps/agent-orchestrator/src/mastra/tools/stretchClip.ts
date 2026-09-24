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
import { refundStretchClipCharge } from './stretchClipCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'

const execFile = promisify(execFileCb)

const STRETCH_SUBJECT = 'ffmpeg-stretch-clip'
const FFMPEG_TIMEOUT_MS = 120_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
const MAX_TARGET_SECONDS = 120
// Past ~2x slow-down, interpolated motion visibly degrades into slideshow.
const MAX_SLOW_FACTOR = 2
// Guards a tiny source from being looped hundreds of times.
const MAX_LOOP_RATIO = 30

export type StretchMode = 'loop' | 'slow' | 'hold'

export type StretchPlan =
  | { ok: true; args: string[] }
  | { ok: false; reason: 'TARGET_NOT_LONGER' | 'STRETCH_TOO_LARGE' }

// Every value interpolated into the ffmpeg arguments below is a number
// computed here from ffprobe output and the validated target — no
// caller-supplied string ever reaches a filter graph.
export function buildStretchArgs(opts: {
  mode: StretchMode
  sourcePath: string
  outputPath: string
  sourceSeconds: number
  targetSeconds: number
  hasAudio: boolean
}): StretchPlan {
  const { mode, sourcePath, outputPath, sourceSeconds, targetSeconds, hasAudio } = opts
  if (!(targetSeconds > sourceSeconds)) return { ok: false, reason: 'TARGET_NOT_LONGER' }
  const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
  const t = targetSeconds.toFixed(3)

  if (mode === 'loop') {
    if (targetSeconds / sourceSeconds > MAX_LOOP_RATIO) return { ok: false, reason: 'STRETCH_TOO_LARGE' }
    // -stream_loop repeats video and audio together, hard-cut at the seam.
    return {
      ok: true,
      args: ['-y', '-stream_loop', '-1', '-i', sourcePath, '-t', t, ...encode, ...(hasAudio ? ['-c:a', 'aac'] : ['-an']), outputPath],
    }
  }

  if (mode === 'slow') {
    const factor = targetSeconds / sourceSeconds
    if (factor > MAX_SLOW_FACTOR) return { ok: false, reason: 'STRETCH_TOO_LARGE' }
    // atempo accepts 0.5–2.0, so 1/factor is always in range here.
    return {
      ok: true,
      args: [
        '-y', '-i', sourcePath,
        '-vf', `setpts=${factor.toFixed(6)}*PTS`,
        ...(hasAudio ? ['-af', `atempo=${(1 / factor).toFixed(6)}`, '-c:a', 'aac'] : ['-an']),
        '-t', t, ...encode, outputPath,
      ],
    }
  }

  // hold: freeze the last frame; any audio plays once then goes silent. Pad by the
  // full target, not target - source: the video stream can be shorter than the
  // container duration, and -t trims the excess.
  const pad = targetSeconds.toFixed(3)
  return {
    ok: true,
    args: [
      '-y', '-i', sourcePath,
      '-vf', `tpad=stop_mode=clone:stop_duration=${pad}`,
      ...(hasAudio ? ['-af', 'apad', '-c:a', 'aac'] : ['-an']),
      '-t', t, ...encode, outputPath,
    ],
  }
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
  videoFileId: z.string().describe('The existing clip to lengthen.'),
  targetDurationSeconds: z.number().positive().max(MAX_TARGET_SECONDS).describe('Desired final length in seconds; must be longer than the source clip.'),
  mode: z.enum(['loop', 'slow', 'hold']).describe('loop = repeat the clip (audio repeats too, hard cut at the seam); slow = slow it down, only up to 2x the original length; hold = freeze the last frame (audio plays once then silence).'),
})

export const stretchClip = createTool({
  id: 'stretch-clip',
  description: 'Lengthens an existing clip to a target duration without generating anything new: loop repeats it, slow slows it down (max 2x), hold freezes the last frame. A cheap way to fill a longer runtime from a short clip. Cannot shorten — use trim_clip for that.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: STRETCH_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, targetDurationSeconds, mode } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    // Defense in depth: a direct execute() call bypasses schema validation.
    if (!(targetDurationSeconds > 0) || targetDurationSeconds > MAX_TARGET_SECONDS || !['loop', 'slow', 'hold'].includes(mode)) {
      return { refused: true, refusalReason: 'INVALID_TARGET', jobId }
    }

    const scopeId = tenantId || sessionId
    let sourcePath: string
    try {
      const url = await fetchPresignedUrl(videoFileId, idToken)
      ;({ filePath: sourcePath } = await downloadToSessionCache(scopeId, videoFileId, url, MAX_SOURCE_BYTES))
    } catch (err) {
      console.error(`[session:${sessionId}] stretchClip: failed to download source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    let sourceSeconds: number
    let hasAudio: boolean
    try {
      const { stdout } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', sourcePath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const probe = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> }
      sourceSeconds = parseFloat(probe.format?.duration ?? '')
      if (!(sourceSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${stdout}`)
      hasAudio = (probe.streams ?? []).some((s) => s.codec_type === 'audio')
    } catch (err) {
      console.error(`[session:${sessionId}] stretchClip: failed to probe source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Validate before charging: a refusal here must cost nothing.
    const preflight = buildStretchArgs({ mode, sourcePath, outputPath: 'unused.mp4', sourceSeconds, targetSeconds: targetDurationSeconds, hasAudio })
    if (!preflight.ok) return { refused: true, refusalReason: preflight.reason, jobId }

    const chargeKey = `stretch-clip:${jobId}:0`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', STRETCH_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED STRETCH-CLIP: no active clip_assembly/${STRETCH_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
    const refund = async () => {
      if (charged) await refundStretchClipCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
    }

    if (!conversationId) {
      await refund()
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'stretch-clip-'))
    } catch (err) {
      console.error(`[session:${sessionId}] stretchClip: failed to create temp dir:`, (err as Error).message)
      await refund()
      return { refused: true, refusalReason: 'STRETCH_FAILED', jobId }
    }
    const outputPath = join(workDir, 'stretched.mp4')
    try {
      const plan = buildStretchArgs({ mode, sourcePath, outputPath, sourceSeconds, targetSeconds: targetDurationSeconds, hasAudio })
      if (!plan.ok) throw new Error(plan.reason)
      await execFile('ffmpeg', plan.args, { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] stretchClip: ffmpeg failed:`, (err as Error).message)
      await refund()
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'STRETCH_FAILED', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] stretchClip: failed to read output:`, (err as Error).message)
      await refund()
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'STRETCH_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Stretched Clip', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      await refund()
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})

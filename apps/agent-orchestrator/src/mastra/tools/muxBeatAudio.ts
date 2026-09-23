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
import { refundMuxBeatAudioCharge } from './muxBeatAudioCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const MUX_SUBJECT = 'ffmpeg-mux-audio'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// Matches the source spec's trim rule: each beat's clip is trimmed to its
// own narration length plus this much air, never the reverse.
const TRIM_PAD_SECONDS = 0.5

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

// Exported raw (not just wrapped in the tool) so a test can call .safeParse
// on it directly — see this plan's Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('A silent beat clip from generate_video.'),
  audioFileId: z.string().describe('That beat\'s narration line from generate_narration.'),
})

export const muxBeatAudio = createTool({
  id: 'mux-beat-audio',
  description: 'Muxes one narration audio line onto one silent beat clip, trimming the clip to the audio\'s length plus 0.5s. Used per-beat in animation-character for beats that carry VO rather than lip-synced dialogue — never for the hook beat, which uses lipsync instead.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: MUX_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, audioFileId } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string, audioPath: string
    try {
      const [videoUrl, audioUrl] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(audioFileId, idToken),
      ])
      ;[{ filePath: videoPath }, { filePath: audioPath }] = await Promise.all([
        downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES),
        downloadToSessionCache(scopeId, audioFileId, audioUrl, MAX_SOURCE_BYTES),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Charge BEFORE running ffmpeg — same settled ordering as every other
    // generation tool.
    const attempt = 0
    const chargeKey = `mux-beat-audio:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', MUX_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED MUX-BEAT-AUDIO: no active clip_assembly/${MUX_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
      workDir = mkdtempSync(join(tmpdir(), 'mux-beat-'))
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'MUX_FAILED', jobId }
    }
    const outputPath = join(workDir, 'muxed.mp4')
    try {
      const { stdout: durationOut } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const audioDurationSeconds = parseFloat(durationOut.trim())
      if (!(audioDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${durationOut}`)
      const targetSeconds = audioDurationSeconds + TRIM_PAD_SECONDS

      // Same tpad-then-truncate trick assembleClips.ts already validated
      // live: tpad pads BY targetSeconds (not TO it), so the trailing -t
      // is what truncates to the actual target — both must stay present.
      // The audio side needs the same treatment: apad extends it with
      // silence to at least targetSeconds so -t's truncation has real
      // (silent, not absent) audio to cut to. Do NOT add -shortest here —
      // -shortest ends the output at the SHORTER stream, which is the
      // original (unpadded) audio length, silently defeating the whole
      // point of this trim/pad — the output would end at the audio's
      // original duration, never reaching targetSeconds.
      const filterComplex = `[0:v]fps=30,tpad=stop_mode=clone:stop_duration=${targetSeconds}[v]; [1:a]apad[a]`
      await execFile('ffmpeg', [
        '-y', '-i', videoPath, '-i', audioPath,
        '-filter_complex', filterComplex,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-t', String(targetSeconds),
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MUX_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] muxBeatAudio: failed to read output:`, (err as Error).message)
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MUX_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Beat with Audio', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundMuxBeatAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})

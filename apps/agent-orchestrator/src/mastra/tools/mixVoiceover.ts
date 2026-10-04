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
import { refundMixVoiceoverCharge } from './mixVoiceoverCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { parseIntegratedLoudness } from './mixMusicBed.js'
import { stableToolCallId } from '../../credits.js'

// Lays announcer voiceover blocks over a joined TVC video at their planned
// times, keeping the clips' own sound (on-camera lines, fizz, splash) and
// dipping it about 8 dB under the voice. assemble_clips cannot do this:
// preserveAudio and audioFileId are mutually exclusive there.
const execFile = promisify(execFileCb)
const MIX_SUBJECT = 'ffmpeg-mix-voiceover'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
export const DUCK_VOLUME = 0.4 // ≈ -8 dB
const MIN_ACCEPTABLE_VO_LUFS = -35
const MASTER = 'loudnorm=I=-14:TP=-1.5:LRA=11'
const r2 = (x: number) => Math.round(x * 100) / 100

export const inputSchema = z.object({
  videoFileId: z.string().describe('The joined TVC video, with its clips\' own sound kept (assemble_clips preserveAudio true).'),
  blocks: z.array(z.object({
    audioFileId: z.string().describe('One voiceover block from generate_narration'),
    startSeconds: z.number().min(0).describe('Where this block starts in the video, from the TVC plan'),
  })).min(1).max(4),
})

export function buildVoiceoverFilter(blocks: Array<{ start: number; duration: number }>, baseHasAudio: boolean): string {
  const parts = blocks.map((b, i) => {
    const ms = Math.round(b.start * 1000)
    return `[${i + 1}:a]adelay=${ms}|${ms}[vo${i}]`
  })
  parts.push(blocks.length === 1
    ? '[vo0]anull[vo]'
    : `${blocks.map((_, i) => `[vo${i}]`).join('')}amix=inputs=${blocks.length}:duration=longest:normalize=0[vo]`)
  if (!baseHasAudio) {
    parts.push(`[vo]apad,${MASTER}[outa]`)
    return parts.join(';')
  }
  const windows = blocks.map((b) => `between(t,${r2(b.start)},${r2(b.start + b.duration)})`).join('+')
  parts.push(`[0:a]volume=${DUCK_VOLUME}:enable='${windows}'[base]`)
  parts.push('[base][vo]amix=inputs=2:duration=first:normalize=0[pre]')
  parts.push(`[pre]${MASTER}[outa]`)
  return parts.join(';')
}

export const voiceoverFitsVideo = (blocks: Array<{ start: number; duration: number }>, videoSeconds: number): boolean =>
  blocks.every((b) => b.start + b.duration <= videoSeconds + 0.05)

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

async function durationOf(path: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: FFMPEG_TIMEOUT_MS })
  const d = parseFloat(stdout.trim())
  if (!(d > 0)) throw new Error(`ffprobe returned an invalid duration: ${stdout}`)
  return d
}

export const mixVoiceover = createTool({
  id: 'mix-voiceover',
  description: 'Lays one or more voiceover blocks over a joined video at their planned start times, keeping the video\'s own sound (on-camera lines, sound effects) and dipping it under the voice, then masters the mix. Refuses a voiceover that runs past the end of the video or is too quiet to hear. Used in the TVC ad finish, after assemble_clips and before overlay_text and mix_music_bed.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: MIX_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, blocks } = inputData as z.infer<typeof inputSchema>
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    if (!conversationId) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string
    let voPaths: string[]
    try {
      const ids = [videoFileId, ...blocks.map((b) => b.audioFileId)]
      const urls = await Promise.all(ids.map((id) => fetchPresignedUrl(id, idToken)))
      const files = await Promise.all(ids.map((id, i) => downloadToSessionCache(scopeId, id, urls[i], MAX_SOURCE_BYTES)))
      videoPath = files[0].filePath
      voPaths = files.slice(1).map((f) => f.filePath)
    } catch (err) {
      console.error(`[session:${sessionId}] mixVoiceover: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Free checks before charging: lengths, fit, and each block audible on its own.
    let videoSeconds: number
    let timed: Array<{ start: number; duration: number }>
    let baseHasAudio: boolean
    try {
      videoSeconds = await durationOf(videoPath)
      timed = await Promise.all(voPaths.map(async (p, i) => ({ start: blocks[i].startSeconds, duration: await durationOf(p) })))
      const { stdout: streams } = await execFile('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', videoPath], { timeout: FFMPEG_TIMEOUT_MS })
      baseHasAudio = streams.trim().length > 0
      for (const p of voPaths) {
        const { stderr } = await execFile('ffmpeg', ['-i', p, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { timeout: FFMPEG_TIMEOUT_MS })
        const lufs = parseIntegratedLoudness(stderr)
        if (lufs === null || lufs < MIN_ACCEPTABLE_VO_LUFS) return { refused: true, refusalReason: 'VOICEOVER_INAUDIBLE', jobId }
      }
    } catch (err) {
      console.error(`[session:${sessionId}] mixVoiceover: probe failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }
    if (!voiceoverFitsVideo(timed, videoSeconds)) return { refused: true, refusalReason: 'VOICEOVER_TOO_LONG', jobId }

    const chargeKey = `mix-voiceover:${jobId}:0`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n
    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', MIX_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED MIX-VOICEOVER: no active clip_assembly/${MIX_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
    const refund = async () => { if (charged) await refundMixVoiceoverCharge(tenantId, agentId, chargeKey, rateId, rateVersion) }

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'mix-voiceover-'))
    } catch (err) {
      console.error(`[session:${sessionId}] mixVoiceover: failed to create temp dir:`, (err as Error).message)
      await refund()
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }
    const outputPath = join(workDir, 'voiced.mp4')
    try {
      await execFile('ffmpeg', [
        '-y', '-i', videoPath, ...voPaths.flatMap((p) => ['-i', p]),
        '-filter_complex', buildVoiceoverFilter(timed, baseHasAudio),
        '-map', '0:v', '-map', '[outa]',
        '-c:v', 'copy', '-c:a', 'aac',
        '-t', String(videoSeconds),
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] mixVoiceover: ffmpeg failed:`, (err as Error).message)
      await refund()
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] mixVoiceover: failed to read output:`, (err as Error).message)
      await refund()
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Ad with voiceover', content: buffer, contentType: 'video/mp4', extension: 'mp4',
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

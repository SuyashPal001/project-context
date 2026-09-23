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
import { refundMixMusicBedCharge } from './mixMusicBedCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const MIX_SUBJECT = 'ffmpeg-mix-music-bed'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// Base attenuation before sidechain ducking — matches the spec's "ducked
// under the voice" requirement; refined from novoads' own measured
// failure of a flat 0.10 multiplier landing at -33 to -40 dB (inaudible).
const BED_VOLUME = 0.35
// Below this, treat the bed itself (before any mixing) as effectively
// silent/broken and refuse rather than ship it — same "measure, don't
// guess" discipline the spec calls out from novoads' music_mix.py. This
// must be measured on the bed ALONE, before mixing: measuring the final
// mastered output is dead code, because the final loudnorm pass always
// normalizes the whole mix to -14 LUFS regardless of how quiet the bed
// actually was inside it — the gate would never fire.
const MIN_ACCEPTABLE_BED_LUFS = -40

export function parseIntegratedLoudness(stderr: string): number | null {
  const match = stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/)
  return match ? parseFloat(match[1]) : null
}

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  loudnessIntegratedLufs: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('The captioned master — already has the mixed voice track. Music is applied LAST, after captions.'),
  musicFileId: z.string().describe('The music bed from generate_song.'),
})

export const mixMusicBed = createTool({
  id: 'mix-music-bed',
  description: 'Ducks a music bed under the existing voice track, masters the mix, and refuses to finalize a bed measured too quiet to hear rather than shipping one nobody would notice. Applied LAST in animation-character\'s pipeline, after captions are burned — never before.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: MIX_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, musicFileId } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string, musicPath: string
    try {
      const [videoUrl, musicUrl] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(musicFileId, idToken),
      ])
      ;[{ filePath: videoPath }, { filePath: musicPath }] = await Promise.all([
        downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES),
        downloadToSessionCache(scopeId, musicFileId, musicUrl, MAX_SOURCE_BYTES),
      ])
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `mix-music-bed:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', MIX_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED MIX-MUSIC-BED: no active clip_assembly/${MIX_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
      workDir = mkdtempSync(join(tmpdir(), 'music-bed-'))
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }
    const outputPath = join(workDir, 'mixed.mp4')
    let integratedLufs: number | null = null
    try {
      // Gate 1: measure the bed ALONE, before any mixing, and refuse a
      // silent/broken generation before spending the main encode. Doing
      // this after the final mix (as an earlier draft did) is dead code —
      // the final loudnorm pass always normalizes the WHOLE mix to -14
      // LUFS regardless of the bed's own level, so a post-mix check can
      // never observe a quiet bed.
      const { stderr: bedLoudnessStderr } = await execFile('ffmpeg', [
        '-i', musicPath, '-af', `volume=${BED_VOLUME},ebur128=framelog=quiet`, '-f', 'null', '-',
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const bedLufs = parseIntegratedLoudness(bedLoudnessStderr)
      if (bedLufs === null || bedLufs < MIN_ACCEPTABLE_BED_LUFS) {
        console.error(`[session:${sessionId}] mixMusicBed: bed's own loudness ${bedLufs} LUFS is below the ${MIN_ACCEPTABLE_BED_LUFS} LUFS floor — refusing rather than shipping a silent/broken bed`)
        if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
        rmSync(workDir, { recursive: true, force: true })
        return { refused: true, refusalReason: 'MUSIC_BED_INAUDIBLE', jobId }
      }

      const { stdout: durationOut } = await execFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
      const videoDurationSeconds = parseFloat(durationOut.trim())
      if (!(videoDurationSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${durationOut}`)

      // sidechaincompress ducks the bed WHEN the voice is present, rather
      // than sitting at one static low level the whole ad (the spec asks
      // for the bed to be "ducked under the voice", not just quiet
      // throughout) — [bedvol][0:a]sidechaincompress compresses the first
      // input (the bed) using the second (the voice) as the trigger.
      const filterComplex =
        `[1:a]volume=${BED_VOLUME}[bedvol];` +
        `[bedvol][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[duckedbed];` +
        `[0:a][duckedbed]amix=inputs=2:duration=longest:normalize=0[premaster];` +
        `[premaster]loudnorm=I=-14:TP=-1.5:LRA=11[outa]`
      await execFile('ffmpeg', [
        '-y', '-i', videoPath, '-i', musicPath,
        '-filter_complex', filterComplex,
        '-map', '0:v', '-map', '[outa]',
        '-c:v', 'copy', '-c:a', 'aac',
        '-t', String(videoDurationSeconds),
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })

      // Informational only (not a gate) — report the finished master's
      // own integrated loudness for the output field / any later QA read.
      const { stderr: masterLoudnessStderr } = await execFile('ffmpeg', [
        '-i', outputPath, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-',
      ], { timeout: FFMPEG_TIMEOUT_MS })
      integratedLufs = parseIntegratedLoudness(masterLoudnessStderr)
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] mixMusicBed: failed to read output:`, (err as Error).message)
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'MIX_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Final Video', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundMixMusicBedCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      loudnessIntegratedLufs: integratedLufs ?? undefined,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})

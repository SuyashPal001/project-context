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
    audioFileId: z.string().describe('One voiceover block from generate_narration, or the sign-off from generate_jingle'),
    startSeconds: z.number().min(0).describe('Where this block starts in the video, from the TVC plan'),
    kind: z.enum(['voice', 'jingle']).optional().describe('jingle = the sung sign-off (signoffFileId at the finish slice\'s signoffStartSeconds): level-matched to the speech before it instead of ducking. Default voice'),
  })).min(1).max(5),
  room: z.boolean().optional().describe('true = the narrator sits in the scene\'s room (a little quieter, a touch of room echo) instead of a dry studio voice on top. Use for the animated ad\'s narrator.'),
})

export type MixBlock = { start: number; duration: number; kind?: 'voice' | 'jingle'; gainDb?: number }

// tail replaces the master on the probe graph (a window measurement);
// muteJingles silences jingle blocks there so the window holds only what
// the jingle has to match. A call without kind builds the same graph as
// before, byte for byte.
// A dry TTS voice laid over an animated room sounded "pasted on" (Gemini 6/10);
// a touch of early echo, trimmed lows and highs and a little less level made it
// "sit in the scene" (9/10), tested 2026-10-06.
export const ROOM_VOICE = 'aecho=0.85:0.7:35|60:0.18|0.10,highpass=f=90,lowpass=f=9500,volume=0.8,'

export function buildVoiceoverFilter(blocks: MixBlock[], baseHasAudio: boolean, tail: string = MASTER, muteJingles = false, room = false): string {
  const parts = blocks.map((b, i) => {
    const ms = Math.round(b.start * 1000)
    const gain = b.kind !== 'jingle' ? (room ? ROOM_VOICE : '') : muteJingles ? 'volume=0,' : b.gainDb !== undefined ? `volume=${b.gainDb}dB,` : ''
    return `[${i + 1}:a]${gain}adelay=${ms}|${ms}[vo${i}]`
  })
  parts.push(blocks.length === 1
    ? '[vo0]anull[vo]'
    : `${blocks.map((_, i) => `[vo${i}]`).join('')}amix=inputs=${blocks.length}:duration=longest:normalize=0[vo]`)
  if (!baseHasAudio) {
    parts.push(`[vo]apad,${tail}[outa]`)
    return parts.join(';')
  }
  // A jingle neither ducks the base nor is ducked: only voice blocks open a window.
  const voiced = blocks.filter((b) => b.kind !== 'jingle')
  const windows = voiced.map((b) => `between(t,${r2(b.start)},${r2(b.start + b.duration)})`).join('+')
  parts.push(voiced.length ? `[0:a]volume=${DUCK_VOLUME}:enable='${windows}'[base]` : '[0:a]anull[base]')
  parts.push('[base][vo]amix=inputs=2:duration=first:normalize=0[pre]')
  parts.push(`[pre]${tail}[outa]`)
  return parts.join(';')
}

// J6: a sung sign-off came out about 8 LU louder than the speech when not
// matched (2026-10-05). It is set to the loudness of the 5s before it: the
// speech level when someone speaks there, otherwise the base + 2 LU.
export const JINGLE_WINDOW_SECONDS = 5
const JINGLE_OVER_BASE_LU = 2
const JINGLE_MAX_GAIN_DB = 12

export function jingleWindow(start: number): { from: number; to: number } | null {
  const from = Math.max(0, start - JINGLE_WINDOW_SECONDS)
  return start - from >= 0.5 ? { from: r2(from), to: r2(start) } : null
}

export const speechInWindow = (blocks: MixBlock[], from: number, to: number): boolean =>
  blocks.some((b) => b.kind !== 'jingle' && b.start < to && b.start + b.duration > from)

export function jingleGainDb(windowLufs: number | null, jingleLufs: number, speech: boolean): number {
  if (windowLufs === null || windowLufs <= -60) return 0
  const target = windowLufs + (speech ? 0 : JINGLE_OVER_BASE_LU)
  const gain = Math.min(JINGLE_MAX_GAIN_DB, Math.max(-JINGLE_MAX_GAIN_DB, target - jingleLufs))
  return Math.round(gain * 10) / 10
}

/** inputs = [video, ...block audio], in the same order as blocks. Never throws: an unmeasurable window leaves the jingle at 0 dB. */
export async function levelMatchJingles(inputs: string[], blocks: MixBlock[], blockLufs: number[], baseHasAudio: boolean): Promise<MixBlock[]> {
  return Promise.all(blocks.map(async (b, i) => {
    if (b.kind !== 'jingle') return b
    const win = jingleWindow(b.start)
    let windowLufs: number | null = null
    if (win) {
      try {
        const probe = buildVoiceoverFilter(blocks, baseHasAudio, `atrim=start=${win.from}:end=${win.to},ebur128=framelog=verbose`, true)
        const { stderr } = await execFile('ffmpeg', ['-nostats', ...inputs.flatMap((p) => ['-i', p]), '-filter_complex', probe, '-map', '[outa]', '-f', 'null', '-'], { timeout: FFMPEG_TIMEOUT_MS })
        windowLufs = parseIntegratedLoudness(stderr)
      } catch (err) {
        console.warn('[mixVoiceover] jingle window probe failed, leaving the jingle at 0 dB:', (err as Error).message)
      }
    }
    return { ...b, gainDb: jingleGainDb(windowLufs, blockLufs[i], win ? speechInWindow(blocks, win.from, win.to) : false) }
  }))
}

// framelog=verbose, not quiet: the VM's ffmpeg 5.1 rejects quiet, which made
// every mix_music_bed call fail (3f5ec1c5). verbose works on 5.1 and 8.x.
export const loudnessProbeArgs = (path: string): string[] => ['-i', path, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-']

export const voiceoverFitsVideo = (blocks: Array<{ start: number; duration: number }>, videoSeconds: number): boolean =>
  blocks.every((b) => b.start + b.duration <= videoSeconds + 0.05)

// F3: a sign-off that would end a hair past a slightly short video is laid
// to end with the video instead of refusing VOICEOVER_TOO_LONG. Only the
// jingle block is clamped — a voice block running past the video is still a
// real refusal.
export function clampJingleToVideo(blocks: MixBlock[], videoSeconds: number): MixBlock[] {
  return blocks.map((b) => (b.kind === 'jingle' ? { ...b, start: Math.min(b.start, videoSeconds - b.duration) } : b))
}

// F2: checked against the MEASURED duration of each voice block, before the
// charge — the plan-time estimate (tvcPlan's JINGLE_WONT_FIT) is a guess;
// this is the real audio.
export function jingleOverlapErrors(blocks: MixBlock[]): string[] {
  const jingle = blocks.find((b) => b.kind === 'jingle')
  if (!jingle) return []
  const errors: string[] = []
  for (const b of blocks) {
    if (b.kind === 'jingle') continue
    const over = r2(b.start + b.duration + 0.75 - jingle.start)
    if (over > 0) errors.push(`JINGLE_OVERLAPS_SPEECH: the voiceover ends ${over}s after the sung line starts; end the voiceover earlier`)
  }
  return errors
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

async function durationOf(path: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: FFMPEG_TIMEOUT_MS })
  const d = parseFloat(stdout.trim())
  if (!(d > 0)) throw new Error(`ffprobe returned an invalid duration: ${stdout}`)
  return d
}

export const mixVoiceover = createTool({
  id: 'mix-voiceover',
  description: 'Lays one or more voiceover blocks over a joined video at their planned start times, keeping the video\'s own sound (on-camera lines, sound effects) and dipping it under the voice, then masters the mix. Refuses a voiceover that runs past the end of the video or is too quiet to hear. Used in the TVC ad finish (after assemble_clips, before overlay_text and mix_music_bed) and to place the animated ad\'s narrator lines on their shots (with room true). A block with kind "jingle" (the sung sign-off) is level-matched to the speech before it and never ducks the sound.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: MIX_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, blocks, room } = inputData as z.infer<typeof inputSchema>
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
    let timed: MixBlock[]
    let baseHasAudio: boolean
    const blockLufs: number[] = []
    try {
      videoSeconds = await durationOf(videoPath)
      timed = await Promise.all(voPaths.map(async (p, i) => ({
        start: blocks[i].startSeconds, duration: await durationOf(p),
        ...(blocks[i].kind === 'jingle' ? { kind: 'jingle' as const } : {}),
      })))
      timed = clampJingleToVideo(timed, videoSeconds)
      const { stdout: streams } = await execFile('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', videoPath], { timeout: FFMPEG_TIMEOUT_MS })
      baseHasAudio = streams.trim().length > 0
      for (const p of voPaths) {
        const { stderr } = await execFile('ffmpeg', loudnessProbeArgs(p), { timeout: FFMPEG_TIMEOUT_MS })
        const lufs = parseIntegratedLoudness(stderr)
        if (lufs === null || lufs < MIN_ACCEPTABLE_VO_LUFS) return { refused: true, refusalReason: 'VOICEOVER_INAUDIBLE', jobId }
        blockLufs.push(lufs)
      }
    } catch (err) {
      console.error(`[session:${sessionId}] mixVoiceover: probe failed:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }
    if (!voiceoverFitsVideo(timed, videoSeconds)) return { refused: true, refusalReason: 'VOICEOVER_TOO_LONG', jobId }
    const jingleOverlap = jingleOverlapErrors(timed)
    if (jingleOverlap.length) return { refused: true, refusalReason: jingleOverlap.join(' '), jobId }
    if (timed.some((b) => b.kind === 'jingle')) timed = await levelMatchJingles([videoPath, ...voPaths], timed, blockLufs, baseHasAudio)

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
        '-filter_complex', buildVoiceoverFilter(timed, baseHasAudio, MASTER, false, room === true),
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

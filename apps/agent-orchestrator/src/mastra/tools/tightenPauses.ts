import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { finishedAdTitle } from './fileTitle.js'

// Cuts dead air out of a finished talking-head or UGC ad. 2026-10-05: a part
// given more seconds than its line made Omni pause 1.3s mid-line and smile
// silently for 1.6s at the end; the user felt "what happened?" as a viewer.
// Free (local ffmpeg), no approval card.
const execFile = promisify(execFileCb)
const FFMPEG_TIMEOUT_MS = 180_000
const MAX_SOURCE_BYTES = 500 * 1024 * 1024
// Silence is judged against the clip's own loudness: a fixed -35dB missed a
// 0.8s silent start and a 0.4s silent smile at a part join in an ad whose
// room sound sat around -33dB (2026-10-05). 5dB under the mean finds the
// gaps between sentences; commas (~0.35s) stay under MIN_PAUSE and are kept.
const SILENCE_BELOW_MEAN_DB = 5
const MIN_PAUSE = 0.4   // pauses at least this long are shortened
const KEEP_EDGE = 0.12  // breath kept on each side of a shortened pause
const KEEP_START = 0.15
const KEEP_END = 0.3   // a short smile after the last word, not a hold

/** Parses ffmpeg silencedetect output into [start, end] pairs (end = duration when open). */
export function parseSilences(stderr: string, duration: number): Array<[number, number]> {
  const starts = [...stderr.matchAll(/silence_start: (-?[0-9.]+)/g)].map((m) => Math.max(0, Number(m[1])))
  const ends = [...stderr.matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]))
  return starts.map((s, i) => [s, ends[i] ?? duration])
}

/** The silence level for this clip, from ffmpeg volumedetect's mean volume (clamped; -35dB when unreadable). */
export function silenceThreshold(volumedetectStderr: string): number {
  const mean = Number(volumedetectStderr.match(/mean_volume: (-?[0-9.]+) dB/)?.[1])
  if (!Number.isFinite(mean)) return -35
  return Math.round(Math.min(-22, Math.max(-45, mean - SILENCE_BELOW_MEAN_DB)))
}

/** A 20ms fade on each side of a cut, so a jump cut does not click or drop the room sound to dead silence. */
export function joinFades(i: number, count: number, length: number): string {
  const f = Math.min(0.02, length / 4)
  return (i > 0 ? `,afade=t=in:d=${f.toFixed(3)}` : '') + (i < count - 1 ? `,afade=t=out:st=${(length - f).toFixed(3)}:d=${f.toFixed(3)}` : '')
}

/** The parts to keep: speech with a little air, silence at the edges trimmed. */
export function keepSegments(silences: Array<[number, number]>, duration: number): Array<[number, number]> {
  const keep: Array<[number, number]> = []
  let cur: number | null = 0
  for (const [s, e] of silences) {
    if (s <= 0.01) { cur = Math.max(0, e - KEEP_START); continue }
    if (e >= duration - 0.01) { keep.push([cur!, Math.min(duration, s + KEEP_END)]); cur = null; break }
    keep.push([cur!, s + KEEP_EDGE])
    cur = e - KEEP_EDGE
  }
  if (cur !== null) keep.push([cur, duration])
  return keep.filter(([a, b]) => b - a > 0.05)
}

export const tightenPauses = createTool({
  id: 'tighten-pauses',
  description: 'Free. Cuts dead air out of a finished spoken ad video: trims silence at the start and end and shortens any pause over 0.4s to a quick jump cut. Run it on the finished talking-head or UGC ad before delivering it; returns the tightened video (or the original fileId when there was nothing to cut).',
  inputSchema: z.object({ videoFileId: z.string().describe('The finished ad video') }),
  outputSchema: z.object({
    fileId: z.string().optional(), name: z.string().optional(), fileType: z.string().optional(), size: z.number().optional(),
    secondsBefore: z.number().optional(), secondsAfter: z.number().optional(), unchanged: z.boolean().optional(),
    refused: z.boolean().optional(), refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { videoFileId } = inputData as { videoFileId: string }
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    if (!idToken || !conversationId) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }

    let source: string
    try {
      const url = await fetchPresignedUrl(videoFileId, idToken)
      source = (await downloadToSessionCache(tenantId || conversationId, videoFileId, url, MAX_SOURCE_BYTES)).filePath
    } catch {
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    }
    const workDir = mkdtempSync(join(tmpdir(), 'tighten-'))
    try {
      const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source], { timeout: 30_000 })
      const duration = Number(stdout.trim())
      if (!(duration > 0)) return { refused: true, refusalReason: 'TIGHTEN_FAILED' }
      const level = await execFile('ffmpeg', ['-nostats', '-i', source, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: FFMPEG_TIMEOUT_MS })
      const silenceDb = silenceThreshold(level.stderr)
      const probe = await execFile('ffmpeg', ['-nostats', '-i', source, '-af', `silencedetect=n=${silenceDb}dB:d=${MIN_PAUSE}`, '-f', 'null', '-'], { timeout: FFMPEG_TIMEOUT_MS })
      const keep = keepSegments(parseSilences(probe.stderr, duration), duration)
      const after = keep.reduce((n, [a, b]) => n + (b - a), 0)
      if (duration - after < 0.3) return { fileId: videoFileId, unchanged: true, secondsBefore: duration, secondsAfter: duration }

      const graph = keep.map(([a, b], i) => `[0:v]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=${a.toFixed(3)}:${b.toFixed(3)},asetpts=PTS-STARTPTS${joinFades(i, keep.length, b - a)}[a${i}]`).join(';')
        + ';' + keep.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${keep.length}:v=1:a=1[v][a]`
      const out = join(workDir, 'tightened.mp4')
      await execFile('ffmpeg', ['-y', '-i', source, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], { timeout: FFMPEG_TIMEOUT_MS })
      const buffer = readFileSync(out)
      const attachment = await uploadGeneratedFile(idToken, { conversationId, title: finishedAdTitle(conversationId, 'Finished Ad'), content: buffer, contentType: 'video/mp4', extension: 'mp4' })
      if (!attachment) return { refused: true, refusalReason: 'STORAGE_FAILED' }
      return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size, secondsBefore: Math.round(duration * 10) / 10, secondsAfter: Math.round(after * 10) / 10 }
    } catch (err) {
      console.error('[tightenPauses] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'TIGHTEN_FAILED' }
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  },
})

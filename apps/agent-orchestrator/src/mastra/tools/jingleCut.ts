import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSilences } from './tightenPauses.js'
import type { TimedLine } from './timedLyrics.js'

// Cuts the sung sign-off out of Lyria 3's 30s clip (spec J4): from just
// before the line (so the first consonant is kept) to the first silence
// after it, never more than 2s past the line, so a held note rings out but
// the next verse is never included.
const execFile = promisify(execFileCb)
const FFMPEG_TIMEOUT_MS = 60_000
export const LEAD_IN = 0.15
export const MAX_RING = 2.0
export const FADE_OUT = 0.9
export const FADE_IN = 0.02
export const SILENCE_FILTER = 'silencedetect=noise=-35dB:d=0.25'
const MIN_CUT = 0.5
const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000

/** silencesAfterEnd: silencedetect pairs measured from the line's end (t=0 is line.end). */
export function signoffWindow(line: TimedLine, silencesAfterEnd: Array<[number, number]>, clipSeconds: number): { start: number; end: number } {
  const start = r2(Math.max(0, line.start - LEAD_IN))
  const firstSilence = silencesAfterEnd.find(([s]) => s >= 0)
  const ring = firstSilence ? Math.min(firstSilence[0], MAX_RING) : MAX_RING
  return { start, end: r2(Math.min(line.end + ring, clipSeconds)) }
}

export function signoffFilter(lengthSeconds: number): string {
  const d = Math.min(FADE_OUT, lengthSeconds)
  return `afade=t=in:d=${FADE_IN},afade=t=out:st=${r3(Math.max(0, lengthSeconds - d))}:d=${r3(d)}`
}

export async function cutSignoff(fullPath: string, line: TimedLine, workDir: string): Promise<{ audio: Buffer; seconds: number }> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fullPath], { timeout: FFMPEG_TIMEOUT_MS })
  const clipSeconds = parseFloat(stdout.trim())
  if (!(clipSeconds > 0)) throw new Error(`ffprobe returned an invalid duration: ${stdout}`)
  const probe = await execFile('ffmpeg', ['-nostats', '-ss', String(line.end), '-t', String(MAX_RING), '-i', fullPath, '-af', SILENCE_FILTER, '-f', 'null', '-'], { timeout: FFMPEG_TIMEOUT_MS })
  const { start, end } = signoffWindow(line, parseSilences(probe.stderr, MAX_RING), clipSeconds)
  const length = r2(end - start)
  if (length < MIN_CUT) throw new Error(`sign-off cut too short: ${length}s`)
  const out = join(workDir, 'signoff.m4a')
  await execFile('ffmpeg', ['-y', '-ss', String(start), '-t', String(length), '-i', fullPath,
    '-af', signoffFilter(length), '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', out], { timeout: FFMPEG_TIMEOUT_MS })
  return { audio: readFileSync(out), seconds: length }
}

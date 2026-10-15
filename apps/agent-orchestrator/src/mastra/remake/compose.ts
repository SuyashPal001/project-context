// Frame-exact composition (spec rule 12): every part is 30fps and exactly its frame count,
// so the joined remake is exactly as long as the reference. Hard cuts only (fades are 3c).
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLIP_FPS } from './clipSpec.js'

const execFile = promisify(execFileCb)
const run = (args: string[]) => execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 180_000 })
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(CLIP_FPS)]
const cover = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`

async function mediaSeconds(path: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 30_000 })
  return Number(stdout.trim()) || 0
}

/** A clip fitted to its look: RETIMED so its first and last frames land on the look's
 *  edges (a Veo clip ends on the end still; cutting it would drop that pose), then exactly
 *  `frames` frames at 30fps; a clone pad only covers rounding. */
export async function fitToFrames(input: string, frames: number, out: string, size: { width: number; height: number }): Promise<string> {
  const dur = await mediaSeconds(input)
  const target = frames / CLIP_FPS
  const retime = dur > 0 ? `setpts=PTS*${(target / dur).toFixed(6)},` : ''
  const pad = `tpad=stop_mode=clone:stop_duration=1`
  await run(['-i', input, '-an', '-vf', `${retime}${cover(size.width, size.height)},fps=${CLIP_FPS},${pad}`, '-frames:v', String(frames), ...X264, out])
  return out
}

export async function stillToFrames(still: string | null, frames: number, out: string, size: { width: number; height: number }): Promise<string> {
  const { width: W, height: H } = size
  const d = (frames / CLIP_FPS + 0.5).toFixed(3)
  if (!still) await run(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=${CLIP_FPS}`, '-frames:v', String(frames), ...X264, out])
  else await run(['-loop', '1', '-t', d, '-i', still, '-vf', `${cover(W, H)},fps=${CLIP_FPS}`, '-frames:v', String(frames), ...X264, out])
  return out
}

export async function joinSegments(parts: string[], out: string): Promise<string> {
  const list = join(dirname(out), 'join-list.txt')
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'))
  await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out])
  return out
}

/** Music fitted to the video: copies joined with a 1s crossfade until long enough (no hard
 *  loop click), trimmed to the exact length, faded out over the last second. */
export async function fitMusic(music: string, seconds: number, out: string): Promise<string> {
  const s = seconds.toFixed(3)
  const fadeAt = Math.max(0, seconds - 1).toFixed(3)
  const len = await mediaSeconds(music)
  const copies = len > 2 && len < seconds ? Math.ceil((seconds - 1) / (len - 1)) : 1
  const inputs = Array.from({ length: copies }, () => ['-i', music]).flat()
  const chain = copies === 1 ? '[0:a]anull[m]'
    : Array.from({ length: copies - 1 }, (_, i) => `${i === 0 ? '[0:a]' : `[x${i}]`}[${i + 1}:a]acrossfade=d=1${i === copies - 2 ? '[m]' : `[x${i + 1}]`}`).join(';')
  await run([...inputs, '-filter_complex', `${chain};[m]atrim=0:${s},afade=t=out:st=${fadeAt}:d=1[out]`, '-map', '[out]', '-t', s, '-c:a', 'aac', out])
  return out
}

/** The music as the only audio. The video's own length rules (never -shortest: a music file a
 *  few ms short would drop the last frames and break the exact length). */
export async function muxMusic(video: string, music: string, out: string): Promise<string> {
  const t = (await mediaSeconds(video)).toFixed(3)
  await run(['-i', video, '-i', music, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', t, out])
  return out
}

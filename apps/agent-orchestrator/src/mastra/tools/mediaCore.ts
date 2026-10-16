// Shared media core: plain ffmpeg building blocks with no download, charge or upload, used by the
// agent tools (which wrap them) and by workflows like the remake, so a job is written once.
// stretch_clip wraps buildStretchArgs; assemble_clips wraps assembleLocal (assembleClips.ts).
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { assembleLocal, chooseFrameRate, probeClip } from './assembleClips.js'

const execFile = promisify(execFileCb)
const FFMPEG_TIMEOUT_MS = 180_000
export const runFfmpeg = (args: string[]) => execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: FFMPEG_TIMEOUT_MS })

export async function probeSeconds(path: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 30_000 })
  return Number(stdout.trim()) || 0
}

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

// ---- Exact-frame timing (the remake's rule: every part is exactly its frame count at `fps`).
const x264 = (fps: number) => ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(fps)]
const cover = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
export type Size = { width: number; height: number }

/** A clip RETIMED (faster or slower) so its first and last frames land on the target's edges,
 *  then exactly `frames` frames, cover-scaled to `size`; a clone pad only covers rounding.
 *  Unlike stretch's slow mode it shortens too and never cuts the ending (a first+last-frame clip
 *  must end on its end frame). */
export async function fitClipToFrames(input: string, frames: number, out: string, size: Size, fps = 30): Promise<string> {
  const dur = await probeSeconds(input)
  const target = frames / fps
  const retime = dur > 0 ? `setpts=PTS*${(target / dur).toFixed(6)},` : ''
  await runFfmpeg(['-i', input, '-an', '-vf', `${retime}${cover(size.width, size.height)},fps=${fps},tpad=stop_mode=clone:stop_duration=1`, '-frames:v', String(frames), ...x264(fps), out])
  return out
}

/** A still held for exactly `frames` frames (stretch's hold, for an image); no image = grey. */
export async function stillToFrames(still: string | null, frames: number, out: string, size: Size, fps = 30): Promise<string> {
  const { width: W, height: H } = size
  const d = (frames / fps + 0.5).toFixed(3)
  if (!still) await runFfmpeg(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=${fps}`, '-frames:v', String(frames), ...x264(fps), out])
  else await runFfmpeg(['-loop', '1', '-t', d, '-i', still, '-vf', `${cover(W, H)},fps=${fps}`, '-frames:v', String(frames), ...x264(fps), out])
  return out
}

/** Silent clips joined with hard cuts through assemble_clips' own join (same normalizing and
 *  length check), at one size. */
export async function joinClips(paths: string[], out: string, size: Size): Promise<string> {
  const probes = await Promise.all(paths.map((p) => probeClip(p)))
  return assembleLocal({ localPaths: paths, outputPath: out, probes, fps: chooseFrameRate(probes.map((p) => p.fps)), colourGains: paths.map(() => null), size })
}

// ---- Music as a video's only sound.
/** Music fitted to a length: copies joined with a 1s crossfade until long enough (no hard loop
 *  click), trimmed to the exact length, faded out over the last second. */
export async function fitMusicToLength(music: string, seconds: number, out: string): Promise<string> {
  const s = seconds.toFixed(3)
  const fadeAt = Math.max(0, seconds - 1).toFixed(3)
  const len = await probeSeconds(music)
  const copies = len > 2 && len < seconds ? Math.ceil((seconds - 1) / (len - 1)) : 1
  const inputs = Array.from({ length: copies }, () => ['-i', music]).flat()
  const chain = copies === 1 ? '[0:a]anull[m]'
    : Array.from({ length: copies - 1 }, (_, i) => `${i === 0 ? '[0:a]' : `[x${i}]`}[${i + 1}:a]acrossfade=d=1${i === copies - 2 ? '[m]' : `[x${i + 1}]`}`).join(';')
  await runFfmpeg([...inputs, '-filter_complex', `${chain};[m]atrim=0:${s},afade=t=out:st=${fadeAt}:d=1[out]`, '-map', '[out]', '-t', s, '-c:a', 'aac', out])
  return out
}

/** The audio as the video's only sound. The video's own length rules (never -shortest: audio a few
 *  ms short would drop the last frames and break an exact length). */
export async function setOnlyAudio(video: string, audio: string, out: string): Promise<string> {
  const t = (await probeSeconds(video)).toFixed(3)
  await runFfmpeg(['-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', t, out])
  return out
}


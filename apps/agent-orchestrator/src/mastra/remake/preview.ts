// The FREE preview (spec §8a "cheap → expensive"): every look's stills, timed exactly
// like the reference, before any clip is paid for. Silent: music comes with the clips.
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemakePlan, StillResult } from './types.js'

const execFile = promisify(execFileCb)
export const PREVIEW_FPS = 30
const FADE_S = 0.4
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(PREVIEW_FPS)]

export interface PreviewJob { workDir: string; width: number; height: number; segments: Array<{ seconds: number; start: string | null; end: string | null }> }

const even = (x: number) => Math.round(x / 2) * 2
/** 1080 on the short side (at most 1920 on the long side), even numbers, same shape. */
export function previewSize(w: number, h: number): { width: number; height: number } {
  const s = Math.min(1080 / Math.min(w, h), 1920 / Math.max(w, h))
  return { width: even(w * s), height: even(h * s) }
}

// A still that failed its checks is never shown as fine: grey card (it is still listed with its reasons).
/** A still the remake goes on with: passed, unchecked, or kept with a warning. */
export const usableStill = (s: StillResult | undefined): string | null => (s && s.fileId && (s.status === 'passed' || s.status === 'warned' || s.status === 'unchecked') ? s.fileId : null)
const usable = usableStill

export function previewSegments(plan: RemakePlan, stills: StillResult[], localPaths: Map<string, string>): PreviewJob['segments'] {
  const path = (id: string | null) => (id ? localPaths.get(id) ?? null : null)
  return [...plan.looks].sort((a, b) => a.startS - b.startS).map((l) => ({
    seconds: Math.round((l.endS - l.startS) * 1000) / 1000,
    start: path(usable(stills.find((s) => s.look === l.n && s.kind === 'start'))),
    end: path(usable(stills.find((s) => s.look === l.n && s.kind === 'end'))),
  }))
}

/** Frames per segment from cumulative edges, so the total is exactly round(total × fps). */
function frameCounts(seconds: number[]): number[] {
  let t = 0, prev = 0
  return seconds.map((d) => { t += d; const edge = Math.round(t * PREVIEW_FPS + 1e-9); const n = edge - prev; prev = edge; return n })
}

export async function renderPreview(job: PreviewJob): Promise<string> {
  const run = (args: string[]) => execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 120_000 })
  const { width: W, height: H } = job
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=gray,setsar=1`
  const frames = frameCounts(job.segments.map((s) => s.seconds))
  const parts: string[] = []
  for (const [i, s] of job.segments.entries()) {
    const n = frames[i]
    const d = (n / PREVIEW_FPS).toFixed(4)
    const out = join(job.workDir, `seg-${String(i).padStart(2, '0')}.mp4`)
    const a = s.start ?? s.end
    if (!a) {
      await run(['-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=${PREVIEW_FPS}`, '-frames:v', String(n), ...X264, out])
    } else if (s.start && s.end && n / PREVIEW_FPS > FADE_S * 2) {
      const offset = (n / PREVIEW_FPS / 2 - FADE_S / 2).toFixed(4)
      await run(['-loop', '1', '-t', d, '-i', s.start, '-loop', '1', '-t', d, '-i', s.end, '-filter_complex',
        `[0]${fit},fps=${PREVIEW_FPS}[a];[1]${fit},fps=${PREVIEW_FPS}[b];[a][b]xfade=transition=fade:duration=${FADE_S}:offset=${offset}[v]`,
        '-map', '[v]', '-frames:v', String(n), ...X264, out])
    } else {
      await run(['-loop', '1', '-t', d, '-i', a, '-vf', `${fit},fps=${PREVIEW_FPS}`, '-frames:v', String(n), ...X264, out])
    }
    parts.push(out)
  }
  const list = join(job.workDir, 'preview-segments.txt')
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'))
  const joined = join(job.workDir, 'preview-joined.mp4')
  await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined])
  const total = (frames.reduce((a, b) => a + b, 0) / PREVIEW_FPS).toFixed(4)
  const out = join(job.workDir, 'preview.mp4')
  await run(['-i', joined, '-f', 'lavfi', '-t', total, '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', total, out])
  return out
}

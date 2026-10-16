import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The shared media core (tools/mediaCore.ts), which the remake uses; the remake's own copy is gone.
import { fitClipToFrames as fitToFrames, stillToFrames, joinClips, fitMusicToLength as fitMusic, setOnlyAudio as muxMusic } from '../tools/mediaCore.js'

const dir = mkdtempSync(join(tmpdir(), 'remake-compose-'))
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
const probe = (p: string, args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args, p]).toString().trim()
const frames = (p: string) => Number(probe(p, ['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0']))
const seconds = (p: string) => Number(probe(p, ['-show_entries', 'format=duration', '-of', 'csv=p=0']))
const size = { width: 720, height: 1280 }

it('trims a 24fps clip to exact 30fps frames, pads a short one, holds a still, joins with hard cuts', async () => {
  const c24 = join(dir, 'c24.mp4'); ff(['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=24:d=6', c24])
  const c2 = join(dir, 'c2.mp4'); ff(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=24:d=2', c2])
  const png = join(dir, 's.png'); ff(['-f', 'lavfi', '-i', 'color=c=red:s=540x960', '-frames:v', '1', png])
  const a = await fitToFrames(c24, 123, join(dir, 'a.mp4'), size)
  const b = await fitToFrames(c2, 90, join(dir, 'b.mp4'), size) // 2s clip, 3s look: padded
  const s = await stillToFrames(png, 37, join(dir, 's.mp4'), size)
  const g = await stillToFrames(null, 10, join(dir, 'g.mp4'), size)
  expect([frames(a), frames(b), frames(s), frames(g)]).toEqual([123, 90, 37, 10])
  expect(probe(b, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])).toBe('720,1280')
  const joined = await joinClips([a, b, s, g], join(dir, 'joined.mp4'), size)
  expect(frames(joined)).toBe(260)
}, 120_000)

it('fits 3s of music to an 8s video with a loop and a fade, then muxes it as the only audio', async () => {
  const m = join(dir, 'm.mp3'); ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', m])
  const v = join(dir, 'v.mp4'); ff(['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=30:d=8', '-an', v])
  const fitted = await fitMusic(m, 8, join(dir, 'fit.m4a'))
  expect(seconds(fitted)).toBeCloseTo(8, 1)
  const out = await muxMusic(v, fitted, join(dir, 'out.mp4'))
  expect(probe(out, ['-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0'])).toBe('aac')
  expect(seconds(out)).toBeCloseTo(8, 1)
}, 120_000)

const colorAt = (p: string, at: 'first' | 'last') => {
  const seek = at === 'last' ? ['-sseof', '-0.04'] : []
  const raw = execFileSync('ffmpeg', ['-v', 'error', ...seek, '-i', p, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [...raw]
}

it('C1: a 6s clip fitted to a 4.1s look keeps its first AND last frame (retimed, not cut)', async () => {
  const blue = join(dir, 'blue.mp4'); ff(['-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:r=24:d=5.5', blue])
  const red = join(dir, 'red.mp4'); ff(['-f', 'lavfi', '-i', 'color=c=red:s=720x1280:r=24:d=0.5', red])
  const six = join(dir, 'six.mp4'); ff(['-i', blue, '-i', red, '-filter_complex', '[0][1]concat=n=2:v=1[v]', '-map', '[v]', six])
  const out = await fitToFrames(six, 123, join(dir, 'fit123.mp4'), size)
  expect(frames(out)).toBe(123)
  const [r0, , b0] = colorAt(out, 'first'); const [r1, , b1] = colorAt(out, 'last')
  expect(b0).toBeGreaterThan(200); expect(r0).toBeLessThan(60)
  expect(r1).toBeGreaterThan(200); expect(b1).toBeLessThan(60)
}, 120_000)

it('I5: muxing music keeps every video frame', async () => {
  const v = join(dir, 'v91.mp4'); ff(['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=30', '-frames:v', '91', '-an', v])
  const m = join(dir, 'm2.m4a'); ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2.9', '-c:a', 'aac', m])
  const out = await muxMusic(v, m, join(dir, 'v91m.mp4'))
  expect(frames(out)).toBe(91)
}, 120_000)

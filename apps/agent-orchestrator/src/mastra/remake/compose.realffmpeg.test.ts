import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trimToFrames, stillToFrames, joinSegments, fitMusic, muxMusic } from './compose.js'

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
  const a = await trimToFrames(c24, 123, join(dir, 'a.mp4'), size)
  const b = await trimToFrames(c2, 90, join(dir, 'b.mp4'), size) // 2s clip, 3s look: padded
  const s = await stillToFrames(png, 37, join(dir, 's.mp4'), size)
  const g = await stillToFrames(null, 10, join(dir, 'g.mp4'), size)
  expect([frames(a), frames(b), frames(s), frames(g)]).toEqual([123, 90, 37, 10])
  expect(probe(b, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'])).toBe('720,1280')
  const joined = await joinSegments([a, b, s, g], join(dir, 'joined.mp4'))
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

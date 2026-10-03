import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { frameArgs } from './extractFrame.js'

describe('frameArgs', () => {
  it('seeks from the end for the last frame', () => {
    expect(frameArgs('in.mp4', 'out.jpg', 'last')).toEqual(['-y', '-sseof', '-0.1', '-i', 'in.mp4', '-frames:v', '1', '-q:v', '2', 'out.jpg'])
  })
  it('takes the first frame or a given time', () => {
    expect(frameArgs('in.mp4', 'out.jpg', 'first')).not.toContain('-ss')
    expect(frameArgs('in.mp4', 'out.jpg', 2.5)).toContain('2.5')
  })
  it('really produces a last-frame image with ffmpeg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xf-'))
    const video = join(dir, 'v.mp4'), out = join(dir, 'f.jpg')
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=180x320:rate=24:duration=2', '-pix_fmt', 'yuv420p', video])
    execFileSync('ffmpeg', ['-loglevel', 'error', ...frameArgs(video, out, 'last')])
    expect(existsSync(out)).toBe(true)
  })
})

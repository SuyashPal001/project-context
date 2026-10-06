import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { frameArgs, extractFrameKey, EXTRACTED_FRAME_KEY_MARKER } from './extractFrame.js'

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

// Task 2 (TVC live fixes): plan_tvc.ts's isExtractedFramePath recognises this
// exact marker in the S3 key to refuse a product photo that is really a
// frame pulled from a video — this key-builder is the only place the marker
// is written, so this test pins the contract both sides rely on.
describe('extractFrameKey', () => {
  it('embeds the extracted-frame marker in the generated key, surrounded by hyphens', () => {
    const key = extractFrameKey('conv1', 'Bubbli Product Photo Frame')
    expect(key).toContain(`-${EXTRACTED_FRAME_KEY_MARKER}-`)
    expect(key).toMatch(/^generated\/conv1\/.+-extract-frame-bubbli-product-photo-frame\.jpg$/)
  })
})

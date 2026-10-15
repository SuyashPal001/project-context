import { it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
import { sampleFrames, sideBySide } from './tvcChecks.js'

const size = (buf: Buffer) => {
  const d = mkdtempSync(join(tmpdir(), 'sz-'))
  try {
    const f = join(d, 'x.jpg'); writeFileSync(f, buf)
    return execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim()
  } finally { rmSync(d, { recursive: true, force: true }) }
}

it('crops a sampled frame and puts frames side by side with real ffmpeg', async () => {
  const d = mkdtempSync(join(tmpdir(), 'frames-'))
  try {
    const v = join(d, 'v.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=400x800:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v])
    const [face] = await sampleFrames(v, [0.5], d, [0.25, 0, 0.75, 0.25])
    expect(size(Buffer.from(face.data, 'base64'))).toBe('200,200')
    const [whole] = await sampleFrames(v, [0.5], d)
    expect(size(await sideBySide([whole, whole], d))).toBe('480,480')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

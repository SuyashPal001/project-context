// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
// The end card needs no libass (lavfi, geq, boxblur, overlay, fade), so this
// also runs on a Mac with a stock ffmpeg.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const uploaded: Buffer[] = []
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }),
}))
const dir = mkdtempSync(join(tmpdir(), 'marks-real-'))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => `https://local.test/${id}`),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => {
    const filePath = join(dir, id)
    return { filePath, buf: readFileSync(filePath), mimeType: 'application/octet-stream' }
  }),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { compositeEndCard } from './compositeEndCard.js'

function whyNot(): string | null {
  if (!process.env.RUN_REAL_FFMPEG) return null
  const f = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
  if (f.error) return 'ffmpeg is not installed'
  for (const name of ['geq', 'boxblur', 'colorchannelmixer', 'overlay', 'fade']) {
    if (!new RegExp(`\\b${name}\\b`).test(f.stdout)) return `this ffmpeg has no ${name} filter`
  }
  return null
}
const why = whyNot()
if (why) console.warn(`[compositeEndCard.realffmpeg] SKIPPED: ${why}`)

const ff = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
function inputs(W: number, H: number): string {
  const clip = `clip-${W}x${H}.mp4`
  ff(['-f', 'lavfi', '-i', `color=c=0x404040:s=${W}x${H}:d=3:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, clip)])
  ff(['-f', 'lavfi', '-i', 'color=c=0x305080:s=600x800', '-frames:v', '1', join(dir, 'photo.jpg')])
  // Opaque (rgb24 PNG): gets the plate. Clear: left half red, right half see-through.
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=800x200', '-frames:v', '1', join(dir, 'logo-opaque.png')])
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=800x200', '-vf', "format=rgba,geq=r='255':g='0':b='0':a='if(lt(X,400),255,0)'", '-frames:v', '1', join(dir, 'logo-clear.png')])
  return clip
}
function rgbFrame(video: string, at: number): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-i', video, '-ss', String(at), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 })
}
function bbox(rgb: Buffer, W: number, H: number, test: (r: number, g: number, b: number) => boolean) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      if (!test(rgb[i], rgb[i + 1], rgb[i + 2])) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
const isRed = (r: number, g: number, b: number) => r > 180 && g < 80 && b < 80
const isGreen = (r: number, g: number, b: number) => g > 90 && r < 70 && b < 70
const isBrown = (r: number, g: number, b: number) => r > 100 && r < 190 && g > 35 && g < 110 && b < 70 && r > g + 40

let n = 0
async function card(W: number, H: number, extra: Record<string, unknown>): Promise<Buffer> {
  const clip = inputs(W, H)
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
  const result = await compositeEndCard.execute!({ videoFileId: clip, productPhotoFileId: 'photo.jpg', aspectRatio: W > H ? '16:9' : '9:16', ...extra } as never, { requestContext: rc, agent: { toolCallId: `real-${++n}` } } as never)
  expect(result).toMatchObject({ fileId: 'out' })
  const out = join(dir, `out-${n}.mp4`)
  writeFileSync(out, uploaded[uploaded.length - 1])
  return rgbFrame(out, 2.8)                               // the card dissolved in at 1.5s and is full by 1.9s
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG || !!why)('composite_end_card logo and veg mark against real ffmpeg', () => {
  it.each([[1920, 1080], [1080, 1920]])('a plated logo at %ix%i: 81 px of logo inside a 97 px plate, top centre', async (W, H) => {
    const red = bbox(await card(W, H, { logoFileId: 'logo-opaque.png' }), W, H, isRed)!
    console.log(`[compositeEndCard.realffmpeg] plated ${W}x${H}`, JSON.stringify(red))
    expect(Math.abs(red.h - 81)).toBeLessThanOrEqual(2)
    expect(Math.abs(red.y0 - (54 + 8))).toBeLessThanOrEqual(2)
    expect(Math.abs((red.x0 + red.x1) / 2 - W / 2)).toBeLessThanOrEqual(3)
  }, 120_000)
  it.each([[1920, 1080], [1080, 1920]])('a transparent logo at %ix%i is 97 px tall: 9% of the shorter side', async (W, H) => {
    const red = bbox(await card(W, H, { logoFileId: 'logo-clear.png' }), W, H, isRed)!
    console.log(`[compositeEndCard.realffmpeg] clear ${W}x${H}`, JSON.stringify(red))
    expect(Math.abs(red.h - 97)).toBeLessThanOrEqual(2)
    expect(Math.abs(red.y0 - 54)).toBeLessThanOrEqual(2)
  }, 120_000)
  it.each([
    [1920, 1080, undefined, 1026],
    [1920, 1080, 2, 803],
    [1080, 1920, 1, 1639],
  ])('the veg mark at %ix%i (disclaimer lines %s) sits bottom-right with its square ending at %i', async (W, H, lines, bottom) => {
    const g = bbox(await card(W, H, { vegMark: 'veg', ...(lines ? { disclaimerLines: lines } : {}) }), W, H, isGreen)!
    console.log(`[compositeEndCard.realffmpeg] veg ${W}x${H} lines=${lines}`, JSON.stringify(g))
    expect(g.x0).toBeGreaterThan(W / 2)
    expect(g.y0).toBeGreaterThan(H / 2)
    // The green outline runs from 5 to 48 inside the 54 px square.
    expect(g.w).toBeGreaterThanOrEqual(40)
    expect(g.w).toBeLessThanOrEqual(48)
    expect(Math.abs(g.y1 - (bottom - 6))).toBeLessThanOrEqual(2)
    expect(Math.abs(g.x1 - (W - 54 - 6))).toBeLessThanOrEqual(2)
  }, 120_000)
  it('the non-veg mark is brown, not green', async () => {
    const rgb = await card(1920, 1080, { vegMark: 'non_veg' })
    expect(bbox(rgb, 1920, 1080, isBrown)).not.toBeNull()
    expect(bbox(rgb, 1920, 1080, isGreen)).toBeNull()
  }, 120_000)
})

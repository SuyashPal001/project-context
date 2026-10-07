// Real ffmpeg + libass + fontconfig, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
// Without libass or the Noto fonts it skips and says how to install them.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const uploaded: Buffer[] = []
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }),
  uploadFileWithKey: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }),
  generatedFileKey: (c: string, t: string, e: string) => `generated/${c}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${e}`,
}))
const dir = mkdtempSync(join(tmpdir(), 'legal-real-'))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => id),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => ({ filePath: join(dir, `${id}.mp4`) })),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { overlayText, buildAss } from './overlayText.js'
import { legalLineCount, nominalFrame } from './legalText.js'

const FONT_HELP = 'Install the disclaimer fonts. Mac: brew install --cask font-noto-sans font-noto-sans-devanagari. Debian/Ubuntu (the VM): sudo apt-get install -y fonts-noto-core && fc-cache -f'
const LIBASS_HELP = 'This ffmpeg has no subtitles filter (libass). Run on the VM, or on a Mac: brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg'

function whyNot(): string | null {
  if (!process.env.RUN_REAL_FFMPEG) return null
  const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
  if (filters.error) return 'ffmpeg is not installed'
  if (!/\bsubtitles\b/.test(filters.stdout)) return LIBASS_HELP
  const fonts = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' })
  if (fonts.error) return `fc-list (fontconfig) is not installed. ${FONT_HELP}`
  const families = fonts.stdout.split('\n').flatMap((l) => l.split(',').map((f) => f.trim()))
  if (!families.includes('Noto Sans') || !families.includes('Noto Sans Devanagari')) return FONT_HELP
  return null
}
const why = whyNot()
if (why) console.warn(`[overlayText.realffmpeg] SKIPPED: ${why}`)

// Only x-height letters (no ascenders, descenders or dots), so each text band's height IS the x-height.
// 2 lines at 1920x1080 (the nominal 16:9 frame).
const X_TEXT_16_9 = 'our new cream evens rare scars so an owner can wear more mascara as summer comes even nervous users are serene'
// 2 lines at 1080x1920 (the nominal 9:16 frame) — the narrower frame wraps a shorter phrase to 2 lines.
const X_TEXT_9_16 = 'rare scars so an owner can wear more mascara'
const HINDI = 'शर्तें लागू। परिणाम व्यक्ति के अनुसार अलग हो सकते हैं।'

function grayFrame(video: string, at: number): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
}

/** Box rows: more than 10% of the row is black. Text bands: runs of box rows with bright (white) pixels. */
function measure(gray: Buffer, w: number, h: number) {
  const boxRows: number[] = []
  const textRows: number[] = []
  for (let y = 0; y < h; y++) {
    let dark = 0, bright = 0
    for (let x = 0; x < w; x++) { const v = gray[y * w + x]; if (v < 40) dark++; else if (v > 180) bright++ }
    if (dark > w * 0.1) { boxRows.push(y); if (bright > 0) textRows.push(y) }
  }
  const bands: Array<{ top: number; height: number }> = []
  for (const y of textRows) {
    const last = bands[bands.length - 1]
    if (last && y === last.top + last.height) last.height++
    else bands.push({ top: y, height: 1 })
  }
  return { boxTop: boxRows[0], boxBottom: boxRows[boxRows.length - 1], bands }
}

function grayClip(name: string, w: number, h: number): string {
  const path = join(dir, `${name}.mp4`)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x808080:s=${w}x${h}:d=3:r=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path])
  return path
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG || !!why)('overlay_text legal style against real ffmpeg + libass', () => {
  it.each([
    ['16:9' as const, 1920, 1080, X_TEXT_16_9],
    ['9:16' as const, 1080, 1920, X_TEXT_9_16],
  ])('burns a 2-line disclaimer at %s (%ix%i) with an x-height of at least 26 px, in one box inside the frame', async (aspect, W, H, text) => {
    expect(legalLineCount(text, nominalFrame(aspect))).toBe(2)
    const src = grayClip(`src-${aspect.replace(':', '-')}`, W, H)
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
    const result = await overlayText.execute!({ videoFileId: `src-${aspect.replace(':', '-')}`, overlays: [{ text, startSeconds: 0, endSeconds: 3, position: 'bottom', size: 'legal' }] } as never, { requestContext: rc, agent: { toolCallId: `x-${aspect}` } } as never)
    expect(result).toMatchObject({ fileId: 'out', positions: ['bottom'] })
    const out = join(dir, `legal-${aspect.replace(':', '-')}.mp4`); writeFileSync(out, uploaded[uploaded.length - 1])
    const m = measure(grayFrame(out, 1.5), W, H)
    console.log(`[overlayText.realffmpeg] measured ${aspect}`, JSON.stringify(m))
    expect(m.bands).toHaveLength(2)                         // libass drew exactly our 2 lines — a wrap didn't silently add a third
    for (const band of m.bands) expect(band.height).toBeGreaterThanOrEqual(26)
    expect(m.boxTop).toBeLessThan(m.bands[0].top)
    expect(m.boxBottom).toBeGreaterThan(m.bands[1].top + m.bands[1].height)
    expect(m.boxBottom).toBeLessThanOrEqual(H - 60)          // inside the bottom safe margin
  }, 120_000)

  it('renders a Hindi disclaimer with no missing glyphs (no tofu)', () => {
    const W = 1920, H = 1080
    const src = grayClip('src-hi', W, H)
    const ass = join(dir, 'hindi.ass')
    writeFileSync(ass, buildAss([{ text: HINDI, startSeconds: 0, endSeconds: 3, position: 'bottom', size: 'legal' }], { width: W, height: H }))
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'verbose', '-ss', '1.5', '-i', src, '-vf', `subtitles=${ass}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
    const stderr = run.stderr.toString()
    expect(run.status).toBe(0)
    expect(stderr).not.toMatch(/failed to find any fallback/i)
    const m = measure(run.stdout, W, H)
    expect(m.bands.length).toBeGreaterThanOrEqual(1)
    const bright = [...run.stdout].filter((v) => v > 180).length
    expect(bright).toBeGreaterThan(2000)                     // real glyphs were drawn
  }, 120_000)
})

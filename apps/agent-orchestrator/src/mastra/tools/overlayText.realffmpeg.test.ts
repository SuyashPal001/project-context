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
// F2: ALL-CAPS and digits now measure at the raised maxima (0.80 em, 0.60
// em) — these two are each near the 2-line limit for their aspect, so a
// width table that was too narrow would have under-counted and rendered a
// third, clipped band.
const CAPS_DIGITS_9_16 = 'LIMITED 2025 OFFER VALID TODAY ONLY'
const CAPS_DIGITS_16_9 = 'LIMITED 2025 OFFER VALID TODAY ONLY WHILE STOCKS LAST'

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

  it.each([
    ['16:9' as const, 1920, 1080, CAPS_DIGITS_16_9],
    ['9:16' as const, 1080, 1920, CAPS_DIGITS_9_16],
  ])('burns an ALL-CAPS-and-digits disclaimer at %s (%ix%i) in at most 2 bands (F2)', async (aspect, W, H, text) => {
    expect(legalLineCount(text, nominalFrame(aspect))).toBeLessThanOrEqual(2)
    const src = grayClip(`caps-${aspect.replace(':', '-')}`, W, H)
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
    const result = await overlayText.execute!({ videoFileId: `caps-${aspect.replace(':', '-')}`, overlays: [{ text, startSeconds: 0, endSeconds: 3, position: 'bottom', size: 'legal' }] } as never, { requestContext: rc, agent: { toolCallId: `caps-${aspect}` } } as never)
    expect(result).toMatchObject({ fileId: 'out', positions: ['bottom'] })
    const out = join(dir, `caps-${aspect.replace(':', '-')}.mp4`); writeFileSync(out, uploaded[uploaded.length - 1])
    const m = measure(grayFrame(out, 1.5), W, H)
    console.log(`[overlayText.realffmpeg] measured caps ${aspect}`, JSON.stringify(m))
    expect(m.bands.length).toBeLessThanOrEqual(2)             // the raised width table never under-counts into a clipped 3rd band
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

describe.skipIf(!process.env.RUN_REAL_FFMPEG || !!why)('overlay_text motion against real ffmpeg + libass (M1, M2)', () => {
  it('a pop headline and a stamp price are still moving early and settled later', () => {
    const W = 1080, H = 1920
    const src = grayClip('motion', W, H)
    const ass = join(dir, 'motion.ass')
    writeFileSync(ass, buildAss([
      { text: 'Soft all day', startSeconds: 0.5, endSeconds: 2.8, position: 'top', size: 'large', motion: 'pop' },
      { text: '₹499', startSeconds: 0.5, endSeconds: 2.8, position: 'center', price: { amount: '₹499', mrp: '₹699', note: 'Launch offer' } },
    ], { width: W, height: H }))
    const at = (t: number): Buffer => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-ss', String(t), '-vf', `subtitles=${ass}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
      expect(r.status).toBe(0)
      return r.stdout
    }
    const early = at(0.56), late = at(1.5)
    const band = (buf: Buffer, y0: number, y1: number) => buf.subarray(y0 * W, y1 * W)
    const changed = (a: Buffer, b: Buffer) => { let k = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) k++; return k }
    const bright = (b: Buffer) => { let k = 0; for (const v of b) if (v > 200) k++; return k }
    const head = changed(band(early, 0, 480), band(late, 0, 480))
    const price = changed(band(early, 700, 1220), band(late, 700, 1220))
    console.log('[overlayText.realffmpeg] motion changed px', { head, price })
    expect(head).toBeGreaterThan(500)                       // the headline is mid-pop at 60 ms
    expect(price).toBeGreaterThan(500)                      // the price is mid-stamp at 60 ms
    expect(bright(band(late, 0, 480))).toBeGreaterThan(1000)     // and both are drawn once settled
    expect(bright(band(late, 700, 1220))).toBeGreaterThan(1000)
  }, 120_000)
})

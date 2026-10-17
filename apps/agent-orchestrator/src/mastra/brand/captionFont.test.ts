import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { fetchPresignedUrl, downloadToSessionCache } = vi.hoisted(() => ({
  fetchPresignedUrl: vi.fn(), downloadToSessionCache: vi.fn(),
}))
vi.mock('../tools/mediaCache.js', () => ({ fetchPresignedUrl, downloadToSessionCache }))

import { resolveCaptionFont, parseFontFamily, DEFAULT_CAPTION_FONT } from './captionFont.js'
import type { TenantBrand } from './types.js'

// A real, tiny (~6KB) subset of Space Grotesk SemiBold (OFL) — its name
// table has nameID 16 "Space Grotesk" and nameID 1 "Space Grotesk SemiBold",
// which is exactly the 16-then-1 case this tool must get right.
const FIXTURE_TTF = readFileSync(join(import.meta.dirname, '__fixtures__', 'test-font.ttf'))

const NO_BRAND: TenantBrand = {
  name: null, oneLiner: null, audience: null, region: 'IN', toneWords: [], emojiPolicy: 'minimal',
  signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null, colors: {}, headlineFont: null,
  logoFileId: null, fontFileId: null,
}

const originalFetch = global.fetch

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('parseFontFamily', () => {
  it('reads nameID 16 (preferredFamily) over nameID 1 from a real TTF', () => {
    expect(parseFontFamily(FIXTURE_TTF)).toBe('Space Grotesk')
  })

  it('returns null for unparseable bytes', () => {
    expect(parseFontFamily(Buffer.from('not a font'))).toBeNull()
  })
})

describe('resolveCaptionFont', () => {
  it('falls back to DejaVu Sans with no brand', async () => {
    expect(await resolveCaptionFont(null, { idToken: 'tok', scopeId: 's1' })).toEqual({ family: DEFAULT_CAPTION_FONT })
    expect(await resolveCaptionFont(NO_BRAND, { idToken: 'tok', scopeId: 's1' })).toEqual({ family: DEFAULT_CAPTION_FONT })
  })

  it('an uploaded font resolves to the real family read from the file, with a fontsDir containing it', async () => {
    fetchPresignedUrl.mockResolvedValue('https://cdn.example/f1')
    downloadToSessionCache.mockResolvedValue({ filePath: '/tmp/f1', buf: FIXTURE_TTF, mimeType: 'font/ttf' })
    const brand: TenantBrand = { ...NO_BRAND, fontFileId: 'f1', headlineFont: 'ignored when uploaded' }

    const result = await resolveCaptionFont(brand, { idToken: 'tok', scopeId: 's1' })

    expect(result.family).toBe('Space Grotesk')
    expect(result.fontsDir).toBeDefined()
    expect(existsSync(result.fontsDir!)).toBe(true)
    expect(fetchPresignedUrl).toHaveBeenCalledWith('f1', 'tok')
    expect(downloadToSessionCache).toHaveBeenCalledWith('s1', 'f1', 'https://cdn.example/f1', 5 * 1024 * 1024)
    rmSync(result.fontsDir!, { recursive: true, force: true })
  })

  it('an uploaded font that fails to download falls back to DejaVu Sans, never throwing', async () => {
    fetchPresignedUrl.mockRejectedValue(new Error('404'))
    const brand: TenantBrand = { ...NO_BRAND, fontFileId: 'missing' }

    await expect(resolveCaptionFont(brand, { idToken: 'tok', scopeId: 's1' })).resolves.toEqual({ family: DEFAULT_CAPTION_FONT })
  })

  it('an uploaded font with no readable family name falls back to DejaVu Sans', async () => {
    fetchPresignedUrl.mockResolvedValue('https://cdn.example/f1')
    downloadToSessionCache.mockResolvedValue({ filePath: '/tmp/f1', buf: Buffer.from('not a font'), mimeType: 'font/ttf' })
    const brand: TenantBrand = { ...NO_BRAND, fontFileId: 'f1' }

    await expect(resolveCaptionFont(brand, { idToken: 'tok', scopeId: 's1' })).resolves.toEqual({ family: DEFAULT_CAPTION_FONT })
  })

  it('a Google font fetches css2, parses the TTF url, downloads once, and caches for the next call', async () => {
    const family = `Test Family ${Date.now()}`
    const cacheDir = join(tmpdir(), 'brand-fonts')
    const slug = family.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const cachedPath = join(cacheDir, `${slug}.ttf`)
    rmSync(cachedPath, { force: true })

    const css = `@font-face {\n  font-family: '${family}';\n  src: url(https://fonts.gstatic.com/s/x/${slug}.ttf) format('truetype');\n}`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => css } as Response)
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => FIXTURE_TTF.buffer.slice(FIXTURE_TTF.byteOffset, FIXTURE_TTF.byteOffset + FIXTURE_TTF.byteLength) } as Response)
    global.fetch = fetchMock as unknown as typeof fetch

    const brand: TenantBrand = { ...NO_BRAND, headlineFont: family }
    const first = await resolveCaptionFont(brand, { idToken: 'tok', scopeId: 's1' })
    expect(first).toEqual({ family, fontsDir: cacheDir })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(existsSync(cachedPath)).toBe(true)

    const second = await resolveCaptionFont(brand, { idToken: 'tok', scopeId: 's1' })
    expect(second).toEqual({ family, fontsDir: cacheDir })
    // No new fetch on the second call — the TTF is reused from the cache dir.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    rmSync(cachedPath, { force: true })
  })

  it('a Google font whose css2/ttf fetch fails falls back to DejaVu Sans', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response)
    global.fetch = fetchMock as unknown as typeof fetch
    const brand: TenantBrand = { ...NO_BRAND, headlineFont: `Unreachable Family ${Date.now()}` }

    await expect(resolveCaptionFont(brand, { idToken: 'tok', scopeId: 's1' })).resolves.toEqual({ family: DEFAULT_CAPTION_FONT })
  })
})

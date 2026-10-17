// Resolves the font captions should burn in: an uploaded brand font file,
// else a Google Fonts family the brand picked, else today's default
// (DejaVu Sans). Every failure path here is logged and swallowed — a
// font problem must never fail or change the price of burning captions.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import * as opentype from 'opentype.js'
import type { TenantBrand } from './types.js'
import { fetchPresignedUrl, downloadToSessionCache } from '../tools/mediaCache.js'

const MAX_FONT_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 5_000
export const DEFAULT_CAPTION_FONT = 'DejaVu Sans'

export interface ResolvedCaptionFont {
  family: string
  fontsDir?: string
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** Parses the real family name out of a font file's name table: nameID 16
 * ("preferredFamily" — the typographic family, e.g. "Inter") first, then
 * nameID 1 ("fontFamily", which can hold something like "Inter Black" for
 * a non-Regular weight). getEnglishName reads whichever platform table
 * (unicode, then macintosh, then windows) the font actually populated.
 * Returns null on anything unparseable — callers fall back to DejaVu Sans. */
export function parseFontFamily(buf: Buffer): string | null {
  try {
    const font = opentype.parse(toArrayBuffer(buf))
    const family = font.getEnglishName('preferredFamily') ?? font.getEnglishName('fontFamily')
    const trimmed = family?.trim()
    return trimmed || null
  } catch (err) {
    console.error('[captionFont] could not parse uploaded font file:', (err as Error).message)
    return null
  }
}

function slugifyFontName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || createHash('sha1').update(name).digest('hex').slice(0, 16)
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Google's css2 endpoint only serves a TTF `src: url(...)` to requests it
// can't identify as a modern browser (no User-Agent header, which is what
// Node's native fetch sends by default) — a real browser UA gets woff2.
async function fetchGoogleFontTtfUrl(family: string): Promise<string> {
  const familyParam = encodeURIComponent(family.trim()).replace(/%20/g, '+')
  const res = await fetchWithTimeout(`https://fonts.googleapis.com/css2?family=${familyParam}:wght@600`, FETCH_TIMEOUT_MS)
  if (!res.ok) throw new Error(`fonts.googleapis.com css2 HTTP ${res.status}`)
  const css = await res.text()
  const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/)
  if (!match) throw new Error('css2 response had no TTF src — Google likely served woff2 for this request')
  return match[1]
}

/** Downloads (once) and caches a Google Fonts family's TTF under
 * os.tmpdir()/brand-fonts/<slug>.ttf, reusing it on every later call. */
async function resolveGoogleFont(family: string): Promise<ResolvedCaptionFont> {
  const cacheDir = join(tmpdir(), 'brand-fonts')
  const cachedPath = join(cacheDir, `${slugifyFontName(family)}.ttf`)
  if (!existsSync(cachedPath)) {
    const ttfUrl = await fetchGoogleFontTtfUrl(family)
    const ttfRes = await fetchWithTimeout(ttfUrl, FETCH_TIMEOUT_MS)
    if (!ttfRes.ok) throw new Error(`fonts.gstatic.com ttf HTTP ${ttfRes.status}`)
    const ttfBuf = Buffer.from(await ttfRes.arrayBuffer())
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachedPath, ttfBuf)
  }
  return { family, fontsDir: cacheDir }
}

/** Downloads the brand's uploaded font file and reads its real family name
 * from the font itself — the brand's `headlineFont` string is not trusted
 * for an uploaded file, since it's just whatever display name the upload
 * flow recorded. */
async function resolveUploadedFont(
  fontFileId: string,
  idToken: string,
  scopeId: string,
): Promise<ResolvedCaptionFont | null> {
  const url = await fetchPresignedUrl(fontFileId, idToken)
  const { buf } = await downloadToSessionCache(scopeId, fontFileId, url, MAX_FONT_BYTES)
  const family = parseFontFamily(buf)
  if (!family) return null
  const fontsDir = mkdtempSync(join(tmpdir(), 'brand-font-'))
  writeFileSync(join(fontsDir, 'brand-font.ttf'), buf)
  return { family, fontsDir }
}

/** Resolves the font captions should burn in. Uploaded brand font wins over
 * a Google Fonts pick; either failing (download, parse, fetch, timeout —
 * anything) falls back to DejaVu Sans, logged but never thrown. */
export async function resolveCaptionFont(
  brand: TenantBrand | null | undefined,
  { idToken, scopeId }: { idToken: string; scopeId: string },
): Promise<ResolvedCaptionFont> {
  try {
    if (brand?.fontFileId) {
      const resolved = await resolveUploadedFont(brand.fontFileId, idToken, scopeId)
      if (resolved) return resolved
      console.error('[captionFont] uploaded font had no readable family name — falling back to DejaVu Sans')
    } else if (brand?.headlineFont) {
      return await resolveGoogleFont(brand.headlineFont)
    }
  } catch (err) {
    console.error('[captionFont] falling back to DejaVu Sans:', (err as Error).message)
  }
  return { family: DEFAULT_CAPTION_FONT }
}

// The ASCI disclaimer rules ("Guidelines for Disclaimers", amended 13 July
// 2023) as pure code. plan_tvc uses them to count lines and holds before any
// paid step; overlay_text uses the same functions to render. One source, so
// the plan and the render never disagree (spec 2026-10-07 L1, L2, E2, E8).

export interface Frame { width: number; height: number }

export const LEGAL_FONT = 'Noto Sans'
/** The em, as a share of the frame's SHORTER side (E2): x-height >= 2.64% of
 *  S, which clears every row of the ASCI table (14 px at 576, 26 px at 1080,
 *  57 px at 2160 — the real-ffmpeg test in Task 5 measures the rendered
 *  result; this constant is sized off that measurement, not derived purely
 *  from the nominal ratio). */
export const LEGAL_EM_SHARE = 0.0506
/** libass (like VSFilter) maps ASS Fontsize to usWinAscent+usWinDescent, not
 *  to the em. Noto Sans: (1069 + 293) / 1000. Derived from font metrics, not
 *  measured by the real-ffmpeg test. */
export const LEGAL_FONT_HEIGHT_PER_EM = 1.362
export const NOTO_SANS_X_HEIGHT_PER_EM = 0.536
export const LEGAL_PLAY_RES_Y = 1920
export const LEGAL_BOX_PADDING = 12
export const LEGAL_MAX_LINES = 2
/** The share of the frame width a disclaimer line may fill: the 60-unit side
 *  margins (11%) plus the box padding, rounded down for safety. */
export const LEGAL_SAFE_WIDTH_SHARE = 0.86
const WIDTH_SAFETY = 1.05
/** overlay_text puts this in the storage key of every video it burned a
 *  disclaimer into, so composite_end_card can refuse to cover it (E4). */
export const LEGAL_TEXT_KEY_MARKER = 'legal-text'

export const nominalFrame = (aspectRatio: '16:9' | '9:16'): Frame =>
  aspectRatio === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 }

export const legalEmPx = (frame: Frame): number => Math.ceil(LEGAL_EM_SHARE * Math.min(frame.width, frame.height))

export const legalAssFontSize = (frame: Frame): number =>
  Math.ceil(legalEmPx(frame) * LEGAL_FONT_HEIGHT_PER_EM * LEGAL_PLAY_RES_Y / frame.height)

// Noto Sans Regular advance widths in em (lowercase, measured); everything
// else below is a conservative MAXIMUM from Noto Sans metrics, not a real
// measurement, so a line is never measured shorter than libass draws it.
const LOWER: Record<string, number> = {
  a: 0.561, b: 0.615, c: 0.48, d: 0.615, e: 0.564, f: 0.344, g: 0.615, h: 0.618, i: 0.258, j: 0.258, k: 0.534, l: 0.258, m: 0.935,
  n: 0.618, o: 0.605, p: 0.615, q: 0.615, r: 0.413, s: 0.479, t: 0.361, u: 0.618, v: 0.508, w: 0.786, x: 0.529, y: 0.51, z: 0.47,
}
// The widest of this set (% @ & — ₹ #) in Noto Sans Regular.
const WIDE_SYMBOL_RE = /[%@&—₹#]/
function advanceEm(ch: string): number {
  if (ch === ' ') return 0.26
  if (LOWER[ch] !== undefined) return LOWER[ch]
  if (ch === 'M' || ch === 'W') return 0.93
  if (/[A-Z]/.test(ch)) return 0.8
  if (/[0-9]/.test(ch)) return 0.6
  if (WIDE_SYMBOL_RE.test(ch)) return 1.0
  if (/\p{Mn}/u.test(ch)) return 0
  if (/\p{Mc}/u.test(ch)) return 0.35
  if (/[ऀ-ॿ]/.test(ch)) return 0.75
  if (/[.,:;'!|]/.test(ch)) return 0.3
  return 0.8
}

export const legalTextWidthEm = (text: string): number =>
  [...text].reduce((sum, ch) => sum + advanceEm(ch), 0) * WIDTH_SAFETY

// Measured against the UNROUNDED em, so the count depends only on the
// frame's aspect ratio (Review Focus 2); rendering rounds the em up, which
// the 5% width safety covers.
const maxLineEm = (frame: Frame): number =>
  (LEGAL_SAFE_WIDTH_SHARE * frame.width) / (LEGAL_EM_SHARE * Math.min(frame.width, frame.height))

export function wrapLegal(text: string, frame: Frame): string[] {
  const max = maxLineEm(frame)
  const lines: string[] = []
  let current = ''
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (!current || legalTextWidthEm(next) <= max) current = next
    else { lines.push(current); current = word }
  }
  if (current) lines.push(current)
  return lines
}

/** F1: libass (WrapStyle 0) only breaks a line at a space. A single word
 *  wider than one line's safe width (typically a URL) never wraps, so it
 *  renders as one line that runs off-frame — not as the two-or-more lines
 *  the width arithmetic alone would suggest. Returns the first such word. */
export function tooWideWord(text: string, frame: Frame): string | undefined {
  const max = maxLineEm(frame)
  return text.trim().split(/\s+/).find((word) => word && legalTextWidthEm(word) > max)
}

export function legalLineCount(text: string, frame: Frame): number {
  const max = maxLineEm(frame)
  if (tooWideWord(text, frame)) return LEGAL_MAX_LINES + 1
  return wrapLegal(text, frame).reduce((n, line) => n + Math.max(1, Math.ceil(legalTextWidthEm(line) / max)), 0)
}

const CURRENCY_RE = /^(₹|rs\.?)$/i
const MONEY_OR_PERCENT_RE = /^((₹|rs\.?)[\d,.]+(\/-)?|[\d,.]+(₹|%)|%)$/i
const NUMBER_RE = /^[\d,.]+(\/-)?$/
const HAS_WORD_RE = /[\p{L}\p{N}]/u
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** E8: words ASCI counts. Not counted: the brand name, Rs, Rs., ₹, %, and a
 *  number attached to them. A URL, an email or T&C is one word (no spaces). */
export function countLegalWords(text: string, brandName?: string): number {
  let t = text
  const brand = brandName?.trim()
  if (brand) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(brand)}(?![\\p{L}\\p{N}])`, 'giu'), ' ')
  let words = 0
  let afterCurrency = false
  for (const raw of t.split(/\s+/)) {
    const tok = raw.replace(/^[("'“‘[]+/u, '').replace(/[)"'”’\],;:!?.]+$/u, '')
    if (!tok) continue
    if (CURRENCY_RE.test(tok)) { afterCurrency = true; continue }
    if (MONEY_OR_PERCENT_RE.test(tok) || (afterCurrency && NUMBER_RE.test(tok))) { afterCurrency = false; continue }
    afterCurrency = false
    if (HAS_WORD_RE.test(tok)) words++
  }
  return words
}

/** L2: words/5 + (<= 9 words ? 2 : 3), counting other on-screen words; then at least 4 s per line. */
export function legalHoldSeconds(text: string, alsoOnScreenWords = 0, opts: { lines?: number; brandName?: string } = {}): number {
  const words = countLegalWords(text, opts.brandName) + alsoOnScreenWords
  const asci = words / 5 + (words <= 9 ? 2 : 3)
  const hold = Math.max(asci, 4 * (opts.lines ?? 1))
  return Math.ceil(hold * 10 - 1e-9) / 10
}

export function firstWords(text: string, n = 6): string {
  const words = text.trim().split(/\s+/)
  return words.length > n ? `${words.slice(0, n).join(' ')}…` : text.trim()
}

// Anchored on the 36-char uuid generatedFileKey puts first, so a title that
// merely contains "legal text" never matches (same pattern as planTvc's
// EXTRACTED_FRAME_PATH_RE).
const LEGAL_TEXT_PATH_RE = new RegExp(`/[0-9a-f-]{36}-${LEGAL_TEXT_KEY_MARKER}[-.]`, 'i')
export function carriesLegalTextPath(urlOrKey: string): boolean {
  let path = urlOrKey
  try { path = new URL(urlOrKey).pathname } catch { /* a bare storage key */ }
  return LEGAL_TEXT_PATH_RE.test(path)
}

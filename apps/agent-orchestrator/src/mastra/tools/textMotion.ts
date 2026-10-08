// TVC Part 2.2 (spec 2026-10-09 M1, M2, X6–X11): how on-screen text moves,
// and the price super. Pure code shared by overlay_text (render) and plan_tvc
// (checks), so the two never disagree. Every ASS override tag here is built
// from fixed text and numbers only; user text goes through escapeAssText and
// only ever sits OUTSIDE a {...} block.
import { z } from 'zod'
import { LEGAL_FONT_HEIGHT_PER_EM, LEGAL_PLAY_RES_Y, LEGAL_SAFE_WIDTH_SHARE, escapeAssText, legalTextWidthEm, type Frame } from './legalText.js'

export const MOTIONS = ['none', 'pop', 'slide_up', 'fade', 'stamp'] as const
export type Motion = typeof MOTIONS[number]
export type TextPosition = 'top' | 'center' | 'bottom'

/** M1: a move needs time to read; under this, any asked move becomes fade. */
export const MIN_MOTION_SECONDS = 0.6
/** X7: a price is a claim; it stays on screen at least this long. */
export const PRICE_MIN_SECONDS = 1.2
/** M1: every preset fades out over the last 120 ms so text never pops off. */
export const FADE_OUT_MS = 120

// overlay_text writes one ASS canvas, PlayRes 1080x1920. libass maps PlayResY
// onto the real frame height, so a share of 1920 is the same share of the
// real frame. The anchors match the styles' alignment and MarginV (160).
const PLAY_RES_X = 1080
const MARGIN_V = 160
const ANCHOR_Y: Record<TextPosition, number> = { top: MARGIN_V, center: LEGAL_PLAY_RES_Y / 2, bottom: LEGAL_PLAY_RES_Y - MARGIN_V }
/** slide_up starts 4% of the frame height below its place (77 of 1920). */
export const SLIDE_UP_OFFSET = Math.round(0.04 * LEGAL_PLAY_RES_Y)

/** The motion a line really gets. No motion asked = today's static text, on
 *  any window (X10, X12). A disclaimer never moves (X8). A price stamps by
 *  default (M2). Under 0.6 s any asked move becomes fade (M1). */
export function effectiveMotion(o: { motion?: Motion; size?: string; price?: unknown; startSeconds: number; endSeconds: number }): Motion {
  if (o.size === 'legal' && !o.price) return 'none'
  const asked: Motion = o.motion ?? (o.price ? 'stamp' : 'none')
  if (asked === 'none') return 'none'
  return o.endSeconds - o.startSeconds < MIN_MOTION_SECONDS - 1e-9 ? 'fade' : asked
}

export function motionTags(motion: Motion, position: TextPosition): string {
  switch (motion) {
    case 'none': return ''
    case 'pop': return `{\\fad(120,${FADE_OUT_MS})\\fscx80\\fscy80\\t(0,180,\\fscx100\\fscy100)}`
    case 'slide_up': {
      const x = PLAY_RES_X / 2, y = ANCHOR_Y[position]
      return `{\\fad(120,${FADE_OUT_MS})\\move(${x},${y + SLIDE_UP_OFFSET},${x},${y},0,220)}`
    }
    case 'fade': return '{\\fad(150,150)}'
    // 130% -> 115% -> 100% in 140 ms, and the outline flashes white for the
    // first 40 ms (about one frame) before going back to the styles' black.
    case 'stamp': return `{\\fad(0,${FADE_OUT_MS})\\fscx130\\fscy130\\t(0,100,\\fscx115\\fscy115)\\t(100,140,\\fscx100\\fscy100)\\3c&HFFFFFF&\\t(40,41,\\3c&H000000&)}`
  }
}

export const priceSchema = z.object({
  amount: z.string().min(1).max(20).describe('The price, e.g. "₹499" or "Rs. 499"'),
  mrp: z.string().min(1).max(20).optional().describe('The higher MRP, shown smaller and struck through, e.g. "₹699"'),
  note: z.string().min(1).max(40).optional().describe('A short line under the price, e.g. "Launch offer"'),
})
export type Price = z.infer<typeof priceSchema>

// X6: Devanagari digits (U+0966–U+096F) are money too; Noto Sans draws them.
const DIGITS = '0-9०-९'
const CURRENCY = '(?:₹|Rs\\.?|INR|[$€£¥])'
const MONEY_RE = new RegExp(`^${CURRENCY}\\s?[${DIGITS}][${DIGITS},]*(?:\\.[${DIGITS}]{1,2})?(?:/-)?$`, 'iu')
const CURRENCY_PREFIX_RE = new RegExp(`^${CURRENCY}\\s?`, 'iu')
const toAsciiDigits = (s: string) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))

export function moneyValue(text: string): number | null {
  const t = text.trim()
  if (!MONEY_RE.test(t)) return null
  const n = Number(toAsciiDigits(t).replace(CURRENCY_PREFIX_RE, '').replace(/\/-$/, '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** M2: the amount and the MRP must look like money; an MRP must be higher. */
export function priceError(price: Price): string | null {
  const amount = moneyValue(price.amount)
  if (amount === null) return `PRICE_INVALID: "${price.amount}" is not a price; write it like ₹499 or Rs. 499`
  if (price.mrp !== undefined) {
    const mrp = moneyValue(price.mrp)
    if (mrp === null) return `PRICE_INVALID: the MRP "${price.mrp}" is not a price; write it like ₹699`
    if (!(mrp > amount)) return `PRICE_MRP_NOT_HIGHER: the MRP ${price.mrp} must be higher than the price ${price.amount}; drop the MRP or fix the numbers`
  }
  return null
}

export function priceTooShortReason(seconds: number, where = 'the price'): string {
  return `PRICE_TOO_SHORT: ${where} is on screen for ${Math.round(seconds * 100) / 100}s; a price needs at least ${PRICE_MIN_SECONDS}s. Put it on a shot of ${PRICE_MIN_SECONDS}s or longer`
}

/** X9: font heights as a share of the shorter side. The amount is the 9:16
 *  canvas's large (120) × 1.2 = 144 px at S 1080, in both orientations. */
export const PRICE_AMOUNT_SHARE = 0.1333
export const PRICE_MRP_RATIO = 0.6
export const PRICE_NOTE_RATIO = 0.45
/** Noto Sans Bold runs wider than the Regular widths legalTextWidthEm models. */
const BOLD_WIDTH = 1.08
const toPlayRes = (px: number, frame: Frame) => Math.round(px * LEGAL_PLAY_RES_Y / frame.height)

export function priceFontSizes(frame: Frame): { amount: number; mrp: number; note: number } {
  const amountPx = PRICE_AMOUNT_SHARE * Math.min(frame.width, frame.height)
  return {
    amount: toPlayRes(amountPx, frame),
    mrp: toPlayRes(amountPx * PRICE_MRP_RATIO, frame),
    note: toPlayRes(amountPx * PRICE_NOTE_RATIO, frame),
  }
}

const widthPx = (text: string, size: number, frame: Frame): number =>
  legalTextWidthEm(text) * (size * frame.height / LEGAL_PLAY_RES_Y) / LEGAL_FONT_HEIGHT_PER_EM * BOLD_WIDTH

/** M2: the Dialogue text of a price super. The MRP is smaller and struck
 *  through (\s1), left of the amount, or above it when both do not fit one
 *  line; the note is small, under the amount. tooWide: the amount alone does
 *  not fit the frame's safe width. */
export function priceDialogue(price: Price, frame: Frame): { text: string; tooWide: boolean } {
  const fs = priceFontSizes(frame)
  const max = LEGAL_SAFE_WIDTH_SHARE * frame.width
  const amount = escapeAssText(price.amount)
  const mrp = price.mrp ? escapeAssText(price.mrp) : ''
  const note = price.note ? escapeAssText(price.note) : ''
  const tooWide = widthPx(amount, fs.amount, frame) > max
  let text = amount
  if (mrp) {
    const oneLine = widthPx(mrp, fs.mrp, frame) + widthPx(' ', fs.amount, frame) + widthPx(amount, fs.amount, frame) <= max
    text = `{\\fs${fs.mrp}\\s1}${mrp}{\\s0\\fs${fs.amount}}${oneLine ? '\\h' : '\\N'}${amount}`
  }
  if (note) text += `\\N{\\fs${fs.note}}${note}`
  return { text, tooWide }
}

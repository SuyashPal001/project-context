import { describe, it, expect } from 'vitest'
import {
  FADE_OUT_MS, MOTIONS, SLIDE_UP_OFFSET, effectiveMotion, moneyValue, motionTags, priceDialogue, priceError,
  priceFontSizes, priceSchema, priceTooShortReason,
} from './textMotion.js'

const LAND = { width: 1920, height: 1080 }
const PORT = { width: 1080, height: 1920 }
const win = (startSeconds: number, endSeconds: number) => ({ startSeconds, endSeconds })

describe('motion presets (M1)', () => {
  it('writes the fixed tags for each preset', () => {
    expect(motionTags('none', 'top')).toBe('')
    expect(motionTags('pop', 'top')).toBe('{\\fad(120,120)\\fscx80\\fscy80\\t(0,180,\\fscx100\\fscy100)}')
    expect(motionTags('fade', 'center')).toBe('{\\fad(150,150)}')
    expect(motionTags('stamp', 'center')).toBe('{\\fad(0,120)\\fscx130\\fscy130\\t(0,100,\\fscx115\\fscy115)\\t(100,140,\\fscx100\\fscy100)\\3c&HFFFFFF&\\t(40,41,\\3c&H000000&)}')
  })
  it('slide_up rises 4% of the frame height into each band\'s anchor', () => {
    expect(SLIDE_UP_OFFSET).toBe(77)
    expect(motionTags('slide_up', 'top')).toBe('{\\fad(120,120)\\move(540,237,540,160,0,220)}')
    expect(motionTags('slide_up', 'center')).toBe('{\\fad(120,120)\\move(540,1037,540,960,0,220)}')
    expect(motionTags('slide_up', 'bottom')).toBe('{\\fad(120,120)\\move(540,1837,540,1760,0,220)}')
  })
  it('every moving preset fades out over the last 120 ms or more', () => {
    expect(FADE_OUT_MS).toBe(120)
    for (const m of MOTIONS.filter((x) => x !== 'none')) expect(motionTags(m, 'top')).toMatch(/\\fad\(\d+,1[2-9]\d\)/)
  })
})

describe('which motion a line gets (M1, X8, X10)', () => {
  it('no motion asked stays static, even on a short window (legacy callers)', () => {
    expect(effectiveMotion(win(0, 2))).toBe('none')
    expect(effectiveMotion(win(0, 0.4))).toBe('none')
  })
  it('a move under 0.6 s becomes fade', () => {
    expect(effectiveMotion({ ...win(0, 0.59), motion: 'pop' })).toBe('fade')
    expect(effectiveMotion({ ...win(0, 0.6), motion: 'pop' })).toBe('pop')
    expect(effectiveMotion({ ...win(1.4, 2.0), motion: 'stamp' })).toBe('stamp')
  })
  it('a disclaimer never moves; a price stamps by default', () => {
    expect(effectiveMotion({ ...win(0, 4), motion: 'pop', size: 'legal' })).toBe('none')
    expect(effectiveMotion({ ...win(0, 2), price: { amount: '₹499' } })).toBe('stamp')
    expect(effectiveMotion({ ...win(0, 2), price: { amount: '₹499' }, motion: 'slide_up' })).toBe('slide_up')
  })
})

describe('price validation (M2, X6)', () => {
  it.each(['₹499', '₹ 499', 'Rs. 499', 'Rs 1,499', 'rs.99', '₹1,49,999.00', '₹499/-', '$4.99', '€10', 'INR 250', '₹४९९'])('%s is money', (t) => {
    expect(moneyValue(t)).not.toBeNull()
  })
  it.each(['499', 'free', '₹', '₹abc', 'Rs. 4 99', '₹499 only', '{\\b1}₹499', '₹-5'])('%s is not', (t) => {
    expect(moneyValue(t)).toBeNull()
  })
  it('reads Devanagari digits, grouping commas and paise', () => {
    expect(moneyValue('₹४९९')).toBe(499)
    expect(moneyValue('₹1,49,999')).toBe(149999)
    expect(moneyValue('Rs. 1,499.50/-')).toBe(1499.5)
  })
  it('refuses a bad amount, a bad MRP, and an MRP that is not higher', () => {
    expect(priceError({ amount: '₹499' })).toBeNull()
    expect(priceError({ amount: '₹499', mrp: '₹699', note: 'Launch offer' })).toBeNull()
    expect(priceError({ amount: 'cheap' })).toMatch(/^PRICE_INVALID: "cheap" is not a price/)
    expect(priceError({ amount: '₹499', mrp: 'was more' })).toMatch(/^PRICE_INVALID: the MRP "was more" is not a price/)
    expect(priceError({ amount: '₹499', mrp: '₹499' })).toMatch(/^PRICE_MRP_NOT_HIGHER: /)
    expect(priceError({ amount: '₹699', mrp: '₹४९९' })).toMatch(/^PRICE_MRP_NOT_HIGHER: /)
  })
  it('PRICE_TOO_SHORT names the time and the 1.2 s floor', () => {
    expect(priceTooShortReason(0.6, 'the price in shot 3')).toBe('PRICE_TOO_SHORT: the price in shot 3 is on screen for 0.6s; a price needs at least 1.2s. Put it on a shot of 1.2s or longer')
    expect(priceTooShortReason(1)).toMatch(/^PRICE_TOO_SHORT: the price is on screen for 1s/)
  })
  it('caps the lengths in the schema', () => {
    expect(priceSchema.safeParse({ amount: '₹499', note: 'Launch offer' }).success).toBe(true)
    expect(priceSchema.safeParse({ amount: '₹499', note: 'x'.repeat(41) }).success).toBe(false)
  })
})

describe('price sizes come from the shorter side (X9)', () => {
  it('the amount is 144 px at S 1080 in both orientations; the MRP 60%, the note 45%', () => {
    expect(priceFontSizes(PORT)).toEqual({ amount: 144, mrp: 86, note: 65 })
    expect(priceFontSizes(LAND)).toEqual({ amount: 256, mrp: 154, note: 115 })
    // ASS sizes are PlayRes units; libass scales them by frame height / 1920.
    expect(Math.round(priceFontSizes(LAND).amount * 1080 / 1920)).toBe(144)
  })
})

describe('price layout (M2, X11)', () => {
  it('the MRP struck through to the left, the note under the amount', () => {
    expect(priceDialogue({ amount: '₹499', mrp: '₹699', note: 'Launch offer' }, PORT)).toEqual({
      text: '{\\fs86\\s1}₹699{\\s0\\fs144}\\h₹499\\N{\\fs65}Launch offer', tooWide: false,
    })
  })
  it('stacks the MRP above the amount when both do not fit one line', () => {
    expect(priceDialogue({ amount: '₹1,49,999', mrp: '₹1,99,999' }, PORT).text).toBe('{\\fs86\\s1}₹1,99,999{\\s0\\fs144}\\N₹1,49,999')
    expect(priceDialogue({ amount: '₹1,49,999', mrp: '₹1,99,999' }, LAND).text).toBe('{\\fs154\\s1}₹1,99,999{\\s0\\fs256}\\h₹1,49,999')
  })
  it('just the amount', () => {
    expect(priceDialogue({ amount: '₹499' }, LAND)).toEqual({ text: '₹499', tooWide: false })
  })
  it('flags an amount too wide for the frame', () => {
    expect(priceDialogue({ amount: `₹${'9'.repeat(14)}` }, PORT).tooWide).toBe(true)
  })
  it('user text never reaches a tag: braces and backslashes are stripped from the note (Review Focus 3)', () => {
    expect(priceDialogue({ amount: '₹499', note: '{\\fs300\\pos(0,0)}Launch \\N offer' }, PORT).text).toBe('₹499\\N{\\fs65}fs300pos(0,0)Launch N offer')
  })
})

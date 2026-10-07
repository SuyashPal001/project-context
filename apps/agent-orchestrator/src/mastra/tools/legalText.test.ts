import { describe, it, expect } from 'vitest'
import { generatedFileKey } from '../../persistence.js'
import {
  LEGAL_FONT_HEIGHT_PER_EM, LEGAL_MAX_LINES, LEGAL_PLAY_RES_Y, LEGAL_TEXT_KEY_MARKER, NOTO_SANS_X_HEIGHT_PER_EM,
  carriesLegalTextPath, countLegalWords, firstWords, legalAssFontSize, legalEmPx, legalHoldSeconds,
  legalLineCount, nominalFrame, tooWideWord, wrapLegal,
} from './legalText.js'

const X_TEXT = 'our new cream evens rare scars so an owner can wear more mascara as summer comes even nervous users are serene'
const THREE_LINES_16_9 = 'Results based on a consumer study of 120 women aged 25 to 40 over four weeks of daily use. Individual results may vary. Offer valid till stocks last. Prices include all taxes.'
const HY = 'Hyaluronic acid as per lab tests. T&C apply.'
const TWO_LINES_16_9 = 'Based on an independent lab test of moisture retention over eight hours. Results may vary.'
const HINDI = 'शर्तें लागू। परिणाम व्यक्ति के अनुसार अलग हो सकते हैं।'

const renderedEm = (f: { width: number; height: number }) => legalAssFontSize(f) * f.height / LEGAL_PLAY_RES_Y / LEGAL_FONT_HEIGHT_PER_EM

// Controller ruling 2026-10-07: the x-height minimum is 2.64% of S, not
// 2.4% — that is the number that clears every row of the ASCI table (14 px
// at 576, 26 px at 1080, 57 px at 2160; the 57 is the primary ASCI document,
// not a slip). LEGAL_EM_SHARE is scaled accordingly (0.046 * 2.64/2.4).
describe('legal font size (L1, E2: the shorter side)', () => {
  it.each([
    [{ width: 1080, height: 1920 }, 75],
    [{ width: 1920, height: 1080 }, 134],
    [{ width: 1080, height: 1080 }, 134],
  ])('%o: em 55 px, ASS size %i, x-height at least 26 px', (frame, assSize) => {
    expect(legalEmPx(frame)).toBe(55)
    expect(legalAssFontSize(frame)).toBe(assSize)
    expect(renderedEm(frame)).toBeGreaterThanOrEqual(55)
    expect(renderedEm(frame) * NOTO_SANS_X_HEIGHT_PER_EM).toBeGreaterThanOrEqual(26)
  })
  // The ASCI table's own rows, not a linear re-derivation of the 1080 case:
  // 14 px at 576 and 57 px at 2160 (the shorter side in each case).
  it('x-height is at least 14 px at S=576', () => {
    const frame = { width: 1024, height: 576 }
    expect(renderedEm(frame) * NOTO_SANS_X_HEIGHT_PER_EM).toBeGreaterThanOrEqual(14)
  })
  it('x-height is at least 57 px at S=2160', () => {
    const frame = { width: 3840, height: 2160 }
    expect(renderedEm(frame) * NOTO_SANS_X_HEIGHT_PER_EM).toBeGreaterThanOrEqual(57)
  })
})

describe('wrapping (L1)', () => {
  it('wraps to the safe width and counts lines', () => {
    expect(wrapLegal(X_TEXT, nominalFrame('16:9'))).toEqual([
      'our new cream evens rare scars so an owner can wear more',
      'mascara as summer comes even nervous users are serene',
    ])
    expect(wrapLegal(HY, nominalFrame('9:16'))).toEqual(['Hyaluronic acid as per lab tests.', 'T&C apply.'])
    expect(legalLineCount('Creative visualisation', nominalFrame('16:9'))).toBe(1)
    expect(legalLineCount('Creative visualisation', nominalFrame('9:16'))).toBe(1)
    expect(legalLineCount(HY, nominalFrame('16:9'))).toBe(1)
    expect(legalLineCount(TWO_LINES_16_9, nominalFrame('16:9'))).toBe(2)
    expect(legalLineCount(THREE_LINES_16_9, nominalFrame('16:9'))).toBe(3)
  })
  it('counts a single word wider than the line as more than one line', () => {
    expect(legalLineCount('x'.repeat(120), nominalFrame('16:9'))).toBeGreaterThan(1)
  })
  // F1: libass (WrapStyle 0) only breaks at a space, so a URL whose width
  // falls between one and two lines still renders as ONE clipped line, not
  // the two the plain width arithmetic suggests — it must count as unfittable.
  describe('a single over-wide word (F1)', () => {
    const URL_WORD = 'visitexamplebrandlongurl.co.in/terms'
    const text = `Visit ${URL_WORD} for details.`
    it('is flagged at 9:16, where the word is wider than one line', () => {
      expect(tooWideWord(text, nominalFrame('9:16'))).toBe(URL_WORD)
      expect(legalLineCount(text, nominalFrame('9:16'))).toBeGreaterThan(LEGAL_MAX_LINES)
    })
    it('a normal line of the same length is unaffected at 16:9, where the word fits on one line', () => {
      expect(tooWideWord(text, nominalFrame('16:9'))).toBeUndefined()
      expect(legalLineCount(text, nominalFrame('16:9'))).toBeLessThanOrEqual(LEGAL_MAX_LINES)
    })
  })
  it('measures Devanagari conservatively (never fewer lines than its Latin length suggests)', () => {
    expect(legalLineCount(HINDI, nominalFrame('16:9'))).toBe(1)
    expect(legalLineCount(HINDI, nominalFrame('9:16'))).toBe(2)
  })
  // Review Focus 2: the plan counts at the nominal frame, overlay_text at the real one.
  it('the line count depends only on the aspect ratio, never the resolution', () => {
    for (const text of [X_TEXT, THREE_LINES_16_9, HY, TWO_LINES_16_9, HINDI, 'Creative visualisation']) {
      const land = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }].map((f) => legalLineCount(text, f))
      const port = [{ width: 720, height: 1280 }, { width: 1080, height: 1920 }, { width: 2160, height: 3840 }].map((f) => legalLineCount(text, f))
      expect(new Set(land).size).toBe(1)
      expect(new Set(port).size).toBe(1)
    }
  })
})

describe('word counting (E8)', () => {
  it.each([
    ['T&C apply', undefined, 2],
    ['Visit www.bubbli.in or write to care@bubbli.in', undefined, 6],
    ['Rs. 499 only', undefined, 1],
    ['Rs 99', undefined, 0],
    ['₹499 for 2 packs', undefined, 3],
    ['₹499/- inclusive', undefined, 1],
    ['50% off', undefined, 1],
    ['Bubbli Cola tastes best*', 'Bubbli Cola', 2],
    ['bubbli cola tastes best', 'Bubbli Cola', 2],
    ['Bubblicious taste', 'Bubbli', 2],
    ['शर्तें लागू', undefined, 2],
    ['- | *', undefined, 0],
  ])('%s (brand %s) = %i words', (text, brand, n) => {
    expect(countLegalWords(text, brand)).toBe(n)
  })
})

describe('hold (L2)', () => {
  it('words/5 + 2 up to 9 words, + 3 from 10, at least 4 s per line', () => {
    expect(legalHoldSeconds('Creative visualisation')).toBe(4)
    expect(legalHoldSeconds('one two three four five six seven eight nine')).toBe(4)
    expect(legalHoldSeconds('one two three four five six seven eight nine ten')).toBe(5)
    expect(legalHoldSeconds('a b c d e f g h i j k l m n o')).toBe(6)
    expect(legalHoldSeconds('one two three four five six seven eight nine', 3)).toBe(5.4)
    expect(legalHoldSeconds('Creative visualisation', 0, { lines: 2 })).toBe(8)
    expect(legalHoldSeconds('Bubbli one two three four five six seven eight nine', 0, { brandName: 'Bubbli' })).toBe(4)
  })
})

describe('helpers', () => {
  it('firstWords keeps six words and marks the cut', () => {
    expect(firstWords('one two three')).toBe('one two three')
    expect(firstWords('one two three four five six seven')).toBe('one two three four five six…')
  })
  it('recognises overlay_text\'s legal upload key, and nothing else (E4)', () => {
    const legalKey = generatedFileKey('c1', `${LEGAL_TEXT_KEY_MARKER} Video with Text Overlay`, 'mp4')
    expect(carriesLegalTextPath(`https://s3.example/${legalKey}?X-Amz-Signature=abc`)).toBe(true)
    expect(carriesLegalTextPath(legalKey)).toBe(true)
    expect(carriesLegalTextPath(`https://s3.example/${generatedFileKey('c1', 'Video with Text Overlay', 'mp4')}`)).toBe(false)
    expect(carriesLegalTextPath(`https://s3.example/${generatedFileKey('c1', 'my legal text notes', 'mp4')}`)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { droppedCheckInputs, lineMatchScore, parseVerdict } from './checkClip.js'

describe('lineMatchScore', () => {
  it('passes the exact line and small transcription differences', () => {
    const line = 'Honestly... the stitching is so clean, and it actually fits perfectly. I might never take this off.'
    expect(lineMatchScore(line, 'Honestly the stitching is so clean and it actually fits perfectly. I might never take this off')).toBe(1)
    expect(lineMatchScore(line, 'Honestly, the stitching is so clean and it actually fits perfect. I might never take this off.')).toBeGreaterThanOrEqual(0.85)
  })
  it('fails an invented line', () => {
    expect(lineMatchScore('I finally got the official Claude Thinking Cap in the mail today.', 'Hi everyone, today I am sharing a really quick recipe.')).toBeLessThan(0.5)
  })
})

describe('parseVerdict', () => {
  it('reads the JSON verdict, also inside a code fence', () => {
    expect(parseVerdict('```json\n{"samePerson": false, "confidence": 8, "heard": "hi", "reason": "different jaw"}\n```')).toEqual({ samePerson: false, productSame: true, glitch: false, confidence: 8, heard: 'hi', reason: 'different jaw' })
    expect(parseVerdict('no json here')).toBeNull()
  })
})

describe('parseVerdict strict form', () => {
  it('fails on a different face or different clothes', () => {
    expect(parseVerdict('{"clothing_same": false, "face_same": false, "confidence": 10, "differences": "green tee, rounder face", "heard": "x"}')?.samePerson).toBe(false)
    expect(parseVerdict('{"clothing_same": false, "face_same": true, "confidence": 9, "differences": "different shirt", "heard": ""}')?.samePerson).toBe(false)
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "confidence": 10, "differences": "none", "heard": "hi"}')).toEqual({ samePerson: true, productSame: true, glitch: false, confidence: 10, heard: 'hi', reason: 'none' })
  })
})

describe('parseVerdict product', () => {
  it('flags a changed or garbled product label', () => {
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "product_same": false, "confidence": 9, "differences": "cap text reads Thinkng Cap", "heard": ""}')?.productSame).toBe(false)
  })
})

describe('parseVerdict glitch', () => {
  it('reads a visible glitch (a second bottle, a hand swap) as its own failure', () => {
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "glitch": true, "confidence": 9, "differences": "second bottle appears", "heard": ""}')?.glitch).toBe(true)
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "confidence": 9, "differences": "none", "heard": ""}')?.glitch).toBe(false)
  })
})

describe('droppedCheckInputs', () => {
  const all = { expectedLine: true, product: true, reference: true }
  it('refuses a re-check of the same clip without the line, product or avatar it was first checked with', () => {
    expect(droppedCheckInputs('conv:clipA', all)).toEqual([])
    expect(droppedCheckInputs('conv:clipA', { expectedLine: false, product: false, reference: true })).toEqual(['expectedLine', 'product'])
    expect(droppedCheckInputs('conv:clipA', all)).toEqual([])
  })
  it('lets a re-check add inputs, and keys by clip', () => {
    expect(droppedCheckInputs('conv:clipB', { expectedLine: false, product: false, reference: false })).toEqual([])
    expect(droppedCheckInputs('conv:clipB', all)).toEqual([])
    expect(droppedCheckInputs('conv:clipC', { expectedLine: false, product: false, reference: false })).toEqual([])
  })
})

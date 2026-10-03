import { describe, it, expect } from 'vitest'
import { lineMatchScore, parseVerdict } from './checkClip.js'

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
    expect(parseVerdict('```json\n{"samePerson": false, "confidence": 8, "heard": "hi", "reason": "different jaw"}\n```')).toEqual({ samePerson: false, confidence: 8, heard: 'hi', reason: 'different jaw' })
    expect(parseVerdict('no json here')).toBeNull()
  })
})

describe('parseVerdict strict form', () => {
  it('fails on a different face or different clothes', () => {
    expect(parseVerdict('{"clothing_same": false, "face_same": false, "confidence": 10, "differences": "green tee, rounder face", "heard": "x"}')?.samePerson).toBe(false)
    expect(parseVerdict('{"clothing_same": false, "face_same": true, "confidence": 9, "differences": "different shirt", "heard": ""}')?.samePerson).toBe(false)
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "confidence": 10, "differences": "none", "heard": "hi"}')).toEqual({ samePerson: true, confidence: 10, heard: 'hi', reason: 'none' })
  })
})

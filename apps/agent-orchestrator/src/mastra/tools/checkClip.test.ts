import { describe, it, expect } from 'vitest'
import { droppedCheckInputs, lineMatchScore, parseVerdict, buildCheckQuestion, judgeVerdict } from './checkClip.js'

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
  it('reads a voice or room change against the first spoken clip as a sound mismatch', () => {
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "same_voice": true, "same_room": false, "confidence": 9, "differences": "dry studio voice, no echo"}')?.soundSame).toBe(false)
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "confidence": 9}')?.soundSame).toBe(true)
  })

  it('reads the JSON verdict, also inside a code fence', () => {
    expect(parseVerdict('```json\n{"samePerson": false, "confidence": 8, "heard": "hi", "reason": "different jaw"}\n```')).toEqual({ samePerson: false, productSame: true, glitch: false, confidence: 8, heard: 'hi', reason: 'different jaw', soundSame: true })
    expect(parseVerdict('no json here')).toBeNull()
  })
})

describe('parseVerdict strict form', () => {
  it('fails on a different face or different clothes', () => {
    expect(parseVerdict('{"clothing_same": false, "face_same": false, "confidence": 10, "differences": "green tee, rounder face", "heard": "x"}')?.samePerson).toBe(false)
    expect(parseVerdict('{"clothing_same": false, "face_same": true, "confidence": 9, "differences": "different shirt", "heard": ""}')?.samePerson).toBe(false)
    expect(parseVerdict('{"clothing_same": true, "face_same": true, "confidence": 10, "differences": "none", "heard": "hi"}')).toEqual({ samePerson: true, productSame: true, glitch: false, confidence: 10, heard: 'hi', reason: 'none', soundSame: true })
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

describe('no-person shots', () => {
  it('asks about the scene, not a presenter, and reads scene_same', () => {
    const q = buildCheckQuestion({ product: true, audio: false, noPerson: true })
    expect(q).toMatch(/no person/i)
    expect(q).toMatch(/"scene_same"/)
    expect(q).not.toMatch(/"face_same"/)
    expect(parseVerdict('{"scene_same": false, "product_same": true, "glitch": false, "confidence": 9, "differences": "different counter", "heard": ""}')?.samePerson).toBe(false)
  })
  it('passes a no-person shot without a face-confidence bar', () => {
    const v = { samePerson: true, productSame: true, glitch: false, confidence: 3, heard: '', reason: 'none', soundSame: true }
    expect(judgeVerdict(v, { audioChecked: false, expectNoSpeech: false, noPerson: true }).passed).toBe(true)
    expect(judgeVerdict(v, { audioChecked: false, expectNoSpeech: false, noPerson: false }).passed).toBe(false)
  })
})

describe('expectNoSpeech', () => {
  const v = (heard: string) => ({ samePerson: true, productSame: true, glitch: false, confidence: 9, heard, reason: 'none', soundSame: true })
  it('fails a silent shot where someone speaks', () => {
    const out = judgeVerdict(v('so I tried this'), { audioChecked: true, expectNoSpeech: true, noPerson: false })
    expect(out.passed).toBe(false)
    expect(out.reason).toMatch(/should be silent/)
  })
  it('passes a silent shot with no words heard', () => {
    expect(judgeVerdict(v(''), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(true)
  })
  it('asks for a transcript when audio is sent', () => {
    expect(buildCheckQuestion({ product: false, audio: true, noPerson: false })).toMatch(/transcribe/)
  })
  it('keeps the shipped transcript sentence byte-identical for a presenter/line check, and only adds the silence wording when the shot is expected to be silent', () => {
    const plain = buildCheckQuestion({ product: false, audio: true, noPerson: false })
    expect(plain).toContain('Also transcribe exactly what is spoken in the audio. ')
    expect(plain).not.toContain('ignore music')
    const silent = buildCheckQuestion({ product: false, audio: true, noPerson: false, silent: true })
    expect(silent).toContain('Also transcribe exactly what is spoken in the audio. ')
    expect(silent).toContain('ignore music')
  })
  it('treats a non-speech placeholder heard value as silence', () => {
    expect(judgeVerdict(v('[music]'), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(true)
    expect(judgeVerdict(v('(no speech)'), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(true)
    expect(judgeVerdict(v('so I tried this'), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(false)
  })
  it('a re-check cannot drop expectNoSpeech', () => {
    expect(droppedCheckInputs('conv:silent-clip', { expectedLine: false, product: false, reference: false, noSpeech: true })).toEqual([])
    expect(droppedCheckInputs('conv:silent-clip', { expectedLine: false, product: false, reference: false, noSpeech: false })).toEqual(['noSpeech'])
  })
})

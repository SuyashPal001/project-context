import { describe, it, expect } from 'vitest'
import { droppedCheckInputsFallback as droppedCheckInputs, lineMatchScore, parseVerdict, buildCheckQuestion, judgeVerdict, narrowWanted, droppedCheckInputsFallback as dropped2 } from './checkClip.js'

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
  it('counts only bracketed or parenthesised spans as non-speech, never words between them', () => {
    expect(judgeVerdict(v('[music] (laughs)'), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(true)
    expect(judgeVerdict(v('[music] so I tried this [laughs]'), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(false)
    expect(judgeVerdict(v('(sigh) wow (sigh)'), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(false)
    expect(judgeVerdict(v('Silence'), { audioChecked: true, expectNoSpeech: true, noPerson: false }).passed).toBe(true)
  })
  it('a re-check cannot drop expectNoSpeech', () => {
    expect(droppedCheckInputs('conv:silent-clip', { expectedLine: false, product: false, reference: false, noSpeech: true })).toEqual([])
    expect(droppedCheckInputs('conv:silent-clip', { expectedLine: false, product: false, reference: false, noSpeech: false })).toEqual(['noSpeech'])
  })
})

describe('noPerson re-check guard', () => {
  it('refuses a re-check that turns a presenter check into a no-person check', () => {
    expect(droppedCheckInputs('conv:person-clip', { expectedLine: false, product: true, reference: true, presenter: true })).toEqual([])
    expect(droppedCheckInputs('conv:person-clip', { expectedLine: false, product: true, reference: true, presenter: false })).toEqual(['presenter'])
  })
  it('allows a no-person clip to be re-checked as a presenter clip (stricter)', () => {
    expect(droppedCheckInputs('conv:scene-clip', { expectedLine: false, product: true, reference: false, presenter: false })).toEqual([])
    expect(droppedCheckInputs('conv:scene-clip', { expectedLine: false, product: true, reference: false, presenter: true })).toEqual([])
    expect(droppedCheckInputs('conv:scene-clip', { expectedLine: false, product: true, reference: false, presenter: false })).toEqual(['presenter'])
  })
})

describe('sound check (from main) threaded through judgeVerdict', () => {
  const base = { samePerson: true, productSame: true, glitch: false, confidence: 9, heard: 'hi there', reason: 'dry studio voice' }
  it('fails a clip whose voice or room differs from the first spoken clip, with a reason', () => {
    const out = judgeVerdict({ ...base, soundSame: false }, { audioChecked: true, expectNoSpeech: false, noPerson: false, soundChecked: true })
    expect(out.passed).toBe(false)
    expect(out.soundMatches).toBe(false)
    expect(out.reason).toMatch(/Sounds different from the first clip/)
  })
  it('ignores soundSame when no sound reference was sent', () => {
    expect(judgeVerdict({ ...base, soundSame: false }, { audioChecked: true, expectNoSpeech: false, noPerson: false }).passed).toBe(true)
  })
  it('asks for same_voice and same_room only with a sound reference', () => {
    expect(buildCheckQuestion({ product: false, audio: true, noPerson: false, sound: true })).toMatch(/"same_voice": true\|false, "same_room"/)
    expect(buildCheckQuestion({ product: false, audio: true, noPerson: false })).not.toMatch(/same_voice/)
  })
})

describe('narrow checks are opt-in (Review Focus 1)', () => {
  it('a legacy call makes no narrow checks', () => {
    expect(narrowWanted({})).toBe(false)
    expect(narrowWanted({ productScale: 'close' })).toBe(true)
    expect(narrowWanted({ action: 'cap pops off' })).toBe(true)
    expect(narrowWanted({ leadFileId: 'av1' })).toBe(true)
  })
  it('the re-check guard refuses dropping a narrow input', () => {
    expect(dropped2('conv:clipN', { expectedLine: false, product: true, reference: false, productVisible: true, extras: true, lead: true, action: true })).toEqual([])
    expect(dropped2('conv:clipN', { expectedLine: false, product: true, reference: false, productVisible: false, extras: true, lead: true, action: true })).toEqual(['productVisible'])
    expect(dropped2('conv:clipN', { expectedLine: false, product: true, reference: false, productVisible: true, extras: true, lead: false, action: false })).toEqual(['lead', 'action'])
  })
  it('the re-check guard refuses dropping endState, so a failed ACTION_NOT_COMPLETED cannot be re-checked away', () => {
    expect(dropped2('conv:clipEnd', { expectedLine: false, product: false, reference: false, action: true, endState: true })).toEqual([])
    // Director keeps `action` but drops `endState` after an ACTION_NOT_COMPLETED fail.
    expect(dropped2('conv:clipEnd', { expectedLine: false, product: false, reference: false, action: true, endState: false })).toEqual(['endState'])
  })
  it('the re-check guard refuses dropping productScale while keeping the product photo, which would silently drop the product check', () => {
    expect(dropped2('conv:clipProd', { expectedLine: false, product: true, reference: false, productNarrow: true })).toEqual([])
    // productFileId (product: true) is kept, but productScale is dropped: productNarrow goes false.
    expect(dropped2('conv:clipProd', { expectedLine: false, product: true, reference: false, productNarrow: false })).toEqual(['productNarrow'])
  })
})

import { describe, it, expect } from 'vitest'
import { clarificationAnswerText, handoverLine, uploadAnswerText } from './turnAnswer.js'

const review = [{ prompt: 'Here are the 3 scenes.', options: [{ label: 'Scene 1' }, { label: 'Scene 2' }, { label: 'All good — continue (Recommended)' }] }]

describe('clarificationAnswerText', () => {
  it('reads like the user typed it: picks, then the note, without the Recommended hint', () => {
    expect(clarificationAnswerText(review, [{ questionIndex: 0, selectedIndices: [1], freeText: 'lipstick should be red' }])).toBe('Scene 2 — lipstick should be red')
    expect(clarificationAnswerText(review, [{ questionIndex: 0, selectedIndex: 2 }])).toBe('All good — continue')
  })

  it('puts several questions on separate lines, in question order', () => {
    const qs = [{ prompt: 'Voice?', options: [{ label: 'Riya' }] }, { prompt: 'Length?', options: [{ label: '15s' }] }]
    expect(clarificationAnswerText(qs, [{ questionIndex: 1, selectedIndex: 0 }, { questionIndex: 0, selectedIndex: 0 }])).toBe('Riya\n15s')
  })

  it('says Skipped when nothing was given', () => {
    expect(clarificationAnswerText(review, [{ questionIndex: 0, skipped: true }])).toBe('Skipped')
    expect(clarificationAnswerText(review, [])).toBe('Skipped')
  })

  it('counts attached files', () => {
    expect(clarificationAnswerText([{ prompt: 'Upload', options: [] }], [{ questionIndex: 0, files: [{}, {}] }])).toBe('2 files attached')
  })
})

describe('uploadAnswerText', () => {
  it('uses the note, else the file count, else Skipped', () => {
    expect(uploadAnswerText({ files: [{}], freeText: 'the red one' })).toBe('the red one')
    expect(uploadAnswerText({ files: [{}, {}] })).toBe('Uploaded 2 files')
    expect(uploadAnswerText({ files: [], skipped: true })).toBe('Skipped')
  })
})

describe('handoverLine', () => {
  it('hands over the first narration line to be heard', () => {
    expect(handoverLine([{ name: 'Generated Narration.wav', type: 'audio/wav' }])).toBe("Here's the narration.")
    expect(handoverLine([{ name: 'Opening line.wav', type: 'audio/wav' }])).toBe("Here's Opening line.")
  })
  it('hands over what the part made in one line', () => {
    expect(handoverLine([{ name: 'Scene 1 Still — Ishita.png', type: 'image/png' }])).toBe("Here's Scene 1 Still — Ishita.")
    expect(handoverLine([{ name: 'Scene 2.png', type: 'image/png' }, { name: 'Scene 3.png', type: 'image/png' }])).toBe('Here are Scene 2 and Scene 3.')
  })
  it('says nothing for working files or non-media', () => {
    expect(handoverLine([{ name: 'a.png', type: 'image/png', working: true }, { name: 'notes.md', type: 'text/markdown' }])).toBe('')
  })
})

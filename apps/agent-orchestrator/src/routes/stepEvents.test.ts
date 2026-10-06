import { describe, it, expect } from 'vitest'
import { stepStart, stepEnd } from './stepEvents.js'

describe('step events', () => {
  it('turns known tools into steps and ignores the rest', () => {
    expect(stepStart('generate_narration', 'a')).toMatchObject({ key: 'voice', label: 'Voice', kind: 'voice', state: 'running', count: 1 })
    expect(stepStart('assemble-clips', 'b')).toMatchObject({ key: 'join', kind: 'join' })
    expect(stepStart('updateWorkingMemory', 'c')).toBeNull()
    expect(stepStart('agent-director', 'd')).toBeNull()
  })
  it('names a storyboard and counts a batch', () => {
    expect(stepStart('generate_image', 'e', { title: 'Piko — storyboard sheet' })).toMatchObject({ key: 'storyboard', label: 'Storyboard' })
    expect(stepStart('generate_images', 'f', { items: [{}, {}, {}, {}] })).toMatchObject({ key: 'pictures', count: 4 })
  })
  it('keeps one id per call and marks failures and failed checks', () => {
    const s = stepStart('check_clip', 'g')!
    expect(stepStart('check_clip', 'g')!.id).toBe(s.id)
    expect(stepEnd(s, { passed: true }).state).toBe('done')
    expect(stepEnd(s, { passed: false }).state).toBe('failed')
    expect(stepEnd(stepStart('generate_video', 'h')!, { refused: true }).state).toBe('failed')
    expect(stepEnd(stepStart('generate_videos', 'i')!, { failed: 2, succeeded: 0 }).state).toBe('failed')
    expect(stepEnd(stepStart('generate_image', 'j')!, { cancelled: true }).state).toBe('skipped')
    expect(stepEnd(stepStart('generate_image', 'k')!, { refused: true, insufficientCredits: true }).state).toBe('credits')
  })
})

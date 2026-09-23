import { describe, it, expect } from 'vitest'
import { UGC_CHARACTER_CONTRACT } from '../platformAgent.js'

describe('UGC_CHARACTER_CONTRACT', () => {
  it('tells Olmo to delegate whole stages in one delegation, not one beat at a time', () => {
    expect(UGC_CHARACTER_CONTRACT).toContain('ALL beats')
    expect(UGC_CHARACTER_CONTRACT).toContain('in ONE delegation')
  })

  it('no longer tells Olmo that every beat needs its own separate approval', () => {
    expect(UGC_CHARACTER_CONTRACT).not.toContain('there is no single approval that covers the whole board today')
  })

  it('still requires the cast sheet first and board approval before any video', () => {
    expect(UGC_CHARACTER_CONTRACT).toContain('generate the cast sheet')
    expect(UGC_CHARACTER_CONTRACT).toContain('approve the set as a whole')
  })
})

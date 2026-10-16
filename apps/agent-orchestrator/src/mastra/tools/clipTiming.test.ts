// Clip timing is one shared rule (user, 2026-10-16): the TVC solved short shots by generating longer at
// real speed and trimming; the remake re-solved it by speeding clips up 1.3-3x. Both now call this core.
import { describe, it, expect } from 'vitest'
import { generateSeconds, clipFit, pickLength, MAX_SPEEDUP, WARM_UP_S } from './clipTiming.js'

describe('generateSeconds', () => {
  it('covers the shot plus the warm-up and a margin, in whole seconds, 3-10', () => {
    expect(generateSeconds(1.2, { continuing: false })).toBe(3)
    expect(generateSeconds(2.5, { continuing: false })).toBe(4)
    expect(generateSeconds(4, { continuing: false })).toBe(5)
    expect(generateSeconds(9.8, { continuing: false })).toBe(10)
  })
  it('a continuing shot has no warm-up (it is trimmed from 0)', () => {
    expect(generateSeconds(3.1, { continuing: true })).toBe(4)
    expect(generateSeconds(2.5, { continuing: true })).toBe(3)
  })
  it('with fixed model lengths, the smallest that covers the shot; none when too long', () => {
    expect(generateSeconds(2.37, { continuing: true, lengths: [4, 6, 8], warmUpS: 0, marginS: 0 })).toBe(4)
    expect(generateSeconds(4.5, { continuing: false, lengths: [4, 6, 8], warmUpS: 0, marginS: 0 })).toBe(6)
    expect(generateSeconds(8.5, { continuing: false, lengths: [4, 6, 8], warmUpS: 0, marginS: 0 })).toBeUndefined()
  })
})

describe('clipFit', () => {
  it('a clip barely longer than the shot is retimed (the last frame stays exact)', () => {
    expect(clipFit(4, 3.6, 0)).toEqual({ mode: 'retime' })
    expect(4 / 3.6).toBeLessThanOrEqual(MAX_SPEEDUP)
  })
  it('a clip much longer than the shot is trimmed at real speed, never sped up', () => {
    expect(clipFit(4, 1.3, 0)).toEqual({ mode: 'trim', startS: 0 })
    expect(clipFit(4, 2.37, 0)).toEqual({ mode: 'trim', startS: 0 })
  })
  it('a clip with a warm-up is always trimmed past it', () => {
    expect(clipFit(5, 3.9, WARM_UP_S)).toEqual({ mode: 'trim', startS: 0.4 })
    expect(clipFit(4, 3.9, WARM_UP_S)).toEqual({ mode: 'trim', startS: 0.1 }) // never past the clip's end
  })
})

describe('fixed lengths prefer an unnoticeable retime, else trim', () => {
  it('a length within 1.15x either way is retimed (keeps the last frame); otherwise the smallest covering one is trimmed', () => {
    expect(pickLength(4.1, [4, 6, 8])).toEqual({ seconds: 4, fit: { mode: 'retime' } })
    expect(pickLength(5.9, [4, 6, 8])).toEqual({ seconds: 6, fit: { mode: 'retime' } })
    expect(pickLength(1.3, [4, 6, 8])).toEqual({ seconds: 4, fit: { mode: 'trim', startS: 0 } })
    expect(pickLength(4.8, [4, 6, 8])).toEqual({ seconds: 6, fit: { mode: 'trim', startS: 0 } })
    expect(pickLength(8.5, [4, 6, 8])).toEqual({ seconds: 8, fit: { mode: 'retime' } })
    expect(pickLength(9.5, [4, 6, 8])).toBeUndefined()
  })
})

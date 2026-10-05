import { describe, it, expect } from 'vitest'
import { signoffFilter, signoffWindow } from './jingleCut.js'

const line = { start: 22.1, end: 25.0, text: 'Bubbli, feel the magic' }

describe('signoffWindow (J4)', () => {
  it('starts 0.15s early and ends at the first silence after the line', () => {
    expect(signoffWindow(line, [[0.6, 2]], 30.77)).toEqual({ start: 21.95, end: 25.6 })
  })
  it('ends at the line end when the silence starts right there', () => {
    expect(signoffWindow(line, [[0, 1]], 30.77)).toEqual({ start: 21.95, end: 25 })
  })
  it('lets a held note ring for at most 2s when no silence is found', () => {
    expect(signoffWindow(line, [], 30.77)).toEqual({ start: 21.95, end: 27 })
  })
  it('never runs past the clip, and never starts before 0', () => {
    expect(signoffWindow({ start: 0.1, end: 29.5, text: 'x' }, [], 30.77)).toEqual({ start: 0, end: 30.77 })
  })
})

describe('signoffFilter (J4)', () => {
  it('fades in over 20ms and out over the last 0.9s', () => {
    expect(signoffFilter(3.65)).toBe('afade=t=in:d=0.02,afade=t=out:st=2.75:d=0.9')
  })
  it('fades a cut shorter than 0.9s over its whole length', () => {
    expect(signoffFilter(0.6)).toBe('afade=t=in:d=0.02,afade=t=out:st=0:d=0.6')
  })
})

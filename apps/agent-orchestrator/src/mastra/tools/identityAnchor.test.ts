import { describe, expect, it } from 'vitest'
import { withIdentityAnchor } from './identityAnchor.js'

const anchor = { terseTag: 'the man in the green t-shirt', styleLock: 'natural window light, 35mm' }

describe('withIdentityAnchor', () => {
  it('leaves a prompt that already has both strings alone', () => {
    const p = 'the man in the green t-shirt bites the bar, natural window light, 35mm'
    expect(withIdentityAnchor(p, anchor)).toBe(p)
  })
  it('adds the missing tag first and the missing look last (the wafer Beat 4 refusal)', () => {
    expect(withIdentityAnchor('Samir holds up the bar and smiles.', anchor))
      .toBe('the man in the green t-shirt. Samir holds up the bar and smiles. natural window light, 35mm.')
  })
  it('does nothing without an anchor', () => {
    expect(withIdentityAnchor('x', undefined)).toBe('x')
  })
})

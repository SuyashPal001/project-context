import { describe, it, expect } from 'vitest'
import { stubSpec } from '../stub.js'
import { NEGATIVE_CLAUSE } from '../spec.js'

describe('smoke stub spec', () => {
  it('is a valid spec with a discriminating description', () => {
    expect(NEGATIVE_CLAUSE.test(stubSpec.description)).toBe(true)
    expect(stubSpec.id).toBe('smoke')
  })

  it('costs nothing, so the credit gate can be tested by lowering a balance rather than by spending', () => {
    expect(stubSpec.estimatedCredits).toBe(0)
  })

  it('cannot re-delegate', () => {
    expect(stubSpec.maxDepth).toBe(0)
  })
})

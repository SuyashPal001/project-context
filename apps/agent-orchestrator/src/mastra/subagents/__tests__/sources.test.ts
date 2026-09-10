import { describe, it, expect } from 'vitest'
import { listSpecs, getSpec, maxDepthForHost, hostAllows, assertRegistryValid, OLMO_HOST_MAX_DEPTH } from '../sources.js'
import { NEGATIVE_CLAUSE } from '../spec.js'

describe('code spec source', () => {
  it('registers the four existing delegates', () => {
    expect(listSpecs().map(s => s.id).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
  })

  it('gives every spec a description with a negative clause', () => {
    for (const spec of listSpecs()) expect(NEGATIVE_CLAUSE.test(spec.description)).toBe(true)
  })

  it('gives every spec a step budget that is not Mastra default of 5', () => {
    for (const spec of listSpecs()) expect(spec.maxSteps).toBeGreaterThanOrEqual(1)
  })

  it('leaves every code delegate unable to re-delegate', () => {
    for (const spec of listSpecs()) expect(spec.maxDepth).toBe(0)
  })

  it('resolves a spec by id and returns undefined for an unknown one', () => {
    expect(getSpec('director')?.id).toBe('director')
    expect(getSpec('nope')).toBeUndefined()
  })

  it('gives the olmo host a depth of 1 and every other host 0', () => {
    expect(maxDepthForHost('olmo')).toBe(OLMO_HOST_MAX_DEPTH)
    expect(maxDepthForHost('research engineer')).toBe(0)
    expect(maxDepthForHost('')).toBe(0)
  })

  it('allows every registered spec for the olmo host only', () => {
    const director = getSpec('director')!
    expect(hostAllows('olmo', director)).toBe(true)
    expect(hostAllows('director', director)).toBe(false)
  })

  it('rejects a fallback pointing at itself', () => {
    const self = { ...getSpec('pm')!, fallback: 'pm' }
    expect(() => assertRegistryValid([self])).toThrow(/itself/)
  })

  it('rejects a fallback pointing at an unregistered id', () => {
    const dangling = { ...getSpec('pm')!, fallback: 'ghost' }
    expect(() => assertRegistryValid([dangling])).toThrow(/ghost/)
  })

  it('rejects duplicate ids', () => {
    const pm = getSpec('pm')!
    expect(() => assertRegistryValid([pm, pm])).toThrow(/duplicate/i)
  })
})

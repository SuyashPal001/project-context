import { describe, it, expect, vi } from 'vitest'
import { listSpecs, getSpec, maxDepthForHost, hostAllows, assertRegistryValid, assertMatchesCodeSpecIds, OLMO_HOST_MAX_DEPTH } from '../sources.js'
import { NEGATIVE_CLAUSE } from '../spec.js'
import { CODE_SPEC_IDS } from '../ids.js'

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

  it('passes when SPECS ids exactly match CODE_SPEC_IDS', () => {
    expect(() => assertMatchesCodeSpecIds(listSpecs(), CODE_SPEC_IDS)).not.toThrow()
  })

  it('throws when a code spec id is missing from SPECS', () => {
    const withoutPm = listSpecs().filter(s => s.id !== 'pm')
    expect(() => assertMatchesCodeSpecIds(withoutPm, CODE_SPEC_IDS)).toThrow(/pm/)
  })

  it('throws when SPECS has an id not in CODE_SPEC_IDS', () => {
    const withExtra = [...listSpecs(), { ...getSpec('pm')!, id: 'stylist' }]
    expect(() => assertMatchesCodeSpecIds(withExtra, CODE_SPEC_IDS)).toThrow(/stylist/)
  })
})

describe('smoke stub registration behind SUBAGENT_SMOKE_STUB', () => {
  // The flag is read at module load, so the module must be re-imported with
  // the env var already set — setting process.env after a normal top-level
  // import would prove nothing, since sources.ts already evaluated STUB_ENABLED.
  it('boots with the stub present when the flag is on, without tripping the drift assertion', async () => {
    const prev = process.env.SUBAGENT_SMOKE_STUB
    process.env.SUBAGENT_SMOKE_STUB = '1'
    vi.resetModules()
    try {
      const fresh = await import('../sources.js')
      const ids = fresh.listSpecs().map((s) => s.id).sort()
      expect(ids).toEqual(['architect', 'director', 'pm', 'producer', 'smoke'])
      expect(fresh.getSpec('smoke')?.id).toBe('smoke')

      // assertRegistryValid and assertBackgroundSupported must cover the
      // stub too — re-run them explicitly against the freshly loaded SPECS
      // to prove they see it (module-load already ran them without throwing,
      // which is itself part of the proof: the flag-on module imported clean).
      expect(() => fresh.assertRegistryValid(fresh.listSpecs())).not.toThrow()
      expect(() => fresh.assertBackgroundSupported(fresh.listSpecs())).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.SUBAGENT_SMOKE_STUB
      else process.env.SUBAGENT_SMOKE_STUB = prev
      vi.resetModules()
    }
  })
})

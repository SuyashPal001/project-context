import { describe, it, expect, vi } from 'vitest'
import { estimateCost, ledgerSummary, credits } from './cost.js'
import { writePlan } from './plan.js'
import { breakdown } from './fixtures.testing.js'

const plan = () => writePlan(breakdown(), { name: 'B', product: 'p' }, vi.fn().mockResolvedValue({ lines: [] }))

describe('estimateCost', () => {
  it('counts the casting sheet plus one still per look plus end stills; max allows one retry per still', async () => {
    const e = estimateCost(await plan(), { castProvided: false, microEach: 1_000_000n })
    expect(e.images).toBe(5) // casting sheet + reference sheet + a start + b start + b end
    expect(e.firstPassMicro).toBe('5000000')
    expect(e.maxMicro).toBe('8000000') // both sheets once + 3 stills twice
  })
  it('skips the casting sheet, not the reference sheet, when the user brings their own person', async () => {
    expect(estimateCost(await plan(), { castProvided: true, microEach: 1_000_000n }).images).toBe(4)
  })
  it('says unknown, never zero, when the rate is missing', async () => {
    expect(estimateCost(await plan(), { castProvided: false, microEach: null }).firstPassMicro).toBeNull()
  })
})

describe('ledgerSummary', () => {
  it('splits spent from wasted on retries and lists failed and blocked items', () => {
    const s = ledgerSummary([
      { item: 'look 1 start still', attempt: 0, creditsMicro: '100', outcome: 'retried' },
      { item: 'look 1 start still', attempt: 1, creditsMicro: '100', outcome: 'kept' },
      { item: 'look 2 start still', attempt: 0, creditsMicro: '100', outcome: 'retried' },
      { item: 'look 2 start still', attempt: 1, creditsMicro: '100', outcome: 'failed' },
      { item: 'look 3 start still', attempt: 0, creditsMicro: '0', outcome: 'blocked' },
    ])
    expect(s).toEqual({ spentMicro: '400', wastedMicro: '300', failed: ['look 2 start still'], blocked: ['look 3 start still'] })
  })
  it('formats credits', () => {
    expect(credits('1234567')).toBe('1.23')
    expect(credits(null)).toBe('unknown')
  })
})

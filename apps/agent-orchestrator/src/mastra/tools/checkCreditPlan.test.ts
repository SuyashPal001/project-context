import { describe, it, expect, vi } from 'vitest'

vi.mock('../../credits.js', () => ({ BALANCE_QUERY: 'select 1' }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
vi.mock('@serverless-saas/credits', () => ({ costMicro: vi.fn(), resolveRate: vi.fn() }))

import { computeCreditPlan, type StepKind } from './checkCreditPlan.js'

const CREDIT = 1_000_000n
const prices: Record<StepKind, bigint | null> = {
  image: 2n * CREDIT,
  video: 10n * CREDIT,
  narration: 1n * CREDIT,
  music: 3n * CREDIT,
  lipsync: 5n * CREDIT,
  lipsync_hq: 50n * CREDIT,
  edit: 1n * CREDIT,
}

const deps = (balanceMicro: bigint, unlimited = false, over: Partial<typeof prices> = {}) => ({
  priceMicro: async (k: StepKind) => ({ ...prices, ...over })[k],
  readBalance: async () => ({ unlimited, balanceMicro }),
})

describe('computeCreditPlan', () => {
  it('reports no shortfall and no options when balance covers the plan', async () => {
    const r = await computeCreditPlan([{ kind: 'video', count: 3 }], deps(100n * CREDIT))
    expect(r.fullCostCredits).toBe(30)
    expect(r.balanceCredits).toBe(100)
    expect(r.shortfallCredits).toBe(0)
    expect(r.options).toEqual([])
  })

  it('offers hero-clip and fewer-clips options that fit, plus top-up, on a shortfall', async () => {
    // 4 videos + 4 images = 48; balance 30
    const r = await computeCreditPlan(
      [{ kind: 'video', count: 4 }, { kind: 'image', count: 4 }],
      deps(30n * CREDIT),
    )
    expect(r.fullCostCredits).toBe(48)
    expect(r.shortfallCredits).toBe(18)
    const labels = r.options.map((o) => o.label)
    expect(labels).toEqual(['Hero clip only', 'Fewer clips', 'Top up credits'])
    expect(r.options[0].costCredits).toBe(12) // 1 video + 1 image
    expect(r.options[1].costCredits).toBe(24) // 2 videos + 2 images
    expect(r.options[2].costCredits).toBe(48)
  })

  it('drops cheaper options that still exceed the balance but keeps top-up', async () => {
    const r = await computeCreditPlan([{ kind: 'video', count: 4 }], deps(5n * CREDIT))
    expect(r.options.map((o) => o.label)).toEqual(['Top up credits'])
  })

  it('does not list a duplicate option when hero and fewer cost the same', async () => {
    // 2 videos: hero = 1, fewer = ceil(2/2) = 1
    const r = await computeCreditPlan([{ kind: 'video', count: 2 }], deps(15n * CREDIT))
    expect(r.options.map((o) => o.label)).toEqual(['Hero clip only', 'Top up credits'])
  })

  it('never reports a shortfall for an unlimited tenant', async () => {
    const r = await computeCreditPlan([{ kind: 'video', count: 50 }], deps(0n, true))
    expect(r.unlimited).toBe(true)
    expect(r.shortfallCredits).toBe(0)
    expect(r.options).toEqual([])
  })

  it('flags an unreadable balance as unknown rather than zero', async () => {
    const r = await computeCreditPlan([{ kind: 'video', count: 1 }], {
      priceMicro: async (k) => prices[k],
      readBalance: async () => { throw new Error('db down') },
    })
    expect(r.balanceUnknown).toBe(true)
    expect(r.balanceCredits).toBeNull()
    expect(r.shortfallCredits).toBe(0)
    expect(r.options).toEqual([])
  })

  it('reports kinds with no active rate instead of pricing them silently as free', async () => {
    const r = await computeCreditPlan(
      [{ kind: 'video', count: 1 }, { kind: 'music', count: 1 }],
      deps(100n * CREDIT, false, { music: null }),
    )
    expect(r.unpricedKinds).toEqual(['music'])
    expect(r.fullCostCredits).toBe(10)
  })

  it('merges repeated kinds before pricing', async () => {
    const r = await computeCreditPlan(
      [{ kind: 'video', count: 1 }, { kind: 'video', count: 2 }],
      deps(100n * CREDIT),
    )
    expect(r.fullCostCredits).toBe(30)
  })
})

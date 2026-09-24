import { describe, it, expect, vi } from 'vitest'
import { runBatch } from './batchRunner.js'

describe('runBatch', () => {
  it('runs items concurrently, not one after another', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const out = await runBatch([0, 1, 2], async (_item, index) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight -= 1
      return { fileId: `f${index}` }
    })
    // All three were in flight at once. This is the overlap proof; there is
    // deliberately no wall-clock bound, which would be flaky on shared CI.
    expect(maxInFlight).toBe(3)
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2])
    expect(out).toMatchObject({ succeeded: 3, failed: 0 })
  })

  it('turns a thrown item into a GENERATION_FAILED refusal without failing its siblings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await runBatch(['a', 'b', 'c'], async (_item, index) => {
      if (index === 1) throw new Error('boom')
      return { fileId: `f${index}` }
    })
    expect(out.results[1]).toEqual({ index: 1, refused: true, refusalReason: 'GENERATION_FAILED' })
    expect(out.results[0]).toEqual({ index: 0, fileId: 'f0' })
    expect(out.results[2]).toEqual({ index: 2, fileId: 'f2' })
    expect(out).toMatchObject({ succeeded: 2, failed: 1 })
    errorSpy.mockRestore()
  })

  it('counts refusals and insufficient-credit results as failed, not succeeded', async () => {
    const out = await runBatch([0, 1, 2], async (_item, index) => {
      if (index === 0) return { fileId: 'f0' }
      if (index === 1) return { refused: true, refusalReason: 'IDENTITY_ANCHOR_MISSING' }
      return { insufficientCredits: true }
    })
    expect(out).toMatchObject({ succeeded: 1, failed: 2 })
  })

  it('fires onItemSettled as each item finishes, not just once at the end', async () => {
    const seen: Array<{ index: number; total: number; fileId?: unknown; refused?: unknown }> = []
    const delays = [50, 0, 20]
    const out = await runBatch(
      [0, 1, 2],
      async (_item, index) => {
        if (index === 1) throw new Error('boom')
        await new Promise((r) => setTimeout(r, delays[index]))
        return { fileId: `f${index}` }
      },
      (index, total, item) => { seen.push({ index, total, fileId: item.fileId, refused: item.refused }) },
    )
    // Fastest-settling item first (1: throws immediately, then 2: 20ms, then
    // 0: 50ms) proves the callback fires per-item as it completes, not
    // batched until the whole call returns.
    expect(seen.map((s) => s.index)).toEqual([1, 2, 0])
    expect(seen).toEqual(expect.arrayContaining([
      { index: 0, total: 3, fileId: 'f0', refused: undefined },
      { index: 1, total: 3, fileId: undefined, refused: true },
      { index: 2, total: 3, fileId: 'f2', refused: undefined },
    ]))
    expect(out.results).toHaveLength(3)
  })
})

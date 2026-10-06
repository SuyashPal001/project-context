import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
const { fetchBase64 } = vi.hoisted(() => ({ fetchBase64: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })) }))
vi.mock('./checkClip.js', () => ({ fetchBase64 }))
const { runStillChecks } = vi.hoisted(() => ({ runStillChecks: vi.fn() }))
vi.mock('./tvcChecks.js', async (orig) => {
  const actual = await orig<typeof import('./tvcChecks.js')>()
  return { ...actual, runStillChecks, gatewayAsk: () => async () => ({}) }
})

import { checkStill, stillPassedCheck, markStillPassed } from './checkStill.js'
import { CheckUnavailableError } from './tvcChecks.js'
import { setCheckRecordStore } from './tvcCheckRecords.js'
import { inMemoryThreadStore } from './tvcCheckRecords.testing.js'

const scope = (threadId = 'c-still') => ({ threadId, resourceId: 't1' })
function ctx(conv = 'c-still') {
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', conversationId: conv, idToken: 'tok' })) rc.set(k, v)
  return { requestContext: rc } as never
}

beforeEach(() => {
  runStillChecks.mockReset()
  setCheckRecordStore(inMemoryThreadStore(['c-still', 'a', 'b'].map((id) => ({ id, resourceId: 't1' }))).store)
})

describe('check_still', () => {
  it('records a passing still so plan_tvc will accept it', async () => {
    runStillChecks.mockResolvedValue({ passed: true, reasons: [] })
    const r = await checkStill.execute!({ stillFileId: 's1', productFileId: 'p1', productScale: 'close', productMustBeVisible: true } as never, ctx())
    expect(r).toMatchObject({ passed: true })
    expect(await stillPassedCheck(scope(), 's1')).toBe(true)
  })
  it('a failing still is not recorded and returns the reasons', async () => {
    runStillChecks.mockResolvedValue({ passed: false, reasons: ['LEAD_CLONED: a background person looks like the lead (frame 1: left).'] })
    const r = await checkStill.execute!({ stillFileId: 's2', actorFileId: 'av1', expectExtras: true } as never, ctx())
    expect(r).toMatchObject({ passed: false, reason: expect.stringMatching(/LEAD_CLONED/) })
    expect(await stillPassedCheck(scope(), 's2')).toBe(false)
  })
  it('an unreachable check is CHECK_UNAVAILABLE, never a pass', async () => {
    runStillChecks.mockRejectedValue(new CheckUnavailableError('check unavailable: gateway 500'))
    const r = await checkStill.execute!({ stillFileId: 's3' } as never, ctx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/) })
    expect(await stillPassedCheck(scope(), 's3')).toBe(false)
  })
  it('a plain Error from the check path is also CHECK_UNAVAILABLE, never CHECK_FAILED or a crash', async () => {
    runStillChecks.mockRejectedValue(new Error('boom'))
    const r = await checkStill.execute!({ stillFileId: 's4' } as never, ctx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/) })
    expect(await stillPassedCheck(scope(), 's4')).toBe(false)
  })
  it('passed stills are per conversation', async () => {
    await markStillPassed(scope('a'), 'x')
    expect(await stillPassedCheck(scope('a'), 'x')).toBe(true)
    expect(await stillPassedCheck(scope('b'), 'x')).toBe(false)
  })
  it('a pass that cannot be stored says so (CHECK_RECORD_UNAVAILABLE)', async () => {
    runStillChecks.mockResolvedValue({ passed: true, reasons: [] })
    const r = await checkStill.execute!({ stillFileId: 's5' } as never, ctx('not-a-thread'))
    expect(r).toMatchObject({ passed: true, reason: expect.stringMatching(/CHECK_RECORD_UNAVAILABLE/) })
  })
})

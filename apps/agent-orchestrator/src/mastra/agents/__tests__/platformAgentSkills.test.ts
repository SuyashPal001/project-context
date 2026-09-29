import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

// Same pg-mock pattern as usage.test.ts, but the DB pool import is one level
// deeper here (__tests__ -> agents -> mastra -> src), and this file exercises
// the resolver through the real platformAgent module rather than importing
// usage.ts's exports directly.
//
// mockPoolQuery dispatches on the SQL text rather than call order: the
// resolver's Promise.all fires fetchAttachedSkills / fetchInvokedSkills /
// fetchOfficialSkills concurrently, and their relative query timing is an
// implementation detail this test should not depend on.
const mockPoolQuery = vi.fn()
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/ai', () => ({ getAgentTools: vi.fn() }))
vi.mock('../../../db.js', () => ({ makeAppPool: vi.fn(() => ({ query: mockPoolQuery, on: vi.fn() })) }))

import { platformAgent } from '../platformAgent.js'

// A single monotonic fake clock for the whole file: reinstalling fake timers
// per-test resets to the real wall clock each time, which lets a cache entry
// set with an earlier test's virtual "now" outlive a later test's rebased
// "now" and mask that test's own query (fetchOfficialSkills caches for 60s
// in usage.ts, keyed off Date.now()). One clock, only ever advanced forward,
// keeps that cache math honest across tests in this file.
beforeAll(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  mockPoolQuery.mockReset()
  // Bust fetchOfficialSkills' 60s cache before every test in this file so a
  // prior test's cached Official-skill content never leaks into this one.
  vi.advanceTimersByTime(61_000)
})

describe('platformAgent skills resolver — Official skills', () => {
  it('lists an Official skill once when an attached skill shares its name, preferring the attached content', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_skills')) {
        return Promise.resolve({ rows: [
          { name: 'Bid Writer', system_prompt: 'Attached version body.', install_id: null, version: 1 },
        ] })
      }
      if (sql.includes('s.is_official = true')) {
        return Promise.resolve({ rows: [
          { name: 'Bid Writer', description: 'Use when writing official bids.', body: 'Official version body.' },
        ] })
      }
      return Promise.resolve({ rows: [] })
    })

    const requestContext = new RequestContext()
    requestContext.set('tenantId', 'tenant-1')
    requestContext.set('agentId', 'agent-1')

    const skills = await platformAgent.listSkills({ requestContext })
    const matches = skills.filter((s) => s.name === 'bid-writer')
    expect(matches).toHaveLength(1)

    // Proves fetchOfficialSkills is actually wired into the resolver — this
    // assertion is what makes the test fail before Task 2's implementation,
    // since the old resolver's Promise.all never issues this query at all.
    expect(mockPoolQuery.mock.calls.some(([sql]) => String(sql).includes('s.is_official = true'))).toBe(true)

    // mergeSkillSets(mergeSkillSets(attached, invoked), official) — the
    // attached/invoked composite wins the name clash over Official.
    const skill = await platformAgent.getSkill('bid-writer', { requestContext })
    expect(skill?.instructions).toBe('Attached version body.')
  })

  it('includes an Official skill with no attached/invoked counterpart', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM agent_skills')) return Promise.resolve({ rows: [] })
      if (sql.includes('s.is_official = true')) {
        return Promise.resolve({ rows: [
          { name: 'Talking Head', description: 'Use when making a talking-head ad.', body: 'Talking head body.' },
        ] })
      }
      return Promise.resolve({ rows: [] })
    })

    const requestContext = new RequestContext()
    requestContext.set('tenantId', 'tenant-1')
    requestContext.set('agentId', 'agent-1')

    const skills = await platformAgent.listSkills({ requestContext })
    expect(skills.map((s) => s.name)).toContain('talking-head')
  })
})

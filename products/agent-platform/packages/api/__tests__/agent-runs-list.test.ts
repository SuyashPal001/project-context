import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const dbOffset = vi.fn().mockResolvedValue([{ id: 'run-1' }])
const dbLimit = vi.fn(() => ({ offset: dbOffset }))
const dbOrderBy = vi.fn(() => ({ limit: dbLimit }))
const dbWhereSelect = vi.fn(() => ({ orderBy: dbOrderBy }))
const dbFrom = vi.fn(() => ({ where: dbWhereSelect }))
let selectCallCount = 0
const db = {
  select: vi.fn((..._args: unknown[]) => {
    selectCallCount++
    if (selectCallCount === 1) {
      // count() query
      return { from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ value: 7 }]) })) }
    }
    return { from: dbFrom }
  }),
}
vi.mock('../db', () => ({ db }))
vi.mock('@serverless-saas/agent-schema/agents', () => ({ agentWorkflowRuns: { tenantId: 'tenantId', agentId: 'agentId', startedAt: 'startedAt' } }))
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: vi.fn().mockReturnValue(true) }))

// Hono context vars (`c.get('requestContext')`) are not settable via a third
// argument to `.request()` — the codebase's established pattern (see
// __tests__/agent-runs-approve.test.ts) wraps the router under test in an
// app that sets them via middleware first.
function appWithContext(permissions: unknown[]) {
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: 't1' }, permissions })
    await next()
  })
  return app
}

describe('GET /agent-runs', () => {
  beforeEach(() => { vi.clearAllMocks(); selectCallCount = 0 })

  it('returns the {runs, total, page, totalPages} shape the web page expects', async () => {
    const { agentRunsRoutes } = await import('../routes/agent-runs')
    const app = appWithContext(['agents:read'])
    app.route('/agent-runs', agentRunsRoutes)

    const res = await app.request('/agent-runs?page=2&pageSize=3')
    expect(res.status).toBe(200)
    const body = await res.json() as { runs: unknown[]; total: number; page: number; totalPages: number }
    expect(body).toMatchObject({ runs: [{ id: 'run-1' }], total: 7, page: 2, totalPages: 3 })
    expect(dbLimit).toHaveBeenCalledWith(3)
    expect(dbOffset).toHaveBeenCalledWith(3) // (page 2 - 1) * pageSize 3
  })
})

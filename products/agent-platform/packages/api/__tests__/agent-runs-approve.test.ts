import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const dbReturning = vi.fn()
const dbWhere = vi.fn(() => ({ returning: dbReturning }))
const dbSet = vi.fn(() => ({ where: dbWhere }))
const db = {
  update: vi.fn(() => ({ set: dbSet })),
  insert: vi.fn(() => ({ values: vi.fn().mockReturnValue({ catch: vi.fn() }) })),
}
vi.mock('../db', () => ({ db }))
vi.mock('@serverless-saas/agent-schema/agents', () => ({ agentWorkflowRuns: {
  id: 'id', tenantId: 'tenantId', status: 'status', pendingApproval: 'pendingApproval',
} }))
vi.mock('@serverless-saas/database/schema/audit', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: vi.fn() }))

process.env.AGENT_ORCHESTRATOR_URL = 'http://orchestrator.test'
process.env.INTERNAL_SERVICE_KEY = 'test-key'

// Hono context vars (`c.get('requestContext')`, `c.get('userId')`) are not
// settable via a third argument to `.request()` — the codebase's established
// pattern (see __tests__/assets.test.ts, __tests__/conversations.persona.test.ts)
// wraps the router under test in an app that sets them via middleware first.
function appWithContext(permissions: unknown[]) {
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: 't1' }, permissions })
    c.set('userId', 'u1')
    await next()
  })
  return app
}

describe('PUT /agent-runs/:id/approve', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('403s without agent_runs:update', async () => {
    const { hasPermission } = await import('@serverless-saas/permissions')
    vi.mocked(hasPermission).mockReturnValue(false)
    const { agentRunsRoutes } = await import('../routes/agent-runs')
    const app = appWithContext([])
    app.route('/agent-runs', agentRunsRoutes)

    const res = await app.request('/agent-runs/run-1/approve', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    expect(res.status).toBe(403)
  })

  it('409s when the run is not awaiting_approval (double-approval race)', async () => {
    const { hasPermission } = await import('@serverless-saas/permissions')
    vi.mocked(hasPermission).mockReturnValue(true)
    dbReturning.mockResolvedValue([]) // conditional UPDATE matched zero rows
    const { agentRunsRoutes } = await import('../routes/agent-runs')
    const app = appWithContext(['agent_runs:update'])
    app.route('/agent-runs', agentRunsRoutes)

    const res = await app.request('/agent-runs/run-1/approve', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    expect(res.status).toBe(409)
  })

  it('forwards resumeLabel from the updated row to the orchestrator and audit-logs approval', async () => {
    const { hasPermission } = await import('@serverless-saas/permissions')
    vi.mocked(hasPermission).mockReturnValue(true)
    dbReturning.mockResolvedValue([{ id: 'run-1', pendingApproval: { resumeLabel: 'approve:s1' } }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { agentRunsRoutes } = await import('../routes/agent-runs')
    const app = appWithContext(['agent_runs:update'])
    app.route('/agent-runs', agentRunsRoutes)

    const res = await app.request('/agent-runs/run-1/approve', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })

    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledWith(
      'http://orchestrator.test/api/workflows/run-1/resume',
      expect.objectContaining({ body: JSON.stringify({ tenantId: 't1', approved: true, resumeLabel: 'approve:s1' }) }),
    )
    expect(db.insert).toHaveBeenCalled()
  })
})

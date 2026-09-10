import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbMock = vi.hoisted(() => {
  const dbWhere = vi.fn().mockResolvedValue(undefined)
  const dbSet = vi.fn().mockReturnValue({ where: dbWhere })
  return {
    update: vi.fn().mockReturnValue({ set: dbSet }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ catch: vi.fn() }) }),
    dbSet,
    dbWhere,
  }
})

vi.mock('../db', () => ({ db: dbMock }))
vi.mock('@serverless-saas/agent-schema/agents', () => ({ agentWorkflowRuns: {} }))
vi.mock('@serverless-saas/database/schema/audit', () => ({ auditLog: {} }))

process.env.INTERNAL_SERVICE_KEY = 'test-key'

describe('POST /internal/workflows/:workflowRunId/update', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('persists mastraRunId and awaiting_approval status', async () => {
    const { internalWorkflowsRoute } = await import('../routes/internal/workflows')
    const res = await internalWorkflowsRoute.request('/run-1/update', {
      method: 'POST',
      headers: { 'x-internal-service-key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mastraRunId: 'mastra-run-abc', status: 'awaiting_approval' }),
    })
    expect(res.status).toBe(200)
    expect(dbMock.dbSet).toHaveBeenCalledWith(expect.objectContaining({ mastraRunId: 'mastra-run-abc', status: 'awaiting_approval' }))
  })

  it('rejects an unknown status value', async () => {
    const { internalWorkflowsRoute } = await import('../routes/internal/workflows')
    const res = await internalWorkflowsRoute.request('/run-1/update', {
      method: 'POST',
      headers: { 'x-internal-service-key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'bogus' }),
    })
    expect(res.status).toBe(400)
  })
})

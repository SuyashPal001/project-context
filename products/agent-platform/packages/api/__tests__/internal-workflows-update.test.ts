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
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn().mockResolvedValue(undefined) }))

import { pushWebSocketEvent } from '../lib/websocket'

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

  it('persists pendingApproval and pendingApprovalAt, pushes a WS event', async () => {
    const { internalWorkflowsRoute } = await import('../routes/internal/workflows')
    const pendingApproval = { stepId: 's1', title: 'Send email', toolName: 'gmail_send_message', reason: 'requires_approval' as const, resumeLabel: 'approve:s1' }
    const res = await internalWorkflowsRoute.request('/run-1/update', {
      method: 'POST',
      headers: { 'x-internal-service-key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: '11111111-1111-1111-1111-111111111111', status: 'awaiting_approval', pendingApproval, pendingApprovalAt: '2026-01-01T00:00:00.000Z' }),
    })
    expect(res.status).toBe(200)
    expect(dbMock.dbSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'awaiting_approval',
      pendingApproval,
      pendingApprovalAt: new Date('2026-01-01T00:00:00.000Z'),
    }))
    expect(pushWebSocketEvent).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', expect.objectContaining({
      type: 'workflow_run.awaiting_approval',
      workflowRunId: 'run-1',
    }))
  })

  it('clears pendingApproval with an explicit null', async () => {
    const { internalWorkflowsRoute } = await import('../routes/internal/workflows')
    const res = await internalWorkflowsRoute.request('/run-1/update', {
      method: 'POST',
      headers: { 'x-internal-service-key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', pendingApproval: null, pendingApprovalAt: null }),
    })
    expect(res.status).toBe(200)
    expect(dbMock.dbSet).toHaveBeenCalledWith(expect.objectContaining({ pendingApproval: null, pendingApprovalAt: null }))
  })
})

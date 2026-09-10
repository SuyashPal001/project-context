import { describe, it, expect, vi } from 'vitest'
import { recordDelegation } from '../link.js'

const base = {
  tenantId: 't1', agentId: 'a1', conversationId: 'c1',
  primitiveId: 'director', runId: 'run-1', toolCallId: 'call-1',
  success: true, durationMs: 1234,
}

describe('recordDelegation', () => {
  it('inserts one row with the delegation facts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await recordDelegation(base, { pool: { query } })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0]
    expect(sql).toMatch(/insert into agent_delegations/i)
    expect(values).toEqual(['t1', 'a1', 'c1', 'director', 'run-1', 'call-1', true, 1234, null, null])
  })

  it('carries a rejection reason for a refused delegation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await recordDelegation({ ...base, success: false, rejectionReason: 'out of credits' }, { pool: { query } })
    expect(query.mock.calls[0][1][8]).toBe('out of credits')
  })

  it('never throws when the insert fails', async () => {
    const query = vi.fn().mockRejectedValue(new Error('pool down'))
    await expect(recordDelegation(base, { pool: { query } })).resolves.toBeUndefined()
  })

  it('skips the insert when there is no tenant', async () => {
    const query = vi.fn()
    await recordDelegation({ ...base, tenantId: '' }, { pool: { query } })
    expect(query).not.toHaveBeenCalled()
  })
})

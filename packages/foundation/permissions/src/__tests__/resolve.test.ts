import { describe, it, expect, vi } from 'vitest'

const mockDb = { select: vi.fn() }

vi.mock('@serverless-saas/database/schema/tenancy', () => ({
  memberships: { userId: 'memberships.userId', tenantId: 'memberships.tenantId', status: 'memberships.status', roleId: 'memberships.roleId' },
}))
vi.mock('@serverless-saas/database/schema/authorization', () => ({
  rolePermissions: { roleId: 'rolePermissions.roleId', permissionId: 'rolePermissions.permissionId' },
  permissions: { id: 'permissions.id', resource: 'permissions.resource', action: 'permissions.action' },
}))

function chain(rows: unknown[]) {
  // Real Drizzle query builders are thenable at every stage (awaiting without
  // an explicit .limit() still resolves), and .limit() also resolves. Mirror
  // both so the mock works whether the caller stops at .where() or chains
  // .limit() afterwards.
  const result: any = {
    limit: vi.fn(() => Promise.resolve(rows)),
    then: (resolve: (rows: unknown[]) => void) => resolve(rows),
  }
  const q: any = {}
  q.from = vi.fn(() => q)
  q.innerJoin = vi.fn(() => q)
  q.where = vi.fn(() => result)
  return q
}

import { resolveUserPermissions } from '../resolve'

describe('resolveUserPermissions', () => {
  it('returns null when there is no active membership', async () => {
    mockDb.select.mockReturnValueOnce(chain([]))
    const result = await resolveUserPermissions(mockDb as any, 'tenant-1', 'user-1')
    expect(result).toBeNull()
  })

  it('returns the resolved permission set for an active membership', async () => {
    mockDb.select
      .mockReturnValueOnce(chain([{ roleId: 'role-1' }]))
      .mockReturnValueOnce(chain([{ resource: 'agent_tasks', action: 'read' }, { resource: 'billing', action: 'read' }]))
    const result = await resolveUserPermissions(mockDb as any, 'tenant-1', 'user-1')
    expect(result).toEqual([
      { resource: 'agent_tasks', action: 'read' },
      { resource: 'billing', action: 'read' },
    ])
  })
})

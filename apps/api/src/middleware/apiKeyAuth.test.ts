import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { apiKeyAuthMiddleware } from './apiKeyAuth'

const mockApiKeyRow = {
  id: 'key-1',
  tenantId: 'tenant-1',
  keyHash: 'hash',
  type: 'agent' as const,
  permissions: ['agent_tasks:create'],
  status: 'active' as const,
  expiresAt: null,
}

const mockAgentRow = { id: 'agent-1', status: 'active' as const }
const mockMembershipRow = { agentId: 'agent-1', tenantId: 'tenant-1', status: 'active' as const, roleId: 'role-1' }
const mockRolePermissionRows = [
  { resource: 'agent_tasks', action: 'create' },
  { resource: 'agent_tasks', action: 'delete' },
  { resource: 'billing', action: 'read' },
]

// db.select(...).from(...).where(...).limit(1) chain — resolves in call order:
// 1. apiKeys lookup, 2. agents lookup, 3. memberships lookup, 4. permission join (no .limit)
vi.mock('@serverless-saas/database', () => {
  let call = 0
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => {
      call += 1
      if (call === 1) return Promise.resolve([mockApiKeyRow])
      if (call === 2) return Promise.resolve([mockAgentRow])
      if (call === 3) return Promise.resolve([mockMembershipRow])
      return Promise.resolve([])
    },
    then: (resolve: any) => resolve(mockRolePermissionRows), // permission join has no .limit()
  }
  return {
    db: {
      select: () => chain,
      update: () => ({ set: () => ({ where: () => ({ execute: () => Promise.resolve() }) }) }),
    },
  }
})

describe('apiKeyAuthMiddleware', () => {
  beforeEach(() => vi.clearAllMocks())

  it('narrows requestContext.permissions to the intersection of key and role permissions', async () => {
    const app = new Hono()
    app.use('*', apiKeyAuthMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({ permissions: requestContext?.permissions ?? null })
    })

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer ak_testkey' },
    })
    const body = await res.json()

    // Key only grants agent_tasks:create — role also has agent_tasks:delete and
    // billing:read, but those must NOT leak through despite the role permitting them.
    expect(body.permissions).toEqual(['agent_tasks:create'])
  })
})

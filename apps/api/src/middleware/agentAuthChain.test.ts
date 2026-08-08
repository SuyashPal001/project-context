import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { authInjectionMiddleware } from './authInjection'
import { userUpsertMiddleware } from './userUpsert'
import { apiKeyAuthMiddleware } from './apiKeyAuth'
import { tenantResolutionMiddleware } from './tenantResolution'
import { permissionsMiddleware } from './permissions'

// The linkage this test exists to prove: an agent row found via agents.apiKeyId
// (NOT apiKeys.agentId, which no insert in this repo ever populates).
const mockApiKeyRow = {
  id: 'key-1',
  tenantId: 'tenant-1',
  keyHash: 'hash',
  type: 'agent' as const,
  permissions: ['agent_tasks:create'],
  status: 'active' as const,
  expiresAt: null,
}
const mockAgentRow = { id: 'agent-1', apiKeyId: 'key-1', status: 'active' as const }
const mockMembershipRow = { agentId: 'agent-1', tenantId: 'tenant-1', status: 'active' as const, roleId: 'role-1' }
const mockRolePermissionRows = [
  { resource: 'agent_tasks', action: 'create' },
  { resource: 'agent_tasks', action: 'delete' },
]
const mockTenantRow = { id: 'tenant-1', slug: 'acme', status: 'active' as const }

vi.mock('@serverless-saas/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@serverless-saas/cache')>()),
  getCacheClient: () => ({ get: () => Promise.resolve(null), set: () => Promise.resolve() }),
}))

vi.mock('@serverless-saas/database', () => {
  let call = 0
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => {
      call += 1
      if (call === 1) return Promise.resolve([mockApiKeyRow])   // apiKeys lookup by hash
      if (call === 2) return Promise.resolve([mockAgentRow])    // agents lookup by apiKeyId
      if (call === 3) return Promise.resolve([mockMembershipRow]) // memberships lookup
      if (call === 4) return Promise.resolve([mockTenantRow])   // tenants lookup (tenantResolution)
      return Promise.resolve([])
    },
    then: (resolve: any) => resolve(mockRolePermissionRows), // permission join, no .limit()
  }
  return {
    db: {
      select: () => chain,
      update: () => ({ set: () => ({ where: () => ({ execute: () => Promise.resolve() }) }) }),
    },
  }
})

describe('agent request through the real middleware chain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves tenant and narrowed permissions for a valid agent API key end-to-end', async () => {
    const app = new Hono()
    app.use('*', authInjectionMiddleware)
    app.use('*', userUpsertMiddleware)
    app.use('*', apiKeyAuthMiddleware)
    app.use('*', tenantResolutionMiddleware)
    app.use('*', permissionsMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({
        tenant: requestContext?.tenant ?? null,
        permissions: requestContext?.permissions ?? null,
      })
    })

    const res = await app.request('/test', { headers: { Authorization: 'Bearer ak_testkey' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tenant).toEqual({ id: 'tenant-1', slug: 'acme', status: 'active' })
    expect(body.permissions).toEqual(['agent_tasks:create'])
  })
})

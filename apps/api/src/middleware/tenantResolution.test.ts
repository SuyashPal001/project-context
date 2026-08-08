import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { tenantResolutionMiddleware } from './tenantResolution'

const mockTenantRow = { id: 'tenant-1', slug: 'acme', status: 'active' as const }

vi.mock('@serverless-saas/cache', async (importOriginal) => ({
  // Spread the real module so key helpers (tenantContextKey, permissionSetKey)
  // and constants (TTL) stay available; only the client is faked.
  ...(await importOriginal<typeof import('@serverless-saas/cache')>()),
  getCacheClient: () => ({
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
  }),
}))

vi.mock('@serverless-saas/database', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([mockTenantRow]),
        }),
      }),
    }),
  },
}))

describe('tenantResolutionMiddleware', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves tenantId from apiKeyContext when no jwtPayload is present (agent request)', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      // Simulate apiKeyAuthMiddleware having already run: apiKeyContext set, jwtPayload absent,
      // requestContext.permissions already narrowed by Task 2's fix.
      c.set('apiKeyContext' as never, { keyId: 'key-1', tenantId: 'tenant-1', type: 'agent', permissions: ['agent_tasks:create'] } as never)
      c.set('requestContext' as never, { permissions: ['agent_tasks:create'] } as never)
      await next()
    })
    app.use('*', tenantResolutionMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({ tenant: requestContext?.tenant ?? null, permissions: requestContext?.permissions ?? null })
    })

    const res = await app.request('/test')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tenant).toEqual({ id: 'tenant-1', slug: 'acme', status: 'active' })
    // The permissions Task 2 set must survive — this is the bug this task fixes
    expect(body.permissions).toEqual(['agent_tasks:create'])
  })

  it('still resolves tenantId from jwtPayload when present (human/JWT request, unchanged behavior)', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('jwtPayload' as never, { 'custom:tenantId': 'tenant-1' } as never)
      await next()
    })
    app.use('*', tenantResolutionMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({ tenant: requestContext?.tenant ?? null })
    })

    const res = await app.request('/test')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tenant).toEqual({ id: 'tenant-1', slug: 'acme', status: 'active' })
  })

  it('still returns 403 onboarding-required when neither jwtPayload nor apiKeyContext carry a tenantId', async () => {
    const app = new Hono()
    app.use('*', tenantResolutionMiddleware)
    app.get('/api/v1/some-protected-route', (c) => c.json({ ok: true }))

    const res = await app.request('/api/v1/some-protected-route')
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('ONBOARDING_REQUIRED')
  })
})

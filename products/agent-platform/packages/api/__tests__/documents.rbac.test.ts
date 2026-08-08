import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

/**
 * F-09 — every document route must enforce RBAC.
 *
 * The bug: five of six routes (upload-url, create, list, get, delete) checked
 * only tenantId and never called hasPermission, so any member of any role could
 * upload, read and permanently delete anything in the tenant's knowledge base.
 * The single route that did check asked for the resource 'documents', which does
 * not exist in the seeded permission catalog (only 'files' does) — so that route
 * returned 403 for every user including the tenant owner.
 *
 * These tests use the real hasPermission implementation and vary only the
 * caller's granted permissions, so they assert the access decision itself.
 */

vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/database/schema', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/agent-schema/documents', () => ({
  documents: {},
  documentChunks: {},
}))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
}))
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/put'),
}))

const TENANT = 'tenant-1'

/** Mounts the real routes with a caller holding exactly `permissions`. */
async function appWithPermissions(permissions: Array<{ resource: string; action: string }>) {
  const documentsRoutes = (await import('../routes/documents')).default
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: TENANT }, permissions })
    c.set('userId', 'user-1')
    await next()
  })
  app.route('/documents', documentsRoutes)
  return app
}

const NO_PERMISSIONS: Array<{ resource: string; action: string }> = []

/** Every route that mutates or exposes tenant documents. */
const GUARDED_ROUTES: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  {
    name: 'POST /documents/upload-url',
    method: 'POST',
    path: '/documents/upload-url',
    body: { fileName: 'x.pdf', mimeType: 'application/pdf' },
  },
  {
    name: 'POST /documents',
    method: 'POST',
    path: '/documents',
    body: { name: 'x', mimeType: 'application/pdf', fileKey: 'k', hash: 'a'.repeat(64) },
  },
  { name: 'GET /documents', method: 'GET', path: '/documents' },
  { name: 'GET /documents/:id', method: 'GET', path: '/documents/doc-1' },
  { name: 'DELETE /documents/:id', method: 'DELETE', path: '/documents/doc-1' },
]

async function call(app: Hono<any>, route: { method: string; path: string; body?: unknown }) {
  return app.request(route.path, {
    method: route.method,
    headers: { 'Content-Type': 'application/json' },
    ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
  })
}

describe('documents routes RBAC', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  for (const route of GUARDED_ROUTES) {
    it(`refuses ${route.name} for a caller with no permissions`, async () => {
      const app = await appWithPermissions(NO_PERMISSIONS)
      const res = await call(app, route)
      expect(res.status).toBe(403)
    })
  }

  it('allows the classification route for a caller holding the real seeded resource', async () => {
    // The catalog defines 'files', never 'documents'. Asking for a resource no
    // role can hold made this endpoint permanently unreachable.
    const app = await appWithPermissions([{ resource: 'files', action: 'create' }])
    const res = await app.request('/documents/doc-1/classification', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sensitivityLevel: 'confidential' }),
    })
    expect(res.status).not.toBe(403)
  })

  it('refuses the classification route for a caller with no permissions', async () => {
    const app = await appWithPermissions(NO_PERMISSIONS)
    const res = await app.request('/documents/doc-1/classification', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sensitivityLevel: 'confidential' }),
    })
    expect(res.status).toBe(403)
  })
})

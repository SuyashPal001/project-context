import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

/**
 * F-12 — /messages/save is infrastructure-only and must prove it.
 *
 * The bug: the route is commented as an internal relay endpoint but had no
 * service-key check, and the orchestrator called it with the END USER'S own
 * idToken rather than x-internal-service-key. Only conversation ownership was
 * verified, never that the caller was trusted infrastructure.
 *
 * So any tenant member could POST directly with role: 'assistant' and arbitrary
 * content, forging AI output without the model ever running — and because the
 * legitimate POST /messages route is the one that writes usageRecords, routing
 * through /save also evaded metering and billing.
 */

vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/agent-schema/conversations', () => ({
  conversations: {}, messages: {},
}))
vi.mock('@serverless-saas/database/schema/billing', () => ({ usageRecords: {} }))
vi.mock('./_orchestrator', () => ({}))
vi.mock('../routes/_orchestrator', () => ({
  runMessageRelay: vi.fn(),
  RelayError: class extends Error {},
}))
vi.mock('@serverless-saas/permissions', () => ({
  hasPermission: () => true,
}))

const SERVICE_KEY = 's'.repeat(40)

async function post(headers: Record<string, string>) {
  const { messagesRoutes } = await import('../routes/messages')
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [] })
    c.set('userId', 'user-1')
    await next()
  })
  app.route('/conversations', messagesRoutes)

  return app.request('/conversations/conv-1/messages/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ role: 'assistant', content: 'forged AI output' }),
  })
}

describe('POST /conversations/:id/messages/save', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_KEY

  beforeEach(() => {
    vi.resetModules()
    process.env.INTERNAL_SERVICE_KEY = SERVICE_KEY
  })

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_KEY
    else process.env.INTERNAL_SERVICE_KEY = ORIGINAL
  })

  it('refuses a request with no service key', async () => {
    // The attack: an ordinary authenticated user calling it directly.
    const res = await post({})
    expect(res.status).toBe(401)
  })

  it('refuses a request presenting the wrong service key', async () => {
    const res = await post({ 'x-internal-service-key': 'x'.repeat(40) })
    expect(res.status).toBe(401)
  })

  it('does not accept a user JWT in place of the service key', async () => {
    // The orchestrator used to authenticate here with the caller's idToken.
    const res = await post({ authorization: 'Bearer eyJhbGciOi.someuser.token' })
    expect(res.status).toBe(401)
  })

  it('lets the relay through when it presents the service key', async () => {
    const res = await post({ 'x-internal-service-key': SERVICE_KEY })
    expect(res.status).not.toBe(401)
  })

  it('persists a generation object on attachments instead of stripping it', async () => {
    // F-13 regression guard: the inner attachments Zod object used to omit
    // `generation`, so Zod silently dropped it before the insert — every
    // reloaded conversation showed no credit pill. Assert the parsed value
    // that reaches db.insert(...).values(...) still carries `generation`.
    const valuesMock = vi.fn((vals: any) => ({
      returning: () => Promise.resolve([{ id: 'msg-1', ...vals }]),
    }))
    const insertMock = vi.fn(() => ({ values: valuesMock }))
    const selectMock = vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'conv-1', tenantId: 'tenant-1', userId: 'user-1' }]),
        }),
      }),
    }))
    vi.doMock('../db', () => ({ db: { select: selectMock, insert: insertMock } }))

    const { messagesRoutes } = await import('../routes/messages')
    const app = new Hono<any>()
    app.use('*', async (c, next) => {
      c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [] })
      c.set('userId', 'user-1')
      await next()
    })
    app.route('/conversations', messagesRoutes)

    const attachments = [{
      fileId: 'file-1',
      name: 'image.png',
      type: 'image/png',
      generation: { creditsUsedMicro: '1500000', model: 'gemini-image' },
    }]

    const res = await app.request('/conversations/conv-1/messages/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': SERVICE_KEY },
      body: JSON.stringify({ role: 'assistant', content: 'here is an image', attachments }),
    })

    expect(res.status).toBe(201)
    expect(valuesMock).toHaveBeenCalledTimes(1)
    const insertedAttachments = valuesMock.mock.calls[0][0].attachments
    expect(insertedAttachments).toEqual(attachments)
    expect(insertedAttachments[0].generation).toEqual({ creditsUsedMicro: '1500000', model: 'gemini-image' })
  })
})

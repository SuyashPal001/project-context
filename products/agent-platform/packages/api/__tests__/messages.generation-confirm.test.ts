import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

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

async function patch(headers: Record<string, string>, body: unknown) {
  const { messagesRoutes } = await import('../routes/messages')
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [] })
    c.set('userId', 'user-1')
    await next()
  })
  app.route('/', messagesRoutes)

  return app.request('/conv-1/messages/msg-1/generation-confirm', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('PATCH /:conversationId/messages/:messageId/generation-confirm', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_KEY

  beforeEach(() => {
    vi.resetModules()
    process.env.INTERNAL_SERVICE_KEY = SERVICE_KEY
  })

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_KEY
    else process.env.INTERNAL_SERVICE_KEY = ORIGINAL
  })

  it('requires x-internal-service-key', async () => {
    const res = await patch({}, { generationConfirmRequest: { status: 'approved' } })
    expect(res.status).toBe(401)
  })

  it('rejects a body with no generationConfirmRequest.status', async () => {
    const res = await patch(
      { 'x-internal-service-key': SERVICE_KEY },
      { generationConfirmRequest: {} },
    )
    expect(res.status).toBe(400)
  })
})

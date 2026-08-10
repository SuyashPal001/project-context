import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

import { mcpRoutes } from '../routes/mcp'
import { getMcpRegistry, resetMcpRegistry, textResponse } from '@serverless-saas/mcp'

function appWithApiKeyContext(apiKeyContext?: { tenantId: string; keyId: string; type: string; permissions: string[] }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (apiKeyContext) c.set('apiKeyContext' as never, apiKeyContext as never)
    await next()
  })
  app.route('/mcp', mcpRoutes)
  return app
}

beforeEach(() => {
  resetMcpRegistry()
})

describe('POST /mcp/tools/call', () => {
  it('returns 401 when no apiKeyContext is set', async () => {
    const app = appWithApiKeyContext(undefined)
    const res = await app.request('/mcp/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'start_task', arguments: { taskId: 't1' } }),
    })
    expect(res.status).toBe(401)
  })

  it('executes a registered tool and returns its result', async () => {
    getMcpRegistry().register(
      { name: 'ping', description: 'test tool', inputSchema: { type: 'object', properties: {} }, requiredPermissions: [] },
      async () => textResponse('pong'),
    )
    const app = appWithApiKeyContext({ tenantId: 'tenant-1', keyId: 'key-1', type: 'agent', permissions: [] })
    const res = await app.request('/mcp/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ping', arguments: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content[0].text).toBe('pong')
  })

  it('returns isError for an unknown tool without a 500', async () => {
    const app = appWithApiKeyContext({ tenantId: 'tenant-1', keyId: 'key-1', type: 'agent', permissions: [] })
    const res = await app.request('/mcp/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nonexistent', arguments: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.isError).toBe(true)
  })

  it('returns 400 when name is missing', async () => {
    const app = appWithApiKeyContext({ tenantId: 'tenant-1', keyId: 'key-1', type: 'agent', permissions: [] })
    const res = await app.request('/mcp/tools/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /mcp/tools', () => {
  it('returns 401 when no apiKeyContext is set', async () => {
    const app = appWithApiKeyContext(undefined)
    const res = await app.request('/mcp/tools')
    expect(res.status).toBe(401)
  })

  it('lists registered tool definitions', async () => {
    getMcpRegistry().register(
      { name: 'ping', description: 'test tool', inputSchema: { type: 'object', properties: {} }, requiredPermissions: [] },
      async () => textResponse('pong'),
    )
    const app = appWithApiKeyContext({ tenantId: 'tenant-1', keyId: 'key-1', type: 'agent', permissions: [] })
    const res = await app.request('/mcp/tools')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([
      { name: 'ping', description: 'test tool', inputSchema: { type: 'object', properties: {} }, requiredPermissions: [] },
    ])
  })
})

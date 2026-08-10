import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

vi.mock('@serverless-saas/agent-capabilities', () => ({ registerAgentPlatformMcpTools: vi.fn() }))
vi.mock('../../lib/internal-service-client', () => ({ callMcpServer: vi.fn() }))

import { mcpRoutes } from '../mcp'
import { getMcpRegistry, resetMcpRegistry, textResponse } from '@serverless-saas/mcp'
import { callMcpServer } from '../../lib/internal-service-client'

function appWithAuth(ctx?: { tenantId: string; keyId: string; type: string; permissions: string[] }, agentId?: string) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (ctx) c.set('apiKeyContext' as never, ctx as never)
    if (agentId) c.set('agentId' as never, agentId as never)
    await next()
  })
  app.route('/mcp', mcpRoutes)
  return app
}

beforeEach(() => {
  resetMcpRegistry()
  vi.mocked(callMcpServer).mockReset()
})

describe('POST /mcp', () => {
  it('returns 401 without apiKeyContext', async () => {
    const app = appWithAuth(undefined)
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  it('executes a locally registered tool via real MCP JSON-RPC framing', async () => {
    getMcpRegistry().register(
      { name: 'ping', description: 'test', inputSchema: { type: 'object', properties: {} }, requiredPermissions: [] },
      async () => textResponse('pong'),
    )
    const app = appWithAuth({ tenantId: 'tenant-1', keyId: 'key-1', type: 'agent', permissions: [] }, 'agent-1')
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
    })
    expect(initRes.status).toBe(200)
  })

  it('proxies tools/call for a tool name not in the local registry to mcp-server', async () => {
    // First call: getRemoteTools()'s tools/list fetch to mcp-server, used to build the
    // merged tool set on the per-request McpServer. Second call: the remote tool's own
    // callback proxying the actual tools/call once the SDK invokes it.
    vi.mocked(callMcpServer)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'GMAIL_SEND_EMAIL', description: 'Send an email', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'gmail result' }] },
      }), { status: 200 }))

    const app = appWithAuth({ tenantId: 'tenant-1', keyId: 'key-1', type: 'agent', permissions: [] }, 'agent-1')
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'GMAIL_SEND_EMAIL', arguments: {} },
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('gmail result')
    expect(callMcpServer).toHaveBeenCalledTimes(2)
    expect(vi.mocked(callMcpServer).mock.calls[1][0]).toBe('/mcp')
    expect(vi.mocked(callMcpServer).mock.calls[1][1]).toMatchObject({
      method: 'tools/call',
      params: { name: 'GMAIL_SEND_EMAIL', arguments: {} },
    })
    expect(vi.mocked(callMcpServer).mock.calls[1][2]).toEqual({ tenantId: 'tenant-1', agentId: 'agent-1' })
  })
})

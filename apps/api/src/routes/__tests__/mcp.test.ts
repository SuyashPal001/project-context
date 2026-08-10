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

  it('calls a locally registered tool via tools/call and returns its result', async () => {
    let capturedAuth: unknown
    getMcpRegistry().register(
      { name: 'ping', description: 'test', inputSchema: { type: 'object', properties: {} }, requiredPermissions: [] },
      async (_args, auth) => {
        capturedAuth = auth
        return textResponse('pong')
      },
    )
    const app = appWithAuth({ tenantId: 'tenant-1', keyId: 'key-1', type: 'agent', permissions: ['perm.a'] }, 'agent-1')
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('pong')
    expect(capturedAuth).toEqual({
      tenantId: 'tenant-1',
      keyId: 'key-1',
      keyType: 'agent',
      permissions: ['perm.a'],
      agentId: 'agent-1',
    })
  })

  it('lists the merged local + remote tool set via tools/list', async () => {
    getMcpRegistry().register(
      { name: 'ping', description: 'test', inputSchema: { type: 'object', properties: {} }, requiredPermissions: [] },
      async () => textResponse('pong'),
    )
    vi.mocked(callMcpServer).mockResolvedValueOnce(
      new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              { name: 'GMAIL_SEND_EMAIL', description: 'Send an email', inputSchema: { type: 'object', properties: {} } },
            ],
          },
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )

    // Distinct tenantId so this test's remoteToolsCache entry (module-global, keyed
    // by tenantId, not reset between tests) can't be read by or collide with the
    // other remote-tool tests in this file.
    const app = appWithAuth({ tenantId: 'tenant-list-merge', keyId: 'key-1', type: 'agent', permissions: [] }, 'agent-1')
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('ping')
    expect(text).toContain('GMAIL_SEND_EMAIL')
  })

  it('proxies tools/call for a tool name not in the local registry to mcp-server', async () => {
    // First call: getRemoteTools()'s tools/list fetch to mcp-server, used to build the
    // merged tool set on the per-request McpServer. Second call: the remote tool's own
    // callback proxying the actual tools/call once the SDK invokes it.
    // Both responses use real SSE framing, matching mcp-server's
    // StreamableHTTPServerTransport (no enableJsonResponse => event-stream framed body).
    vi.mocked(callMcpServer)
      .mockResolvedValueOnce(new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              { name: 'GMAIL_SEND_EMAIL', description: 'Send an email', inputSchema: { type: 'object', properties: { to: { type: 'string' }, cc: { type: 'string' } }, required: ['to'] } },
            ],
          },
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))
      .mockResolvedValueOnce(new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: 'gmail result' }] },
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))

    // Distinct tenantId (see comment on the tools/list merge test above) so this
    // test always exercises a fresh, uncached tools/list fetch.
    const app = appWithAuth({ tenantId: 'tenant-proxy', keyId: 'key-1', type: 'agent', permissions: [] }, 'agent-1')
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@example.com' } },
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('gmail result')
    expect(callMcpServer).toHaveBeenCalledTimes(2)
    expect(vi.mocked(callMcpServer).mock.calls[1][0]).toBe('/mcp')
    expect(vi.mocked(callMcpServer).mock.calls[1][1]).toMatchObject({
      method: 'tools/call',
      params: { name: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@example.com' } },
    })
    expect(vi.mocked(callMcpServer).mock.calls[1][2]).toEqual({ tenantId: 'tenant-proxy', agentId: 'agent-1' })
  })
})

// The test MCP exposes real paid tools, so these tests pin the guards: the
// listener refuses a missing/wrong key and any non-/mcp path, tool arguments
// cannot choose the tenant, and startTestMcp refuses an unlimited tenant or a
// failed sign-in without throwing.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTool } from '@mastra/core/tools'
import { MCPClient, MCPServer } from '@mastra/mcp'
import { z } from 'zod'

const unlimited = vi.hoisted(() => ({ fn: vi.fn(async (_t: string) => false) }))
vi.mock('@serverless-saas/credits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@serverless-saas/credits')>()),
  isUnlimited: (t: string) => unlimited.fn(t),
}))

import { startTestMcp } from './server.js'
import type { TestMcpConfig } from './config.js'

const KEY = 'test-internal-key-123'
const cfg: TestMcpConfig = {
  port: 0, tenantId: 'tenant-real', agentId: 'agent-1', email: 'e', password: 'p',
  cognitoClientId: 'c', cognitoRegion: 'ap-south-1', selfBaseUrl: 'http://127.0.0.1:1', apiBaseUrl: 'http://127.0.0.1:1',
}

function fakes() {
  const identity = { init: vi.fn(async () => {}), idToken: vi.fn(async () => 'tok'), internalUserId: 'user-1', userSub: 'sub-1' }
  const driver = {
    newConversation: vi.fn(async () => 'conv-new'),
    send: vi.fn(async (a: any) => ({ conversationId: a.conversationId ?? 'c', state: 'done', text: 'hi', toolCalls: [], files: [], newEvents: 1 })),
    read: vi.fn(async (id: string) => ({ conversationId: id, state: 'done', text: '', toolCalls: [], files: [], newEvents: 0 })),
    answer: vi.fn(async (id: string) => ({ conversationId: id, state: 'running', text: '', toolCalls: [], files: [], newEvents: 0 })),
  }
  const traces = { listTraces: vi.fn(async () => ({ spans: [], pagination: {} } as any)), getTrace: vi.fn(async () => null) }
  const probe = createTool({
    id: 'probe', description: 'echoes the context it ran under',
    inputSchema: z.object({ tenantId: z.string().optional() }),
    execute: async (_i, c: any) => ({ tenantId: c.requestContext.get('tenantId'), conversationId: c.requestContext.get('conversationId') }),
  })
  return { identity, driver, traces, tools: { probe } }
}

function parse(result: any): any {
  const text = result?.content?.[0]?.text
  return typeof text === 'string' ? JSON.parse(text) : result
}

describe('test MCP listener', () => {
  let handle: Awaited<ReturnType<typeof startTestMcp>>
  let client: MCPClient
  let base: string
  let f: ReturnType<typeof fakes>

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_KEY = KEY
    vi.spyOn(console, 'log').mockImplementation(() => {})
    f = fakes()
    handle = await startTestMcp({ cfg, ...(f as any), checkBalance: async () => ({ allowed: true, balanceMicro: 5_000_000n, unlimited: false }) })
    expect(handle).not.toBeNull()
    base = `http://127.0.0.1:${handle!.port}`
    client = new MCPClient({
      id: `test-mcp-${Date.now()}`,
      servers: { t: { url: new URL(`${base}/mcp`), requestInit: { headers: { 'x-internal-service-key': KEY } } } },
    })
  })

  afterAll(async () => {
    await client?.disconnect()
    await handle?.close()
    vi.mocked(console.log).mockRestore()
  })

  it('refuses a missing key, a wrong key, and a non-/mcp path before the MCP server sees the request', async () => {
    const startHTTP = vi.spyOn(MCPServer.prototype, 'startHTTP')
    const none = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(none.status).toBe(401)
    const wrong = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'x-internal-service-key': 'wrong-key-of-same-len' }, body: '{}' })
    expect(wrong.status).toBe(401)
    const noKeyOtherPath = await fetch(`${base}/other`)
    expect(noKeyOtherPath.status).toBe(401)
    const otherPath = await fetch(`${base}/other`, { headers: { 'x-internal-service-key': KEY } })
    expect(otherPath.status).toBe(404)
    expect(startHTTP).not.toHaveBeenCalled()
    startHTTP.mockRestore()
  })

  it('lists the test tools and the wrapped product tools', async () => {
    const tools = await client.listTools()
    for (const name of ['t_olmo_send', 't_olmo_read', 't_olmo_answer', 't_get_file', 't_olmo_trace', 't_test_status', 't_test_new_conversation', 't_probe']) {
      expect(Object.keys(tools)).toContain(name)
    }
  })

  it('runs a product tool under the configured tenant, never the argument', async () => {
    const tools = await client.listTools()
    const out = parse(await tools.t_probe.execute!({ tenantId: 'evil' } as any, {} as any))
    expect(out.tenantId).toBe('tenant-real')
    expect(out.conversationId).toBe('conv-new')
  })

  it('test_new_conversation sets the conversation route-1 tools use', async () => {
    const tools = await client.listTools()
    f.driver.newConversation.mockResolvedValueOnce('conv-fresh')
    const created = parse(await tools.t_test_new_conversation.execute!({} as any, {} as any))
    expect(created.conversationId).toBe('conv-fresh')
    const out = parse(await tools.t_probe.execute!({} as any, {} as any))
    expect(out.conversationId).toBe('conv-fresh')
    const status = parse(await tools.t_test_status.execute!({} as any, {} as any))
    expect(status).toMatchObject({ tenantId: 'tenant-real', userId: 'user-1', agentId: 'agent-1', currentConversationId: 'conv-fresh', credits: { balanceMicro: '5000000', unlimited: false } })
  })

  it('olmo_answer passes a kind-tagged answer to the driver', async () => {
    const tools = await client.listTools()
    await tools.t_olmo_answer.execute!({ conversationId: 'c9', answer: { kind: 'approval', decision: 'allow' } } as any, {} as any)
    expect(f.driver.answer).toHaveBeenCalledWith('c9', { kind: 'approval', decision: 'allow' }, undefined)
  })
})

describe('startTestMcp guards', () => {
  beforeEach(() => { unlimited.fn.mockReset(); unlimited.fn.mockResolvedValue(false) })

  it('returns null without throwing when the test tenant is unlimited', async () => {
    unlimited.fn.mockResolvedValue(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakes()
    await expect(startTestMcp({ cfg, ...(f as any) })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('[test-mcp] disabled: test tenant must have a capped balance')
    expect(f.identity.init).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns null when the unlimited check itself fails', async () => {
    unlimited.fn.mockRejectedValue(new Error('Failed query:\n  select 1\nparams: t'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(startTestMcp({ cfg, ...(fakes() as any) })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[test-mcp] disabled: credit cap check failed: Failed query: select 1 params: t')
    warn.mockRestore()
  })

  it('returns null when sign-in fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakes()
    f.identity.init.mockRejectedValue(new Error('tenant_mismatch'))
    await expect(startTestMcp({ cfg, ...(f as any) })).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith('[test-mcp] disabled: sign-in failed: tenant_mismatch')
    warn.mockRestore()
  })

  it('returns null when the port is already taken', async () => {
    const { createServer } = await import('node:http')
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as any).port
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(startTestMcp({ cfg: { ...cfg, port }, ...(fakes() as any) })).resolves.toBeNull()
    expect(warn.mock.calls[0][0]).toMatch(/^\[test-mcp\] disabled: .*EADDRINUSE/)
    warn.mockRestore()
    await new Promise<void>((r) => blocker.close(() => r()))
  })

  it('stays silent and returns null when not enabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(startTestMcp({ env: {} })).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('logs and returns null when enabled but misconfigured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(startTestMcp({ env: { TEST_MCP_ENABLED: '1' } })).resolves.toBeNull()
    expect(warn.mock.calls[0][0]).toMatch(/^\[test-mcp\] disabled: test MCP enabled but missing: TEST_MCP_TENANT_ID/)
    warn.mockRestore()
  })
})

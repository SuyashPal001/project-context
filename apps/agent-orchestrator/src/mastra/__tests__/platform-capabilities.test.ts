import { describe, it, expect, vi } from 'vitest'

vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/mcp', () => ({
  getMcpRegistry: vi.fn(),
}))
vi.mock('@serverless-saas/agent-capabilities', () => ({
  registerAgentPlatformMcpTools: vi.fn(),
}))
vi.mock('@serverless-saas/permissions', () => {
  // platform-capabilities.ts does a default import (`import permissionsPkg
  // from '@serverless-saas/permissions'`) — the mock needs a `default` key or
  // that import throws "No default export defined on the mock". The named
  // export is kept as the SAME function reference so `vi.mocked(...)` in the
  // tests below (which import it by name) controls the exact function the
  // code under test actually calls via `permissionsPkg.resolveUserPermissions`.
  const resolveUserPermissions = vi.fn()
  return { default: { resolveUserPermissions }, resolveUserPermissions }
})

describe('platform-capabilities Mastra tools', () => {
  it('exposes start_task and get_task_thread', async () => {
    const { platformCapabilityTools } = await import('../tools/platform-capabilities.js')
    expect(Object.keys(platformCapabilityTools)).toEqual(
      expect.arrayContaining(['start_task', 'get_task_thread']),
    )
  })

  it('resolves the human caller auth context and calls the registry with no agentId', async () => {
    const { getMcpRegistry } = await import('@serverless-saas/mcp')
    const { resolveUserPermissions } = await import('@serverless-saas/permissions')
    const execute = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    vi.mocked(getMcpRegistry).mockReturnValue({ execute } as any)
    vi.mocked(resolveUserPermissions).mockResolvedValue([{ resource: 'agent_tasks', action: 'read' }])

    const { platformCapabilityTools } = await import('../tools/platform-capabilities.js')
    const requestContext = new Map([['tenantId', 'tenant-1'], ['userId', 'user-1']])
    const result = await platformCapabilityTools.start_task.execute!(
      { taskId: 't1' },
      { requestContext: { get: (k: string) => requestContext.get(k) } } as any,
    )

    expect(execute).toHaveBeenCalledWith(
      { name: 'start_task', arguments: { taskId: 't1' } },
      { tenantId: 'tenant-1', keyId: 'session', keyType: 'rest', permissions: ['agent_tasks:read'] },
    )
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('surfaces an isError response as agent-readable text, not a throw', async () => {
    const { getMcpRegistry } = await import('@serverless-saas/mcp')
    const { resolveUserPermissions } = await import('@serverless-saas/permissions')
    const execute = vi.fn().mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Permission denied for tool: start_task' }] })
    vi.mocked(getMcpRegistry).mockReturnValue({ execute } as any)
    vi.mocked(resolveUserPermissions).mockResolvedValue([])

    const { platformCapabilityTools } = await import('../tools/platform-capabilities.js')
    const requestContext = new Map([['tenantId', 'tenant-1'], ['userId', 'user-1']])
    const result = await platformCapabilityTools.start_task.execute!(
      { taskId: 't1' },
      { requestContext: { get: (k: string) => requestContext.get(k) } } as any,
    )

    expect((result as any).content[0].text).toBe('Permission denied for tool: start_task')
  })

  it('degrades gracefully when resolveUserPermissions rejects, instead of throwing out of execute()', async () => {
    const { getMcpRegistry } = await import('@serverless-saas/mcp')
    const { resolveUserPermissions } = await import('@serverless-saas/permissions')
    const execute = vi.fn()
    vi.mocked(getMcpRegistry).mockReturnValue({ execute } as any)
    vi.mocked(resolveUserPermissions).mockRejectedValue(new Error('pool exhausted'))

    const { platformCapabilityTools } = await import('../tools/platform-capabilities.js')
    const requestContext = new Map([['tenantId', 'tenant-1'], ['userId', 'user-1']])

    await expect(
      platformCapabilityTools.start_task.execute!(
        { taskId: 't1' },
        { requestContext: { get: (k: string) => requestContext.get(k) } } as any,
      ),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Could not verify your permissions right now — please try again.' }],
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports unresolved workspace membership distinctly from zero-permission membership, without calling the registry', async () => {
    const { getMcpRegistry } = await import('@serverless-saas/mcp')
    const { resolveUserPermissions } = await import('@serverless-saas/permissions')
    const execute = vi.fn()
    vi.mocked(getMcpRegistry).mockReturnValue({ execute } as any)
    vi.mocked(resolveUserPermissions).mockResolvedValue(null)

    const { platformCapabilityTools } = await import('../tools/platform-capabilities.js')
    const requestContext = new Map([['tenantId', 'tenant-1'], ['userId', 'user-1']])
    const result = await platformCapabilityTools.start_task.execute!(
      { taskId: 't1' },
      { requestContext: { get: (k: string) => requestContext.get(k) } } as any,
    )

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Could not resolve your workspace membership — please make sure you are signed in to a workspace.',
        },
      ],
    })
    expect(execute).not.toHaveBeenCalled()
  })
})

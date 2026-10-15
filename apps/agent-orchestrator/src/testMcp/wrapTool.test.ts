import { describe, it, expect, vi } from 'vitest'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { wrapForTest } from './wrapTool.js'

const ctx = async () => ({ tenantId: 't1', userId: 'u1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

describe('wrapForTest', () => {
  it('runs the tool with the test tenant context, never the arguments', async () => {
    const seen: any[] = []
    const inner = createTool({ id: 'probe', description: 'd', inputSchema: z.object({ tenantId: z.string().optional() }),
      execute: async (_i, c: any) => { seen.push({ t: c.requestContext.get('tenantId'), conv: c.requestContext.get('conversationId'), mode: c.requestContext.get('allowMode'), call: c.agent.toolCallId }); return { ok: true } } })
    const w = wrapForTest('probe', inner, ctx)
    await w.execute({ tenantId: 'evil' }, {} as any)
    await w.execute({}, {} as any)
    expect(seen[0]).toMatchObject({ t: 't1', conv: 'c1', mode: 'auto' })
    expect(seen[0].call).not.toBe(seen[1].call)
  })
  it('keeps the original schema and description', () => {
    const inner = createTool({ id: 'x', description: 'desc', inputSchema: z.object({ a: z.string() }), execute: async () => ({}) })
    const w = wrapForTest('x', inner, ctx)
    expect(w.description).toBe('desc')
    expect(w.inputSchema).toBe(inner.inputSchema)
  })
})

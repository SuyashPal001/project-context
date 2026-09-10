import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'
import { buildDelegationConfig, type DelegationHost } from '../hooks.js'

// The stable per-stream facts onDelegationComplete needs but cannot read off
// its own context (@mastra/core 1.64's DelegationCompleteContext has no
// requestContext field) — supplied once per buildDelegationConfig() call,
// matching the tenantId/sessionId/agentId set on the request contexts below.
const host: DelegationHost = { tenantId: 't1', conversationId: 'conv-1', agentId: 'olmo-agent-id' }

function startContext(overrides: Record<string, unknown> = {}) {
  const requestContext = new RequestContext<TenantContext>()
  requestContext.set('tenantId', 't1')
  requestContext.set('userId', 'u1')
  requestContext.set('sessionId', 'conv-1')
  requestContext.set('agentId', 'olmo-agent-id')
  requestContext.set('agentName', 'Olmo')
  requestContext.set('agentSystemPrompt', 'OLMO PROMPT OVERRIDE')
  requestContext.set('personaPersonality', 'olmo persona')
  return {
    primitiveId: 'director', primitiveType: 'agent' as const, prompt: 'make an image',
    params: {}, iteration: 1, runId: 'run-1', toolCallId: 'call-1',
    parentAgentId: 'olmo', parentAgentName: 'Olmo', messages: [],
    requestContext: requestContext as unknown as RequestContext,
    ...overrides,
  }
}

const allow = async () => ({ allowed: true })

describe('onDelegationStart', () => {
  it('applies the spec maxSteps instead of Mastra default of 5', async () => {
    const config = buildDelegationConfig(host, { budget: allow })
    const result = await config.onDelegationStart!(startContext() as never)
    expect(result).toMatchObject({ modifiedMaxSteps: 8 })
  })

  it('replaces the host identity with the delegate own', async () => {
    const ctx = startContext()
    await buildDelegationConfig(host, { budget: allow }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('agentName')).toBe('director')
    expect(ctx.requestContext.get('agentId')).toBe('director')
    expect(ctx.requestContext.get('agentSystemPrompt')).toBe('')
    expect(ctx.requestContext.get('personaPersonality')).toBe('')
  })

  it('keeps the facts that are the tenant, not the agent', async () => {
    const ctx = startContext()
    await buildDelegationConfig(host, { budget: allow }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('tenantId')).toBe('t1')
    expect(ctx.requestContext.get('userId')).toBe('u1')
    expect(ctx.requestContext.get('sessionId')).toBe('conv-1')
  })

  it('stamps the depth one deeper than the parent', async () => {
    const ctx = startContext()
    await buildDelegationConfig(host, { budget: allow }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('delegationDepth')).toBe(1)
    const nested = startContext()
    nested.requestContext.set('delegationDepth', 1)
    await buildDelegationConfig(host, { budget: allow }).onDelegationStart!(nested as never)
    expect(nested.requestContext.get('delegationDepth')).toBe(2)
  })

  it('refuses the delegation when the budget gate says no, and does not rewrite identity', async () => {
    const ctx = startContext()
    const budget = async () => ({ allowed: false, reason: 'out of credits' })
    const result = await buildDelegationConfig(host, { budget }).onDelegationStart!(ctx as never)
    expect(result).toEqual({ proceed: false, rejectionReason: 'out of credits' })
    expect(ctx.requestContext.get('agentName')).toBe('Olmo')
  })

  it('records a refused delegation as a failed link row', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const budget = async () => ({ allowed: false, reason: 'out of credits' })
    await buildDelegationConfig(host, { budget, record }).onDelegationStart!(startContext() as never)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      primitiveId: 'director', success: false, rejectionReason: 'out of credits',
    }))
  })

  it('refuses a delegation to an unregistered primitive', async () => {
    const result = await buildDelegationConfig(host, { budget: allow })
      .onDelegationStart!(startContext({ primitiveId: 'ghost' }) as never)
    expect(result).toMatchObject({ proceed: false })
  })
})

function completeContext(overrides: Record<string, unknown> = {}) {
  return {
    primitiveId: 'director', primitiveType: 'agent' as const, prompt: 'make an image',
    result: { text: 'here it is', finishReason: 'stop' as const },
    duration: 900, success: true, iteration: 1, runId: 'run-1', toolCallId: 'call-1',
    parentAgentId: 'olmo', parentAgentName: 'Olmo', messages: [], bail: vi.fn(),
    ...overrides,
  }
}

describe('onDelegationComplete', () => {
  it('writes one link row for a successful delegation, carrying the host facts', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    await buildDelegationConfig(host, { record }).onDelegationComplete!(completeContext() as never)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      primitiveId: 'director', success: true, durationMs: 900, runId: 'run-1',
      tenantId: 't1', conversationId: 'conv-1', agentId: 'olmo-agent-id',
    }))
  })

  it('writes a link row carrying the error for a failed delegation', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const ctx = completeContext({ success: false, error: new Error('model exploded') })
    await buildDelegationConfig(host, { record }).onDelegationComplete!(ctx as never)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: 'model exploded' }))
  })

  it('bails with feedback when a delegation fails and the spec has no fallback', async () => {
    const ctx = completeContext({ success: false, error: new Error('model exploded') })
    const result = await buildDelegationConfig(host, { record: async () => {} }).onDelegationComplete!(ctx as never)
    expect(ctx.bail).toHaveBeenCalled()
    expect(result?.feedback).toMatch(/director/)
  })

  it('replaces empty text after a tool-calls stop with an honest description', async () => {
    const ctx = completeContext({ result: { text: '', finishReason: 'tool-calls' } })
    const result = await buildDelegationConfig(host, { record: async () => {} }).onDelegationComplete!(ctx as never)
    expect(result?.resultText).toMatch(/did not finish/i)
    expect(ctx.bail).not.toHaveBeenCalled()
  })

  it('leaves a normal result untouched', async () => {
    const result = await buildDelegationConfig(host, { record: async () => {} }).onDelegationComplete!(completeContext() as never)
    expect(result?.resultText).toBeUndefined()
    expect(result?.feedback).toBeUndefined()
  })
})

describe('buildDelegationConfig', () => {
  it('fails the delegation when a hook throws, rather than continuing quietly', () => {
    expect(buildDelegationConfig(host).hookErrorStrategy).toBe('throw')
  })
})

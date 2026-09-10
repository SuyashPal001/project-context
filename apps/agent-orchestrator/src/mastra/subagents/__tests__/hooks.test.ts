import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'
import { buildDelegationConfig, type DelegationHost } from '../hooks.js'

// The stable per-stream facts the hooks prefer over their own per-delegation
// context — see the DelegationHost doc comment in hooks.ts. Matches the
// tenantId/sessionId/agentId set on the request contexts below.
const host: DelegationHost = { tenantId: 't1', conversationId: 'conv-1', agentId: 'olmo-agent-id' }

// Every onDelegationStart test that doesn't care about recordDelegation still
// needs to stub it — otherwise the refusal/refusal-audit paths fall through
// to the real recordDelegation, which opens a real database pool (link.ts
// swallows its own errors, so an unstubbed test looks green while doing IO).
const noopRecord = async () => {}

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
    const config = buildDelegationConfig(host, { budget: allow, record: noopRecord })
    const result = await config.onDelegationStart!(startContext() as never)
    expect(result).toMatchObject({ modifiedMaxSteps: 8 })
  })

  it('replaces the delegate-facing identity, keeps the host agentId for billing', async () => {
    const ctx = startContext()
    await buildDelegationConfig(host, { budget: allow, record: noopRecord }).onDelegationStart!(ctx as never)
    // agentName is what resolveDelegates gates on — rewritten to the spec id
    // so the delegate can't inherit Olmo's own delegate map.
    expect(ctx.requestContext.get('agentName')).toBe('director')
    // subAgentId carries the delegate identity for anything that needs it
    // (e.g. a future delegate-scoped skills resolver) without touching the
    // billing key.
    expect(ctx.requestContext.get('subAgentId')).toBe('director')
    // agentId is UNCHANGED: it's the host's real agent UUID, and the
    // delegates' own tools bind it as `${actorId}::uuid` when spending
    // credits (spend.ts:54) — a spec id or '' there throws AFTER the paid
    // generation already ran.
    expect(ctx.requestContext.get('agentId')).toBe('olmo-agent-id')
    expect(ctx.requestContext.get('agentSystemPrompt')).toBe('')
    expect(ctx.requestContext.get('personaPersonality')).toBe('')
  })

  it('keeps the facts that are the tenant, not the agent', async () => {
    const ctx = startContext()
    await buildDelegationConfig(host, { budget: allow, record: noopRecord }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('tenantId')).toBe('t1')
    expect(ctx.requestContext.get('userId')).toBe('u1')
    expect(ctx.requestContext.get('sessionId')).toBe('conv-1')
  })

  it('stamps the depth one deeper than the parent', async () => {
    const ctx = startContext()
    await buildDelegationConfig(host, { budget: allow, record: noopRecord }).onDelegationStart!(ctx as never)
    expect(ctx.requestContext.get('delegationDepth')).toBe(1)
    const nested = startContext()
    nested.requestContext.set('delegationDepth', 1)
    await buildDelegationConfig(host, { budget: allow, record: noopRecord }).onDelegationStart!(nested as never)
    expect(nested.requestContext.get('delegationDepth')).toBe(2)
  })

  it('refuses the delegation when the budget gate says no, and does not rewrite identity', async () => {
    const ctx = startContext()
    const budget = async () => ({ allowed: false, reason: 'out of credits' })
    const result = await buildDelegationConfig(host, { budget, record: noopRecord }).onDelegationStart!(ctx as never)
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

  it('refuses a delegation to an unregistered primitive and records it', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const result = await buildDelegationConfig(host, { budget: allow, record })
      .onDelegationStart!(startContext({ primitiveId: 'ghost' }) as never)
    expect(result).toMatchObject({ proceed: false })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      primitiveId: 'ghost', success: false, rejectionReason: expect.stringMatching(/not a registered sub-agent/),
    }))
  })

  it('sources the refusal audit row from host, not an empty request-context tenantId', async () => {
    // If the request context's tenantId were empty while host.tenantId is
    // set, reading tenantId from the context would fail the budget gate
    // closed AND then write the link row with tenantId: '' — which link.ts
    // silently drops. Every delegation would be refused and none recorded.
    const record = vi.fn().mockResolvedValue(undefined)
    const ctx = startContext()
    ctx.requestContext.set('tenantId', '')
    const budget = vi.fn().mockResolvedValue({ allowed: false, reason: 'out of credits' })
    await buildDelegationConfig(host, { budget, record }).onDelegationStart!(ctx as never)
    expect(budget).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }))
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }))
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
    const result = await buildDelegationConfig(host, { record: noopRecord }).onDelegationComplete!(ctx as never)
    expect(ctx.bail).toHaveBeenCalled()
    expect(result?.feedback).toMatch(/director/)
  })

  it('replaces empty text after a tool-calls stop with an honest description', async () => {
    const ctx = completeContext({ result: { text: '', finishReason: 'tool-calls' } })
    const result = await buildDelegationConfig(host, { record: noopRecord }).onDelegationComplete!(ctx as never)
    expect(result?.resultText).toMatch(/did not finish/i)
    expect(ctx.bail).not.toHaveBeenCalled()
  })

  it('leaves a normal result untouched', async () => {
    const result = await buildDelegationConfig(host, { record: noopRecord }).onDelegationComplete!(completeContext() as never)
    expect(result?.resultText).toBeUndefined()
    expect(result?.feedback).toBeUndefined()
  })
})

describe('buildDelegationConfig', () => {
  it('fails the delegation when a hook throws, rather than continuing quietly', () => {
    expect(buildDelegationConfig(host).hookErrorStrategy).toBe('throw')
  })
})

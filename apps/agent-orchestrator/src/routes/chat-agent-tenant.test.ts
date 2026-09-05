import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// The cross-tenant hole this pins: `agentId` arrives in the request body while
// `tenantId` comes from the verified JWT, and nothing on this path compared
// them. A user authenticated in tenant A could name tenant B's agent, ask it to
// save a skill, and get their own text composed into B's system prompt on every
// one of B's later turns.
const {
  validateToken, agentBelongsToTenant, fetchAgentMemory, checkCreditBalance,
  runChatStream, isInternalServiceKey, fetchConversationAllowMode,
} = vi.hoisted(() => ({
  validateToken: vi.fn(),
  agentBelongsToTenant: vi.fn(),
  fetchAgentMemory: vi.fn(),
  checkCreditBalance: vi.fn(),
  runChatStream: vi.fn(),
  isInternalServiceKey: vi.fn(),
  fetchConversationAllowMode: vi.fn(),
}))

vi.mock('../auth.js', () => ({ validateToken }))
vi.mock('../usage.js', () => ({ agentBelongsToTenant, fetchAgentMemory }))
vi.mock('../credits.js', () => ({ checkCreditBalance }))
vi.mock('./chatStream.js', () => ({ runChatStream }))
vi.mock('../service-key.js', () => ({ isInternalServiceKey }))
vi.mock('../mastra/tools.js', () => ({ releaseMCPClientForSession: vi.fn() }))
vi.mock('../persistence.js', () => ({
  updateClarificationRequest: vi.fn(),
  updateGenerationConfirmRequest: vi.fn(),
  fetchConversationAllowMode,
}))

import { chatRouter } from './chat.js'

const app = new Hono()
app.route('/', chatRouter)

function post(body: Record<string, unknown>) {
  return app.request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer tok' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  isInternalServiceKey.mockReturnValue(false)
  // A distinct sub per test keeps the module-level per-user rate limiter from
  // carrying counts between cases.
  validateToken.mockResolvedValue({ sub: `user-${Math.random()}`, 'custom:tenantId': 'tenant-A' })
  fetchAgentMemory.mockResolvedValue(null)
  checkCreditBalance.mockResolvedValue({ allowed: true, balanceMicro: 0n, unlimited: true })
  fetchConversationAllowMode.mockResolvedValue('ask')
  runChatStream.mockResolvedValue(undefined)
})

describe('POST /api/chat — agentId must belong to the JWT tenant', () => {
  it("refuses another tenant's agent with 404 and never starts the stream", async () => {
    agentBelongsToTenant.mockResolvedValue(false)

    const res = await post({ conversationId: 'conv-1', message: 'save that as a skill', agentId: 'tenant-B-agent' })

    expect(res.status).toBe(404)
    expect(agentBelongsToTenant).toHaveBeenCalledWith('tenant-B-agent', 'tenant-A')
    expect(runChatStream).not.toHaveBeenCalled()
  })

  it('does not leak whether the foreign agent exists', async () => {
    agentBelongsToTenant.mockResolvedValue(false)
    const res = await post({ conversationId: 'conv-1', message: 'hi', agentId: 'tenant-B-agent' })
    // Same status and body a nonexistent id would produce — no 403 to
    // distinguish "exists, but not yours" from "does not exist".
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Agent not found' })
  })

  it('allows an agent that does belong to the tenant', async () => {
    agentBelongsToTenant.mockResolvedValue(true)
    const res = await post({ conversationId: 'conv-1', message: 'hi', agentId: 'tenant-A-agent' })
    expect(res.status).toBe(200)
    expect(agentBelongsToTenant).toHaveBeenCalledWith('tenant-A-agent', 'tenant-A')
  })

  it('fails closed — a lookup error is a refusal, not a pass', async () => {
    // agentBelongsToTenant swallows its own query errors and returns false; this
    // pins that the route treats that false as a hard stop.
    agentBelongsToTenant.mockResolvedValue(false)
    const res = await post({ conversationId: 'conv-1', message: 'hi', agentId: 'any-agent' })
    expect(res.status).toBe(404)
  })

  it('skips the check when no agentId is supplied', async () => {
    const res = await post({ conversationId: 'conv-1', message: 'hi' })
    expect(res.status).toBe(200)
    expect(agentBelongsToTenant).not.toHaveBeenCalled()
  })
})

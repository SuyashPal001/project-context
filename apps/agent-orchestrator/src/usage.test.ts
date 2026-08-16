import { describe, it, expect, vi } from 'vitest'

const mockPoolQuery = vi.fn()
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/ai', () => ({ getAgentTools: vi.fn() }))
vi.mock('./db.js', () => ({ makeAppPool: vi.fn(() => ({ query: mockPoolQuery, on: vi.fn() })) }))

import { getAgentTools } from '@serverless-saas/ai'
import { fetchToolGovernance, fetchAgentModelSelection } from './usage.js'

describe('fetchToolGovernance', () => {
  it('maps getAgentTools output into the ToolGovernance shape', async () => {
    vi.mocked(getAgentTools).mockResolvedValueOnce({
      tools: [],
      requiresApprovalTools: ['gmail_send_message'],
      highStakeTools: ['gmail_send_message'],
    })
    const result = await fetchToolGovernance('agent-1', 'tenant-1', ['gmail'])
    expect(result).toEqual({
      requiresApprovalTools: ['gmail_send_message'],
      highStakeTools: ['gmail_send_message'],
    })
    expect(getAgentTools).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'agent-1', ['gmail'])
  })

  it('fails open (empty governance) when getAgentTools throws', async () => {
    vi.mocked(getAgentTools).mockRejectedValueOnce(new Error('db down'))
    const result = await fetchToolGovernance('agent-1', 'tenant-1', [])
    expect(result).toEqual({ requiresApprovalTools: [], highStakeTools: [] })
  })
})

describe('fetchAgentModelSelection', () => {
  it('returns provider/model/status when the agent has an llm_provider_id set', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ provider: 'openrouter', model: 'anthropic/claude-opus-5', status: 'live' }],
    })
    const result = await fetchAgentModelSelection('agent-1')
    expect(result).toEqual({ provider: 'openrouter', model: 'anthropic/claude-opus-5', status: 'live' })
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('llm_providers'), ['agent-1'])
  })

  it('returns null when the agent has no llm_provider_id (no matching row)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const result = await fetchAgentModelSelection('agent-2')
    expect(result).toBeNull()
  })

  it('scopes the joined llm_providers row to platform or same-tenant rows', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAgentModelSelection('agent-3')
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('lp.is_platform = true OR lp.tenant_id = a.tenant_id'),
      ['agent-3'],
    )
  })
})

import { describe, it, expect, vi } from 'vitest'

const mockPoolQuery = vi.fn()
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/ai', () => ({ getAgentTools: vi.fn() }))
vi.mock('./db.js', () => ({ makeAppPool: vi.fn(() => ({ query: mockPoolQuery, on: vi.fn() })) }))

import { getAgentTools } from '@serverless-saas/ai'
import { fetchToolGovernance, fetchAgentModelSelection, fetchAgentPersonality, fetchAgentMemory, fetchAgentSkill, recordSkillRun } from './usage.js'

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

describe('fetchAgentPersonality', () => {
  it('composes basePersonality with the persona core files in a fixed order', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        base_personality: 'You are warm and encouraging.',
        identity_file: 'IDENTITY: Visual Design Director',
        soul_file: 'SOUL: cares deeply about craft',
        agents_file: 'AGENTS: always propose 3 options',
        bootstrap_file: 'BOOTSTRAP: greet with a compliment',
        user_file: 'USER: prefers concise replies',
      }],
    })
    const result = await fetchAgentPersonality('agent-1')
    expect(result).toBe(
      'You are warm and encouraging.\n\n' +
      'IDENTITY: Visual Design Director\n\n' +
      'SOUL: cares deeply about craft\n\n' +
      'AGENTS: always propose 3 options\n\n' +
      'BOOTSTRAP: greet with a compliment\n\n' +
      'USER: prefers concise replies'
    )
  })

  it('falls back to just basePersonality when no core files are set', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        base_personality: 'You are warm and encouraging.',
        identity_file: null, soul_file: null, agents_file: null, bootstrap_file: null, user_file: null,
      }],
    })
    const result = await fetchAgentPersonality('agent-1')
    expect(result).toBe('You are warm and encouraging.')
  })

  it('returns null when the agent has no persona', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const result = await fetchAgentPersonality('agent-2')
    expect(result).toBeNull()
  })
})

describe('fetchAgentMemory', () => {
  it('returns the per-agent memory content', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ content: 'Tenant prefers dark mode.' }] })
    const result = await fetchAgentMemory('agent-1')
    expect(result).toBe('Tenant prefers dark mode.')
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('agent_memories'), ['agent-1'])
  })

  it('returns null when no memory row exists yet', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const result = await fetchAgentMemory('agent-2')
    expect(result).toBeNull()
  })
})

describe('fetchAgentSkill', () => {
  it('returns the install id so the caller can attribute the run to a tenant install', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ system_prompt: '# PDF Tools', tools: ['pdftotext'], config: null, install_id: 'install-1' }],
    })
    const result = await fetchAgentSkill('agent-1')
    expect(result).toEqual({ systemPrompt: '# PDF Tools', tools: ['pdftotext'], config: null, installId: 'install-1' })
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('install_id'), ['agent-1'])
  })

  it('returns null when the agent has no active skill', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    expect(await fetchAgentSkill('agent-2')).toBeNull()
  })
})

describe('recordSkillRun', () => {
  it('increments run_count on the tenant-scoped install row', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await recordSkillRun('install-1', 'tenant-1')
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('run_count = run_count + 1'),
      ['install-1', 'tenant-1'],
    )
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('tenant_id = $2'), ['install-1', 'tenant-1'])
  })
})

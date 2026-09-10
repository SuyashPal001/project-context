import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPoolQuery = vi.fn()
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/ai', () => ({ getAgentTools: vi.fn() }))
vi.mock('./db.js', () => ({ makeAppPool: vi.fn(() => ({ query: mockPoolQuery, on: vi.fn() })) }))

import { getAgentTools } from '@serverless-saas/ai'
import { fetchToolGovernance, fetchAgentModelSelection, fetchAgentPersonality, fetchAgentMemory, fetchAttachedSkills, fetchTestSkill, toMastraSkillName, agentBelongsToTenant, recordSkillRuns } from './usage.js'

beforeEach(() => {
  mockPoolQuery.mockReset()
})

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

describe('toMastraSkillName', () => {
  it('lowercases and hyphenates', () => {
    expect(toMastraSkillName('UGC Ad Production')).toBe('ugc-ad-production')
  })

  it('strips leading/trailing hyphens produced by punctuation', () => {
    expect(toMastraSkillName('  Bid Writer!!  ')).toBe('bid-writer')
  })

  it('falls back to "skill" when nothing alphanumeric survives', () => {
    expect(toMastraSkillName('###')).toBe('skill')
  })

  it('truncates to 64 characters, Mastra\'s InlineSkillInput.name limit', () => {
    const long = 'a'.repeat(100)
    expect(toMastraSkillName(long)).toHaveLength(64)
  })
})

describe('fetchTestSkill', () => {
  it('resolves the pinned version into a valid Mastra Skill', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'Bid Writer', description: 'Use when writing bids.', body: 'Open with the client name.' },
    ] })

    const skill = await fetchTestSkill('install-1', 'tenant-1')

    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('bid-writer')
    expect(skill!.description).toBe('Use when writing bids.')
    expect(skill!.instructions).toBe('Open with the client name.')
  })

  it('scopes the query to the tenant, not just the install id', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchTestSkill('install-1', 'tenant-1')
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('si.tenant_id = $2')
    expect(params).toEqual(['install-1', 'tenant-1'])
  })

  it('returns null for a revoked or foreign install id', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const skill = await fetchTestSkill('install-1', 'attacker-tenant')
    expect(skill).toBeNull()
  })

  it('returns null when the body is empty', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'empty', description: 'Use when empty.', body: '   ' }] })
    const skill = await fetchTestSkill('install-1', 'tenant-1')
    expect(skill).toBeNull()
  })

  it('synthesizes a description when the manifest has none', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'legacy-skill', description: null, body: 'Do the thing.' }] })
    const skill = await fetchTestSkill('install-1', 'tenant-1')
    expect(skill!.description).toContain('legacy-skill')
  })

  it('records a run for the resolved install', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ name: 'bid-writer', description: 'Use when writing bids.', body: 'Body.' }] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // the recordSkillRuns UPDATE
    await fetchTestSkill('install-1', 'tenant-1')
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the fire-and-forget settle
    expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    expect(mockPoolQuery.mock.calls[1][0]).toContain('UPDATE skill_installs')
  })
})

describe('fetchAttachedSkills', () => {
  it('returns a Mastra Skill for an installed row, resolved fresh', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'Bid Writer', system_prompt: null, install_id: 'install-1', version: 1 },
    ] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'Bid Writer', description: 'Use when writing bids.', body: 'Open with the client name.' },
    ] })

    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('bid-writer')
    expect(skills[0].instructions).toBe('Open with the client name.')
  })

  it('excludes the default persona row in the query itself', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAttachedSkills('agent-1', 'tenant-1')
    const sql = mockPoolQuery.mock.calls[0][0] as string
    expect(sql).toContain("name != 'default'")
  })

  it('scopes the query to the tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAttachedSkills('agent-1', 'tenant-1')
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('tenant_id = $2')
    expect(params).toEqual(['agent-1', 'tenant-1'])
  })

  it('dedupes by name, keeping the highest version, resolving only that one', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'bid-writer', system_prompt: null, install_id: 'install-1', version: 1 },
      { name: 'bid-writer', system_prompt: null, install_id: 'install-2', version: 2 },
    ] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'bid-writer', description: 'Use when writing bids.', body: 'New body v2.' },
    ] })

    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')

    expect(skills).toHaveLength(1)
    expect(mockPoolQuery.mock.calls[1][1]).toEqual(['install-2', 'tenant-1'])
  })

  it('uses the stored system_prompt directly for a hand-authored row (no install_id)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'internal-helper', system_prompt: 'Do the internal thing.', install_id: null, version: 1 },
    ] })

    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('internal-helper')
    expect(skills[0].instructions).toBe('Do the internal thing.')
    // No install to resolve — only the one agent_skills query ran.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
  })

  it('skips a hand-authored row with an empty system_prompt', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'empty', system_prompt: '  ', install_id: null, version: 1 },
    ] })
    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')
    expect(skills).toEqual([])
  })

  it('skips an installed row whose content fails to resolve', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'stale', system_prompt: null, install_id: 'install-1', version: 1 },
    ] })
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')
    expect(skills).toEqual([])
  })

  it('returns an empty array when the agent has no active skills', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const skills = await fetchAttachedSkills('agent-1', 'tenant-1')
    expect(skills).toEqual([])
  })
})

describe('agentBelongsToTenant', () => {
  it('is true only when the agent row matches both id and tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })
    await expect(agentBelongsToTenant('agent-1', 'tenant-1')).resolves.toBe(true)
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('tenant_id = $2')
    expect(params).toEqual(['agent-1', 'tenant-1'])
  })

  it('is false for another tenant\'s agent', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await expect(agentBelongsToTenant('victim-agent', 'attacker-tenant')).resolves.toBe(false)
  })

  it('fails closed when the query throws', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('connection reset'))
    await expect(agentBelongsToTenant('agent-1', 'tenant-1')).resolves.toBe(false)
  })

  it('is false for an empty agent or tenant id without querying', async () => {
    await expect(agentBelongsToTenant('', 'tenant-1')).resolves.toBe(false)
    await expect(agentBelongsToTenant('agent-1', '')).resolves.toBe(false)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})

describe('recordSkillRuns', () => {
  it('increments every composed install, not just the first', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] })
    await recordSkillRuns(['install-1', 'install-2'], 'tenant-1')
    expect(mockPoolQuery).toHaveBeenCalledTimes(2)
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['install-1', 'tenant-1'])
    expect(mockPoolQuery.mock.calls[1][1]).toEqual(['install-2', 'tenant-1'])
  })

  it('does nothing when there are no installs', async () => {
    await recordSkillRuns([], 'tenant-1')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPoolQuery = vi.fn()
vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('@serverless-saas/ai', () => ({ getAgentTools: vi.fn() }))
vi.mock('./db.js', () => ({ makeAppPool: vi.fn(() => ({ query: mockPoolQuery, on: vi.fn() })) }))

import { getAgentTools } from '@serverless-saas/ai'
import { fetchToolGovernance, fetchAgentModelSelection, fetchAgentPersonality, fetchAgentMemory, fetchAgentSkills, agentBelongsToTenant, recordSkillRuns } from './usage.js'

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

describe('fetchAgentSkills', () => {
  it('composes every active skill in attachment order', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'bid-writer', system_prompt: 'Open with the client name.', tools: null, config: null, install_id: 'install-1' },
      { name: 'tone-guide', system_prompt: 'Never promise a date.', tools: null, config: null, install_id: 'install-2' },
    ] })

    const composed = await fetchAgentSkills('agent-1', 'tenant-1')

    // Both bodies present, first-attached first.
    expect(composed.systemPrompt).toContain('Open with the client name.')
    expect(composed.systemPrompt).toContain('Never promise a date.')
    expect(composed.systemPrompt!.indexOf('Open with')).toBeLessThan(composed.systemPrompt!.indexOf('Never promise'))
    expect(composed.installIds).toEqual(['install-1', 'install-2'])
    expect(composed.droppedNames).toEqual([])
  })

  it('orders by created_at then id so the prompt is stable between turns', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAgentSkills('agent-1', 'tenant-1')
    const sql = mockPoolQuery.mock.calls[0][0] as string
    // The id tiebreaker matters: two rows attached in the same transaction can
    // share created_at, and without it their order can flip between turns.
    expect(sql).toContain('ORDER BY created_at ASC, id ASC')
    expect(sql).not.toContain('LIMIT 1')
  })

  // agent_skills.agent_id and agent_skills.tenant_id are independent foreign
  // keys, so a row pairing this tenant with another tenant's agent (or the
  // reverse) is representable. Composing by agent_id alone meant an attacker
  // who got such a row written could inject text into the victim tenant's
  // system prompt on every turn.
  it('scopes the query to the tenant, not just the agent', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await fetchAgentSkills('agent-1', 'tenant-1')
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('tenant_id = $2')
    expect(params).toEqual(['agent-1', 'tenant-1'])
  })

  it('composes nothing when the rows belong to another tenant', async () => {
    // The filter lives in SQL, so a mismatched tenant returns no rows at all.
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const composed = await fetchAgentSkills('agent-1', 'attacker-tenant')
    expect(composed).toEqual({ systemPrompt: null, installIds: [], droppedNames: [] })
  })

  it('returns a null prompt when the agent has no active skills', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const composed = await fetchAgentSkills('agent-1', 'tenant-1')
    expect(composed).toEqual({ systemPrompt: null, installIds: [], droppedNames: [] })
  })

  // Legacy agents can already hold more rows than the cap allows — those rows
  // were being ignored entirely before this change, so dropping the overflow
  // is strictly better than today, but it must be loud rather than silent.
  it('drops skills past the count cap and names them', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      name: `skill-${i}`, system_prompt: `body ${i}`, tools: null, config: null, install_id: `install-${i}`,
    }))
    mockPoolQuery.mockResolvedValueOnce({ rows })

    const composed = await fetchAgentSkills('agent-1', 'tenant-1')

    expect(composed.installIds).toHaveLength(8)
    expect(composed.droppedNames).toEqual(['skill-8', 'skill-9'])
    expect(composed.systemPrompt).not.toContain('body 8')
  })

  // agent_skills.install_id is nullable for hand-authored skills, so the cap
  // must count every composed skill — not just those with an install id — or
  // an agent with only hand-authored skills bypasses the count cap entirely.
  // All 9 rows here carry install_id: null on purpose: gating on
  // installIds.length (the pre-fix logic) would never reach 8, so all 9
  // would compose and this test would fail against that code. Gating on
  // composed-parts count catches it at the 9th row regardless of install id.
  it('counts hand-authored skills (null install_id) against the cap', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      name: `hand-authored-${i}`, system_prompt: `body ${i}`, tools: null, config: null, install_id: null, version: 1,
    }))
    mockPoolQuery.mockResolvedValueOnce({ rows })

    const composed = await fetchAgentSkills('agent-1', 'tenant-1')

    expect(composed.installIds).toHaveLength(0)
    expect(composed.droppedNames).toEqual(['hand-authored-8'])
    expect(composed.systemPrompt).not.toContain('body 8')
  })

  // agent_skills is unique on (agent_id, tenant_id, name, version) — the
  // attach route can write a new version for a skill name without
  // deactivating the old row, so two active rows can share a name.
  it('dedupes by name, keeping the highest version, before caps are applied', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'bid-writer', system_prompt: 'Old body v1.', tools: null, config: null, install_id: 'install-1', version: 1 },
      { name: 'bid-writer', system_prompt: 'New body v2.', tools: null, config: null, install_id: 'install-2', version: 2 },
    ] })

    const composed = await fetchAgentSkills('agent-1', 'tenant-1')

    expect(composed.systemPrompt).toContain('New body v2.')
    expect(composed.systemPrompt).not.toContain('Old body v1.')
    expect(composed.installIds).toEqual(['install-2'])
  })

  it('drops skills past the character budget', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'huge', system_prompt: 'x'.repeat(23_900), tools: null, config: null, install_id: 'install-1' },
      { name: 'small', system_prompt: 'y'.repeat(500), tools: null, config: null, install_id: 'install-2' },
    ] })

    const composed = await fetchAgentSkills('agent-1', 'tenant-1')

    expect(composed.installIds).toEqual(['install-1'])
    expect(composed.droppedNames).toEqual(['small'])
    expect(composed.systemPrompt!.length).toBeLessThanOrEqual(24_000 + 200) // bodies plus per-skill headers
  })

  it('skips rows with a null system_prompt without dropping the rest', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { name: 'empty', system_prompt: null, tools: null, config: null, install_id: 'install-1' },
      { name: 'real', system_prompt: 'Do the thing.', tools: null, config: null, install_id: 'install-2' },
    ] })

    const composed = await fetchAgentSkills('agent-1', 'tenant-1')

    expect(composed.systemPrompt).toContain('Do the thing.')
    expect(composed.installIds).toEqual(['install-2'])
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

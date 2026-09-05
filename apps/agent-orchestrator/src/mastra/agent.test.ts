import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGenerate = vi.hoisted(() => vi.fn(async (_messages: unknown, _options: { requestContext: import('@mastra/core/request-context').RequestContext }) => ({ text: 'ok' })))

vi.mock('./index.js', () => ({
  platformAgent: { generate: mockGenerate, id: 'disco', name: 'Disco' },
}))
vi.mock('./tools.js', () => ({ getMCPClientForTenant: vi.fn(() => ({ disconnect: vi.fn() })) }))
vi.mock('../usage.js', () => ({
  fetchAgentPersonality: vi.fn(async () => 'You are the Visual Design Director.'),
  fetchAgentSkills: vi.fn(async () => ({ systemPrompt: 'Custom skill override prompt', installIds: [], droppedNames: [] })),
}))

import { fetchAgentPersonality, fetchAgentSkills } from '../usage.js'
import { createTenantAgent } from './agent.js'

describe('createTenantAgent — background-task path persona/skill parity with chat', () => {
  beforeEach(() => vi.clearAllMocks())

  it('injects personaPersonality and agentSystemPrompt into requestContext, same as chatStream.ts', async () => {
    const { agent } = await createTenantAgent({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      agentSlug: 'visual-design-director',
      instructions: 'unused-legacy-field',
      connectedProviders: [],
    })

    await agent.generate('run the scheduled shift')

    expect(fetchAgentPersonality).toHaveBeenCalledWith('agent-1')
    expect(fetchAgentSkills).toHaveBeenCalledWith('agent-1', 'tenant-1')

    const [, options] = mockGenerate.mock.calls[0]
    expect(options.requestContext.get('personaPersonality')).toBe('You are the Visual Design Director.')
    expect(options.requestContext.get('agentSystemPrompt')).toBe('Custom skill override prompt')
  })
})

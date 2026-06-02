import type { Agent } from '@mastra/core/agent'
import { platformAgent } from './agents/platformAgent.js'
import { pmAgent } from './agents/pmAgent.js'
import { architectAgent } from './agents/architectAgent.js'
// Map of DB agent name (lowercased) → Mastra agent instance.
// Exact-match keys are tried first; substring fallback uses the same keys.
const AGENT_REGISTRY: Record<string, Agent> = {
  disco:      platformAgent as unknown as Agent,
  'pm agent': pmAgent as unknown as Agent,
  architect:  architectAgent as unknown as Agent,
}

/**
 * Resolve a Mastra agent from the conversation's agent name string.
 * Exact match first, then substring match, then Saarthi default.
 */
export function resolveAgent(agentName: string): Agent {
  const key = (agentName ?? '').toLowerCase().trim()
  if (AGENT_REGISTRY[key]) return AGENT_REGISTRY[key]
  for (const [name, agent] of Object.entries(AGENT_REGISTRY)) {
    if (key.includes(name)) return agent
  }
  // Disco (platformAgent) is the default for
  // all tenants — handles unknown agent names
  return platformAgent as unknown as Agent
}

export function resolveAgentLabel(agent: Agent): string {
  if (agent === (architectAgent as unknown as Agent)) return 'architectAgent'
  if (agent === (pmAgent as unknown as Agent)) return 'pmAgent'

  return 'platformAgent'
}

// Canonical seed definitions for the agents auto-created per tenant.
// Consumed by onboarding + backfill scripts.
export const DEFAULT_AGENTS = [
  {
    name: 'Disco',
    description: 'Your AI assistant',
    type: 'assistant',
    status: 'active',
    is_internal: false,
    apiKeyName: 'Disco API Key',
    isDefault: true,
  },
  {
    name: 'PM Agent',
    description: 'Creates PRDs, roadmaps and tasks',
    type: 'pm',
    status: 'active',
    is_internal: false,
    apiKeyName: 'PM Agent API Key',
  },
  {
    name: 'Architect',
    description: 'Technical architect with codebase knowledge',
    type: 'assistant',
    status: 'active',
    is_internal: false,
    apiKeyName: 'Architect API Key',
  },

] as const

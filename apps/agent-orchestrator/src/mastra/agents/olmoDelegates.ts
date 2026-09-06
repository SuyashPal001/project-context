import type { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../context.js'
import { pmAgentDelegate } from './pmAgent.js'
import { architectAgentDelegate } from './architectAgent.js'
import { directorAgentDelegate } from './directorAgent.js'
import { producerAgentDelegate } from './producerAgent.js'

// platformAgent (Olmo) is resolveAgent's fallback for EVERY unmatched agent
// row — Research Engineer, Analyst, custom tenant agents, all of them. This
// function is what keeps delegation scoped to the seeded Olmo row only: it
// reads the resolved conversation's agent name (set into requestContext by
// each call site — chatStream.ts, index.ts, mastra/agent.ts) and returns the
// delegate map ONLY when that name is "olmo". Every other row falling
// through to platformAgent gets an empty map — same as today, unchanged.
export function buildOlmoDelegates(
  { requestContext }: { requestContext?: RequestContext<TenantContext> }
): Record<string, Agent> {
  const agentName = (requestContext?.get('agentName') as string | undefined ?? '').toLowerCase().trim()
  if (agentName !== 'olmo') return {}
  return {
    pm: pmAgentDelegate as unknown as Agent,
    architect: architectAgentDelegate as unknown as Agent,
    director: directorAgentDelegate as unknown as Agent,
    producer: producerAgentDelegate as unknown as Agent,
  }
}

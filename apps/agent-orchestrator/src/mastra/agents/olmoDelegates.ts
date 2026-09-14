import type { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../context.js'
import { resolveDelegates } from '../subagents/resolve.js'

// platformAgent (Olmo) is resolveAgent's fallback for EVERY unmatched agent
// row — Research Engineer, Analyst, custom tenant agents, all of them. The
// gate that keeps delegation scoped to the seeded Olmo row now lives in
// subagents/sources.ts (hostAllows), alongside the depth ceiling and the
// entitlement filter. This function stays as the name platformAgent.ts:435
// binds to.
export function buildOlmoDelegates(
  args: { requestContext?: RequestContext<TenantContext> },
): Record<string, Agent> {
  // Conversational turns (thinkingBudget === 0 per thinking.ts — greetings,
  // acks, sub-15-char messages) must never reach a delegate. The delegates'
  // tool descriptions ("PM supervisor…", "Generates images…") were tempting
  // the model to fire `agent-pm` on inputs as trivial as "hi", so the reply
  // that surfaced was pmAgent's clarification, not Olmo's own. Hiding the
  // whole map for the turn is a hard guarantee that prompt tightening isn't.
  const budget = args.requestContext?.get('thinkingBudget') as number | undefined
  if (budget === 0) return {}
  return resolveDelegates(args)
}

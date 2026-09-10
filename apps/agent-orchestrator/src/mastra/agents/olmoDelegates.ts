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
  return resolveDelegates(args)
}

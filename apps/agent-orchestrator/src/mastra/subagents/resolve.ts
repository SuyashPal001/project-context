import type { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../context.js'
import { listSpecs, maxDepthForHost, hostAllows } from './sources.js'

/**
 * Specs plus request context to the delegate map Mastra asks for.
 *
 * Synchronous and pure on purpose. Nothing here does IO: specs are
 * module-level and every per-request fact is loaded into RequestContext
 * upstream, the same way fetchAgentName()/fetchAgentContext() already work.
 * Making this async would put an await in front of every turn and make the
 * whole control plane untestable without a database.
 *
 * The structural claim: this never returns an Agent the caller is not allowed
 * to use. Depth, host and entitlement are all expressed as absence from the
 * map — there is no downstream check and no prompt telling Olmo what not to
 * call.
 */
export function resolveDelegates(
  { requestContext }: { requestContext?: RequestContext<TenantContext> },
): Record<string, Agent> {
  const ctx = requestContext
  const agentName = ((ctx?.get('agentName') as string | undefined) ?? '').toLowerCase().trim()
  const depth = (ctx?.get('delegationDepth') as number | undefined) ?? 0
  const allowed = ctx?.get('allowedSubAgents') as string[] | undefined

  if (depth >= maxDepthForHost(agentName)) return {}

  const specs = listSpecs()
    .filter(spec => hostAllows(agentName, spec))
    // An entitlement-gated spec is absent, not present-and-blocked. `allowed`
    // being undefined means the source is unconfigured — fail open, since a
    // silently missing capability looks to the user like Olmo doing the job
    // badly with no signal anything was hidden.
    .filter(spec => !allowed || !spec.requiresEntitlement || allowed.includes(spec.id))

  return Object.fromEntries(specs.map(spec => [spec.id, spec.build()]))
}

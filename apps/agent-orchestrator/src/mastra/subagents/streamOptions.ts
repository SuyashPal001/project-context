import type { DelegationConfig } from '@mastra/core/agent'
import { buildDelegationConfig, type DelegationHost, type HookDeps } from './hooks.js'

/**
 * The supervisor's own step budget. Untouched, Mastra applies stepCountIs(5),
 * which for a supervisor is roughly four delegations before it is cut off
 * mid-answer. Five was never a decision anyone made; twenty is.
 */
export const OLMO_MAX_STEPS = 20

/**
 * The options every Olmo stream() call must spread in. `delegation` is a
 * per-execution option in @mastra/core 1.64 — there is no Agent-level place to
 * put it — so this exists to keep the SSE and WebSocket paths from drifting.
 *
 * `host` carries the stable per-stream facts (tenantId/conversationId/agentId)
 * that `buildDelegationConfig`'s hooks need — `DelegationCompleteContext` has
 * no `requestContext` field in @mastra/core 1.64, so these cannot be read back
 * out of the delegation context itself and must be threaded in from whatever
 * the call site already has in scope.
 */
export function olmoDelegationOptions(
  host: DelegationHost,
  deps: HookDeps = {},
): { maxSteps: number; delegation: DelegationConfig } {
  return { maxSteps: OLMO_MAX_STEPS, delegation: buildDelegationConfig(host, deps) }
}

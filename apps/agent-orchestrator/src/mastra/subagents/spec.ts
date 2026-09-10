import type { Agent } from '@mastra/core/agent'

/**
 * One delegate, described independently of how it was built.
 *
 * `build: () => Agent` is the hinge that makes a database-backed registry a
 * later source swap rather than a rewrite: the code source returns the
 * existing module constant, a row source would construct an Agent from a row,
 * and resolve.ts never learns which it got.
 *
 * Deliberately absent: `tools` and `model` (the delegates own theirs; a second
 * copy here would be a second source of truth with nothing keeping the two in
 * sync), and any routing `priority` (ordering a delegate map does nothing —
 * the model routes on descriptions).
 */
export interface SubAgentSpec {
  id: string
  build: () => Agent
  description: string
  tags: string[]
  /** Replaces Mastra's silent stepCountIs(5) default for this delegate. */
  maxSteps: number
  /** Micro-credits, matching checkCreditBalance's balanceMicro units. */
  estimatedCredits: number
  /** How deep THIS agent may delegate. 0 = cannot delegate. */
  maxDepth: number
  requiresEntitlement?: string
  background?: { enabled: true; timeoutMs: number }
  /** A single spec id, or none. No chains — see the spec's non-goals. */
  fallback?: string
}

export type SubAgentSpecInput = Omit<SubAgentSpec, 'maxDepth'> & { maxDepth?: number }

export class SubAgentSpecError extends Error {
  constructor(specId: string, problem: string) {
    super(`sub-agent spec "${specId}": ${problem}`)
    this.name = 'SubAgentSpecError'
  }
}

/**
 * The description is the entire routing signal Olmo has. A description with no
 * "not for" clause is the single largest cause of misrouting, and a misroute
 * costs a whole sub-agent run — so the floor is enforced, not documented. Same
 * mechanism skillManifest.ts uses for skill descriptions.
 */
export const NEGATIVE_CLAUSE = /\b(not for|don'?t use|do not use|never use|avoid)\b/i

export function defineSubAgent(input: SubAgentSpecInput): SubAgentSpec {
  const id = input.id?.trim() ?? ''
  if (!id) throw new SubAgentSpecError(String(input.id), 'id must be a non-empty string')
  if (!NEGATIVE_CLAUSE.test(input.description ?? '')) {
    throw new SubAgentSpecError(id, 'description must say what this delegate is NOT for (e.g. "Not for video.")')
  }
  if (!Number.isFinite(input.maxSteps) || input.maxSteps < 1) {
    throw new SubAgentSpecError(id, `maxSteps must be >= 1, got ${input.maxSteps}`)
  }
  if (!Number.isFinite(input.estimatedCredits) || input.estimatedCredits < 0) {
    throw new SubAgentSpecError(id, `estimatedCredits must be >= 0, got ${input.estimatedCredits}`)
  }
  const maxDepth = input.maxDepth ?? 0
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new SubAgentSpecError(id, `maxDepth must be an integer >= 0, got ${maxDepth}`)
  }
  if (typeof input.build !== 'function') {
    throw new SubAgentSpecError(id, 'build must be a function returning an Agent')
  }
  return { ...input, id, maxDepth }
}

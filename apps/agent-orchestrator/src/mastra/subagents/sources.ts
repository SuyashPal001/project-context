import { defineSubAgent, SubAgentSpecError, type SubAgentSpec } from './spec.js'
import { pmAgentDelegate } from '../agents/pmAgent.js'
import { architectAgentDelegate } from '../agents/architectAgent.js'
import { directorAgentDelegate } from '../agents/directorAgent.js'
import { producerAgentDelegate } from '../agents/producerAgent.js'
import { BACKGROUND_TASKS_ENABLED } from '../backgroundTasks.js'
import { CODE_SPEC_IDS } from './ids.js'
import { stubSpec, STUB_ENABLED } from './stub.js'
import type { Agent } from '@mastra/core/agent'

/**
 * Olmo is the root and may delegate one level. Raising this is the whole
 * two-level rule, so it lives here as one named constant rather than being
 * spread across specs.
 */
export const OLMO_HOST_MAX_DEPTH = 1

/** The host row that may delegate at all. Lowercased comparison. */
const OLMO_HOST = 'olmo'

/**
 * The unconditional, always-registered code specs. This is exactly the set
 * `assertMatchesCodeSpecIds` checks against `ids.ts`'s `CODE_SPEC_IDS` — see
 * that function's doc comment for why an env-gated spec must never be folded
 * in here.
 */
const CODE_SPECS: SubAgentSpec[] = [
  defineSubAgent({
    id: 'pm',
    build: () => pmAgentDelegate as unknown as Agent,
    description: 'Breaks a product ask into a PRD, roadmap and tasks. Not for generating images, video or audio, and not for writing code.',
    tags: ['product', 'planning'],
    maxSteps: 12,
    estimatedCredits: 2_000,
  }),
  defineSubAgent({
    id: 'architect',
    build: () => architectAgentDelegate as unknown as Agent,
    description: 'Designs technical approaches and reviews system structure. Not for generating media, and not for product prioritisation.',
    tags: ['engineering'],
    maxSteps: 12,
    estimatedCredits: 2_000,
  }),
  defineSubAgent({
    id: 'director',
    build: () => directorAgentDelegate as unknown as Agent,
    description: 'Generates and edits images, and generates short video clips, from a text description. Not for music or speech, and not for written copy.',
    tags: ['image', 'video'],
    maxSteps: 8,
    estimatedCredits: 20_000,
  }),
  defineSubAgent({
    id: 'producer',
    build: () => producerAgentDelegate as unknown as Agent,
    description: 'Generates music and audio from a description. Not for images or video, and not for written copy.',
    tags: ['audio'],
    maxSteps: 8,
    estimatedCredits: 20_000,
  }),
]

/**
 * Everything that can actually be delegated to, including the smoke stub
 * when the flag is on. `assertRegistryValid` (duplicate ids, fallback
 * targets) and `assertBackgroundSupported` must see this — not just
 * `CODE_SPECS` — because those checks exist to cover everything reachable
 * at runtime, not just the fixed code contract. `listSpecs`/`getSpec` read
 * from this too, so the stub is resolvable and delegatable once enabled.
 */
const SPECS: SubAgentSpec[] = [...CODE_SPECS, ...(STUB_ENABLED ? [stubSpec] : [])]

/**
 * Cross-spec checks that cannot run inside defineSubAgent, because they need
 * every spec registered first. Called at module load below, so a bad registry
 * fails at boot.
 */
export function assertRegistryValid(specs: SubAgentSpec[]): void {
  const ids = new Set<string>()
  for (const spec of specs) {
    if (ids.has(spec.id)) throw new SubAgentSpecError(spec.id, 'duplicate spec id')
    ids.add(spec.id)
  }
  for (const spec of specs) {
    if (!spec.fallback) continue
    if (spec.fallback === spec.id) throw new SubAgentSpecError(spec.id, 'fallback points at itself')
    if (!ids.has(spec.fallback)) throw new SubAgentSpecError(spec.id, `fallback "${spec.fallback}" is not a registered spec`)
  }
}

/**
 * A spec declaring background while the manager is off declares something
 * inert: the delegation runs inline, and a video-length call blocks its
 * parent. Fail at boot instead.
 */
export function assertBackgroundSupported(specs: SubAgentSpec[], enabled = BACKGROUND_TASKS_ENABLED): void {
  if (enabled) return
  for (const spec of specs) {
    if (spec.background?.enabled) {
      throw new SubAgentSpecError(spec.id, 'declares background, but backgroundTasks is disabled on the Mastra instance')
    }
  }
}

/**
 * Confirms ids.ts's `CODE_SPEC_IDS` — the copy usage.ts reads so it never
 * has to import this file's Agent-construction chain (see ids.ts's doc
 * comment) — hasn't drifted from the specs actually registered here.
 * Compared as sets: order is not part of the contract.
 *
 * Callers must pass only the UNCONDITIONALLY registered specs. A spec
 * gated behind an env flag (e.g. a smoke-test stub) is not part of the
 * fixed contract `CODE_SPEC_IDS` promises — its presence depends on the
 * environment, so folding it into `specs` here would make this assertion
 * flip pass/fail with an unrelated flag instead of catching real drift.
 * Filter such specs out (or register them after this call, separately)
 * rather than passing them in.
 */
export function assertMatchesCodeSpecIds(specs: SubAgentSpec[], expectedIds: readonly string[]): void {
  const actual = new Set(specs.map(s => s.id))
  const expected = new Set(expectedIds)
  const missing = [...expected].filter(id => !actual.has(id))
  const extra = [...actual].filter(id => !expected.has(id))
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`missing from SPECS: ${missing.join(', ')}`)
    if (extra.length > 0) parts.push(`extra in SPECS not in CODE_SPEC_IDS: ${extra.join(', ')}`)
    throw new SubAgentSpecError('CODE_SPEC_IDS', `drifted from registered specs (${parts.join('; ')})`)
  }
}

assertRegistryValid(SPECS)
assertBackgroundSupported(SPECS)
assertMatchesCodeSpecIds(CODE_SPECS, CODE_SPEC_IDS)

export function listSpecs(): SubAgentSpec[] {
  return SPECS
}

/** Looks a spec up by its SPEC id ('director'). See getSpecByAgentId for the other key. */
export function getSpec(id: string): SubAgentSpec | undefined {
  return SPECS.find(s => s.id === id)
}

/**
 * Index from each delegate Agent's own `id` to its spec.
 *
 * Two id spaces exist and must not be confused. A spec id ('director') keys
 * the delegate map resolveDelegates returns, so it only names the TOOL Mastra
 * builds (`agent-director`). The delegation hooks never see it: Mastra fills
 * `primitiveId` from the delegate Agent's own id — `primitiveId: agent.id` at
 * agent-Dp3vcrIx.cjs:35121 (start) and :35551 / :35614 (complete) — and those
 * ids are 'pc-pm-delegate', 'pc-director-delegate' and so on. Looking a hook's
 * primitiveId up with getSpec() therefore misses every real delegation.
 *
 * The Agent ids are deliberately NOT renamed to match the spec ids:
 * suspended-run snapshots are keyed by them.
 *
 * Built once at module load from `spec.build().id`. Every current `build` returns
 * a module constant, so this constructs nothing. Two specs whose Agents share
 * an id would make the lookup ambiguous, so that fails at boot like every
 * other registry defect.
 */
export function buildAgentIdIndex(specs: SubAgentSpec[]): ReadonlyMap<string, SubAgentSpec> {
  const index = new Map<string, SubAgentSpec>()
  for (const spec of specs) {
    const agentId = spec.build().id
    const clash = index.get(agentId)
    if (clash) throw new SubAgentSpecError(spec.id, `delegate Agent id "${agentId}" is already used by spec "${clash.id}"`)
    index.set(agentId, spec)
  }
  return index
}

const SPECS_BY_AGENT_ID = buildAgentIdIndex(SPECS)

/**
 * Looks a spec up by its delegate Agent's id — the value Mastra puts in a
 * delegation hook's `primitiveId`. Use this, not getSpec, anywhere the key
 * came from Mastra.
 */
export function getSpecByAgentId(agentId: string): SubAgentSpec | undefined {
  return SPECS_BY_AGENT_ID.get(agentId)
}

/**
 * Depth is read from the HOST's spec, not the delegate's: maxDepth says how
 * deep that agent may delegate. A specialist with maxDepth 0 therefore
 * receives an empty delegate map and has nothing to call.
 */
export function maxDepthForHost(agentName: string): number {
  const name = agentName.toLowerCase().trim()
  if (name === OLMO_HOST) return OLMO_HOST_MAX_DEPTH
  return getSpec(name)?.maxDepth ?? 0
}

/**
 * Which host may see which spec. Today: Olmo sees all of them and nobody else
 * sees any — the gate that stops every custom agent row falling through
 * platformAgent and inheriting Olmo's delegates.
 */
export function hostAllows(agentName: string, _spec: SubAgentSpec): boolean {
  return agentName.toLowerCase().trim() === OLMO_HOST
}

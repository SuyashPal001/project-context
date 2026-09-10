import { defineSubAgent, SubAgentSpecError, type SubAgentSpec } from './spec.js'
import { pmAgentDelegate } from '../agents/pmAgent.js'
import { architectAgentDelegate } from '../agents/architectAgent.js'
import { directorAgentDelegate } from '../agents/directorAgent.js'
import { producerAgentDelegate } from '../agents/producerAgent.js'
import { BACKGROUND_TASKS_ENABLED } from '../backgroundTasks.js'
import type { Agent } from '@mastra/core/agent'

/**
 * Olmo is the root and may delegate one level. Raising this is the whole
 * two-level rule, so it lives here as one named constant rather than being
 * spread across specs.
 */
export const OLMO_HOST_MAX_DEPTH = 1

/** The host row that may delegate at all. Lowercased comparison. */
const OLMO_HOST = 'olmo'

const SPECS: SubAgentSpec[] = [
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

assertRegistryValid(SPECS)
assertBackgroundSupported(SPECS)

export function listSpecs(): SubAgentSpec[] {
  return SPECS
}

export function getSpec(id: string): SubAgentSpec | undefined {
  return SPECS.find(s => s.id === id)
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

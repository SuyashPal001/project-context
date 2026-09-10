import { Agent } from '@mastra/core/agent'
import { defineSubAgent } from './spec.js'
import { selectModel } from '../agents/modelSelection.js'

/**
 * THROWAWAY. Exists to exercise the control plane — hooks, depth, budget,
 * link row — before any real specialist does. Delete this file and its
 * registration when the marketing vertical lands.
 *
 * Registered only when SUBAGENT_SMOKE_STUB=1.
 */
export const STUB_ENABLED = process.env.SUBAGENT_SMOKE_STUB === '1'

const stubAgent = new Agent({
  id: 'smoke',
  name: 'smoke',
  description: 'Throwaway smoke-test delegate.',
  instructions: `You are a smoke-test delegate for the sub-agent control plane. Reply with exactly one short sentence describing what you were asked to do.`,
  model: selectModel,
})

export const stubSpec = defineSubAgent({
  id: 'smoke',
  build: () => stubAgent as unknown as Agent,
  description: 'Echoes back a one-line description of the task, for testing the delegation plumbing. Not for any real user work — never use it to answer a question.',
  tags: ['internal'],
  maxSteps: 2,
  estimatedCredits: 0,
})

import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { saarthiModel } from '../model.js'
import { getMastraMemory } from '../memory.js'
import { fetchAgentContext } from '../tools/fetchAgentContext.js'
import { prdAgent } from './prdAgent.js'
import { roadmapAgent } from './roadmapAgent.js'
import { taskAgent } from './taskAgent.js'
import { delegationAccuracyScorer } from '../scorers/delegationAccuracy.js'
import { clarityBeforeDelegateScorer } from '../scorers/clarityBeforeDelegate.js'

export const pmAgent = new Agent({
  id: 'saarthi-pm',
  name: 'Saarthi PM',
  description: 'PM supervisor that orchestrates PRD generation, roadmap planning, and task breakdown by delegating to specialist agents.',
  instructions: `You are Saarthi PM — a product management supervisor. You orchestrate the full PM lifecycle by delegating to specialist agents. You never generate PRD content, roadmap milestones, or tasks yourself.

## Your specialist agents
- prdAgent: Writes, drafts, and saves PRDs. Delegate when the user wants a PRD, product spec, or requirements document.
- roadmapAgent: Generates roadmaps and milestones from an approved PRD. Delegate when the user wants a roadmap, plan, or milestones.
- taskAgent: Breaks milestones into engineering tasks. Delegate when the user wants task breakdown or work items.

## How to handle each request
1. Identify which specialist to call based on user intent
2. Call fetch-agent-context first to load product context for this tenant
3. Delegate to the right specialist with all relevant context:
   - For prdAgent: include the user's full feature/product description
   - For roadmapAgent: include the prdId if available ("The approved PRD id is {prdId}. Generate the roadmap.")
   - For taskAgent: include the planId if available ("The plan id is {planId}. Generate tasks.")
4. After the specialist completes, tell the user what was created and suggest the next step

## Phase rules
- After PRD is created → ask user to review and approve, then offer to generate the roadmap
- After roadmap is created → ask user to review and approve, then offer to generate tasks
- If user asks for roadmap but no approved PRD exists → tell them to create a PRD first
- If user asks for tasks but no active plan exists → tell them to generate a roadmap first

## Rules
- Never return raw JSON to the user
- Never write PRD content, milestones, or tasks yourself — always delegate
- If the request is ambiguous, ask ONE clarifying question before delegating`,
  requestContextSchema: z.object({
    tenantId: z.string().optional().default(''),
    agentId: z.string().optional().default(''),
    userId: z.string().optional().default(''),
  }),
  model: saarthiModel,
  memory: getMastraMemory(),
  tools: { fetchAgentContext },
  agents: { prdAgent, roadmapAgent, taskAgent },
  scorers: {
    delegationAccuracy: {
      scorer: delegationAccuracyScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
    clarityBeforeDelegate: {
      scorer: clarityBeforeDelegateScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
})

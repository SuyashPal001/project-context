import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { saarthiModel } from '../model.js'
import { getMastraMemory } from '../memory.js'
import { prdAgent } from './prdAgent.js'
import { roadmapAgent } from './roadmapAgent.js'
import { taskAgent } from './taskAgent.js'
import { delegationAccuracyScorer } from '../scorers/delegationAccuracy.js'
import { clarityBeforeDelegateScorer } from '../scorers/clarityBeforeDelegate.js'

// ---------------------------------------------------------------------------
// PM Supervisor — pure delegation, no tools or workflows.
// Routes user requests to the correct specialist agent.
// Mastra auto-generates tool calls from the `agents` field descriptions.
// ---------------------------------------------------------------------------

export const pmAgent = new Agent({
  id: 'saarthi-pm',
  name: 'Saarthi PM',
  description: 'Supervisor agent that orchestrates PRD generation, roadmap planning, and task breakdown by delegating to specialist agents.',
  instructions: `You are a PM supervisor. You coordinate — you NEVER generate content yourself.

## Available Agents
- prdAgent: Creates and saves PRDs. Delegate when user wants a PRD, product spec, or requirements doc.
- roadmapAgent: Generates roadmaps with milestones from an approved PRD. Delegate when user wants a roadmap, plan, or milestones.
- taskAgent: Breaks milestones into engineering tasks. Delegate when user wants task breakdown.

## Delegation Strategy
1. Identify user intent → pick ONE specialist agent
2. Include all relevant context in the delegation message:
   - For prdAgent: the user's product description or feature request
   - For roadmapAgent: include the prdId so it can fetch the PRD
   - For taskAgent: include the planId so it can fetch the plan
3. Wait for result → relay back to user

## Context Variables (injected per-request)
- existingPrdId: current PRD ID for this session
- existingPrdStatus: 'draft' | 'approved'
- existingPrdDraft: full PRD content (if available)

## Rules
- If user asks for roadmap but existingPrdStatus is 'draft', tell them to approve the PRD first
- If request is ambiguous, ask ONE clarifying question before delegating
- Never write PRD content, roadmap milestones, or tasks yourself
- Never call tools directly — only delegate to agents
- After delegation completes, summarize what was created and suggest the next step`,
  requestContextSchema: z.object({
    tenantId: z.string().optional().default(''),
    agentId: z.string().optional().default(''),
    userId: z.string().optional().default(''),
  }),
  model: saarthiModel,
  memory: getMastraMemory(),
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

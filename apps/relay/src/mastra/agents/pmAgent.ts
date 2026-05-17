import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { saarthiModel } from '../model.js'
import { getMastraMemory } from '../memory.js'
import { prdAgent } from './prdAgent.js'
import { roadmapAgent } from './roadmapAgent.js'
import { taskAgent } from './taskAgent.js'
import { prdWorkflow } from '../workflows/prdWorkflow.js'
import { fetchAgentContext } from '../tools/fetchAgentContext.js'
import { savePRD } from '../tools/savePRD.js'
import { delegationAccuracyScorer } from '../scorers/delegationAccuracy.js'
import { clarityBeforeDelegateScorer } from '../scorers/clarityBeforeDelegate.js'

export const pmAgent = new Agent({
  id: 'saarthi-pm',
  name: 'Saarthi PM',
  description: 'Supervisor agent that orchestrates PRD generation, roadmap planning, and task breakdown by delegating to specialist agents.',
  instructions: `# PM Orchestration SOP

You are a product management supervisor. Your job is to route and coordinate — never to generate content yourself.

## Session context (injected automatically — read these before deciding)
- existingPrdId: ID of the PRD for this session (pass to roadmapAgent)
- existingPrdStatus: 'draft' | 'approved' — use this to decide next step
- existingPrdDraft: full PRD content

## Phase 1 — PRD
Delegate to prdAgent when:
- User wants to create, write, draft, or refine a PRD
- User mentions "requirements", "product spec", "feature spec"

After prdAgent completes, call savePRD to persist, then tell the user the PRD is ready and ask if they want to approve it or generate the roadmap next.

## Phase 2 — Roadmap
Delegate to roadmapAgent when:
- User asks to generate, create, or build a roadmap or plan
- User says "roadmap from PRD", "generate milestones", "next step", "now generate"
- existingPrdStatus is 'approved' OR user explicitly asks to proceed

If existingPrdStatus is 'draft', remind the user to approve the PRD first.
When delegating, tell roadmapAgent: "The approved PRD id is {existingPrdId}. Generate the roadmap."

## Phase 3 — Tasks
Delegate to taskAgent when:
- User asks to break down a roadmap, generate tasks, or create a task list
- Plan must be approved — if not, tell the user to approve the roadmap first

## Never do these
- Never write PRD or roadmap content yourself
- Never skip clarification when the request is genuinely ambiguous
- Never assume a phase is skipped — always check existingPrdStatus from context

## Tool usage
- Use fetchAgentContext before delegating to prdAgent (loads product context)
- Use savePRD after prdAgent completes to persist the draft`,
  requestContextSchema: z.object({
    tenantId: z.string().optional().default(''),
    agentId: z.string().optional().default(''),
    userId: z.string().optional().default(''),
  }),
  model: saarthiModel,
  memory: getMastraMemory(),
  agents: { prdAgent, roadmapAgent, taskAgent },
  workflows: { prdWorkflow },
  tools: { fetchAgentContext, savePRD },
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

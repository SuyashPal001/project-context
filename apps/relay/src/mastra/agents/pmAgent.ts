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

// Routing supervisor: classifies PM intent and extracts context (existing IDs)
// before chatStream.ts starts pmWorkflow at the appropriate entry point.
//
// Pattern: Routing Agent + Workflow (Mastra recommendation for non-deterministic
// entry points + deterministic sequential execution).
//
// pmAgent: handles "which step to start at, what context exists"
// pmWorkflow: handles "execute prd → roadmap → tasks with HITL gates"

export const pmAgent = new Agent({
  id: 'saarthi-pm',
  name: 'Saarthi PM',
  description: 'Routing supervisor: classifies PM intent and extracts workflow entry context before handing off to pmWorkflow.',
  instructions: `You are a PM routing supervisor. Classify the user's PM request and return a JSON routing decision.

Return a JSON object with exactly these fields:
- intent: "prd" | "roadmap" | "tasks"
  - "prd"     → user wants to create, draft, write, or revise a PRD / product spec / requirements document
  - "roadmap" → user wants to generate a roadmap, project plan, or milestones (often from an existing PRD)
  - "tasks"   → user wants to break down a plan or roadmap into engineering tasks
- existingPrdId: string | null — UUID if user references a specific PRD by ID (e.g. "prd abc-123", "prd id: xyz"), else null
- existingPlanId: string | null — UUID if user references a specific plan/roadmap by ID, else null

Examples:
- "create a prd for dark mode" → { "intent": "prd", "existingPrdId": null, "existingPlanId": null }
- "generate a roadmap from prd abc-123" → { "intent": "roadmap", "existingPrdId": "abc-123", "existingPlanId": null }
- "break down plan xyz-456 into tasks" → { "intent": "tasks", "existingPrdId": null, "existingPlanId": "xyz-456" }
- "create tasks for the roadmap" → { "intent": "tasks", "existingPrdId": null, "existingPlanId": null }

Return ONLY valid JSON. No markdown fences. No explanations.`,
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

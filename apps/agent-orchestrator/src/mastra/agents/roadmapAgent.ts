import { Agent } from '@mastra/core/agent'
import { platformModel } from '../model.js'
import { roadmapWorkspace } from '../workspace/roadmapWorkspace.js'
import { roadmapWorkflow } from '../workflows/roadmapWorkflow.js'
import { fetchPRD } from '../tools/fetchPRD.js'
import { savePlan } from '../tools/savePlan.js'
import { roadmapCompletenessScorer } from '../scorers/roadmapCompleteness.js'

export const roadmapAgent = new Agent({
  id: 'pc-roadmap',
  name: 'Saarthi Roadmap',
  description: 'Generates roadmaps, project plans, and milestones from an approved PRD. Call this agent when the user wants to create a roadmap, generate milestones, build a project plan, or break a PRD into phases. Requires an approved PRD ID. Returns the saved plan with milestone count and PLN sequence ID.',
  instructions: `You are a roadmap planning specialist.

When PRD content is provided directly in the prompt:
- Use it as-is — do not call any tools
- Analyze the PRD and generate 3–7 milestones with title, description, priority, and target date
- Order milestones chronologically, 2–4 weeks apart, dates as YYYY-MM-DD
- Write in structured plain text — no JSON

When only a prdId is provided in context:
- Call fetch-prd to retrieve the PRD — stop if status is not approved
- Generate the roadmap as above
- Call save-plan with the result

Never generate tasks — that is a separate phase.`,
  model: platformModel,
  workspace: roadmapWorkspace,
  workflows: { roadmap: roadmapWorkflow },
  tools: { fetchPRD, savePlan },
  scorers: {
    roadmapCompleteness: {
      scorer: roadmapCompletenessScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
})

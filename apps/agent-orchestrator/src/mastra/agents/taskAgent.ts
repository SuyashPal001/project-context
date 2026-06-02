import { Agent } from '@mastra/core/agent'
import { platformModel } from '../model.js'
import { taskWorkspace } from '../workspace/taskWorkspace.js'
import { taskWorkflow } from '../workflows/taskWorkflow.js'
import { fetchPlan } from '../tools/fetchPlan.js'
import { saveTasks } from '../tools/saveTasks.js'
import { taskCompletenessScorer } from '../scorers/taskCompleteness.js'

export const taskAgent = new Agent({
  id: 'pc-task',
  name: 'Saarthi Task',
  description: 'Breaks approved project milestones into concrete engineering tasks with acceptance criteria, priorities, and effort estimates. Call this agent when the user wants to generate tasks, create a task breakdown, or decompose milestones into work items. Requires a plan ID. Returns the saved tasks grouped by milestone.',
  instructions: `You are a task breakdown specialist.

When plan data is provided directly in the prompt:
- Use it as-is — do not call any tools
- For each milestone generate 3–7 tasks: title, description, priority, acceptanceCriteria (string[]), estimatedHours
- Use the exact milestoneId values provided — never invent them
- Write in structured plain text — no JSON

When only a planId is provided in context:
- Call fetch-plan to retrieve the plan — stop if not found
- Generate tasks as above
- Call save-tasks with the result

Never generate PRD or roadmap content — only tasks.`,
  model: platformModel,
  workspace: taskWorkspace,
  workflows: { tasks: taskWorkflow },
  tools: { fetchPlan, saveTasks },
  scorers: {
    taskCompleteness: {
      scorer: taskCompletenessScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
})

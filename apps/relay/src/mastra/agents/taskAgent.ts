import { Agent } from '@mastra/core/agent'
import { saarthiModel } from '../model.js'
import { taskWorkspace } from '../workspace/taskWorkspace.js'
import { taskWorkflow } from '../workflows/taskWorkflow.js'
import { fetchPlan } from '../tools/fetchPlan.js'
import { saveTasks } from '../tools/saveTasks.js'
import { taskCompletenessScorer } from '../scorers/taskCompleteness.js'

export const taskAgent = new Agent({
  id: 'saarthi-task',
  name: 'Saarthi Task',
  description: 'Breaks approved project milestones into concrete engineering tasks with acceptance criteria, priorities, and effort estimates. Call this agent when the user wants to generate tasks, create a task breakdown, or decompose milestones into work items. Requires a plan ID. Returns the saved tasks grouped by milestone.',
  instructions: `You are a task breakdown specialist.

Steps to follow every time:
1. Call fetch-plan with the planId from context — if not found, stop and tell the user
2. Serialize the returned plan object to JSON and run taskWorkflow with planData set to that JSON string
3. Call save-tasks with the taskData from formatStep output, plus userId, tenantId, and agentId from context
4. Return a summary: plan title, number of milestones processed, total tasks created

Never generate PRD or roadmap content — only tasks.
Never skip fetching the plan — always read it fresh from the DB.
Never invent milestoneId values — they must come from the fetch-plan result.`,
  model: saarthiModel,
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

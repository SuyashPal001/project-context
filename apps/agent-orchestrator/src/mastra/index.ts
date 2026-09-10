// Mastra proper orchestrator — ADR: Mastra Proper Orchestrator Adoption
//
// One Mastra instance registered at startup.
// One platform-level Agent (olmo) serving all tenants.
// Per-tenant isolation via RequestContext + MASTRA_RESOURCE_ID_KEY.
//
// Backward-compat re-exports let app.ts and workflow.ts import unchanged.

import { Mastra } from '@mastra/core/mastra'
import { MastraEditor } from '@mastra/editor'
import { Observability, DefaultExporter } from '@mastra/observability'

import { getMastraStore, getMastraMemory } from './memory.js'
import { taskExecutionWorkflow } from './workflows/taskExecution.js'
import { documentWorkflow } from './workflows/documentWorkflow.js'
import { ingestionWorkflow } from './workflows/ingestionWorkflow.js'

import { prdWorkflow } from './workflows/prdWorkflow.js'
import { dodPassScorer } from './workflows/scorers.js'
import { prdCompletenessScorer } from './scorers/prdCompleteness.js'
import { delegationAccuracyScorer } from './scorers/delegationAccuracy.js'
import { clarityBeforeDelegateScorer } from './scorers/clarityBeforeDelegate.js'
import { roadmapCompletenessScorer } from './scorers/roadmapCompleteness.js'
import { taskCompletenessScorer } from './scorers/taskCompleteness.js'

import { z } from 'zod'

import { platformAgent, SERVER_TOOLS } from './agents/platformAgent.js'
import { formatterAgent } from './agents/formatterAgent.js'
import { prdAgent } from './agents/prdAgent.js'
import { pmAgent } from './agents/pmAgent.js'
import { roadmapAgent } from './agents/roadmapAgent.js'
import { taskAgent } from './agents/taskAgent.js'
import { architectAgent } from './agents/architectAgent.js'

import { roadmapWorkflow } from './workflows/roadmapWorkflow.js'
import { taskWorkflow } from './workflows/taskWorkflow.js'
import { pmWorkflow } from './workflows/pmWorkflow.js'
import { taskExecutionPlanWorkflow } from './workflows/taskExecutionPlanWorkflow.js'
import { prdWorkspace } from './workspace/prdWorkspace.js'

// ---------------------------------------------------------------------------
// WorkflowContext — used by task execution route to type the workflow context.
// Previously defined in workflow.ts; moved here as runMastraWorkflow is deleted.
// ---------------------------------------------------------------------------

const StepOutputSchema = z.object({
  stepId: z.string(),
  status: z.enum(['done', 'needs_clarification', 'failed']),
  summary: z.string(),
  reasoning: z.string().optional(),
  question: z.string().optional(),
  toolCalled: z.string().optional(),
  toolResult: z.unknown().optional(),
  latencyMs: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
})

export interface WorkflowContext {
  taskId: string
  tenantId: string
  agentId: string
  agentSlug: string
  instructions: string
  taskTitle: string
  taskDescription?: string
  steps: Array<{
    id: string
    stepNumber: number
    title: string
    description?: string
    toolName?: string
  }>
  connectedProviders: string[]    // tenant's active integration providers
  enabledTools: string[] | null   // from agent_skills.tools — gates server tools (null = all)
  highStakeTools: string[]        // tool names that are high or critical stakes
  requiresApprovalTools: string[] // tool names that need human approval before use
  blockedTools: string[]          // from policy — always blocked
  allowedTools: string[]          // from policy — if non-empty, only these are permitted
  maxTokensPerMessage: number | null
  attachmentContext?: string | null  // extracted text from task attachments
  acceptanceCriteria?: string | null // definition of done — injected into every step prompt
  referenceText?: string             // user-provided background text
  links?: string[]                   // URLs the user attached to the task
  // Callbacks to report progress to Lambda API
  // These are the existing internal endpoints
  onStepStart: (stepId: string) => Promise<void>
  onStepComplete: (
    stepId: string,
    output: z.infer<typeof StepOutputSchema>
  ) => Promise<void>
  onStepFail: (
    stepId: string,
    error: string
  ) => Promise<void>
  onTaskComment: (
    comment: string
  ) => Promise<void>
}

// ---------------------------------------------------------------------------
// Mastra instance — registered at startup with storage and platformAgent.
// Enables Mastra Studio, OTel spans, evals, and prompt versioning.
// ---------------------------------------------------------------------------

export const mastra = new Mastra({
  agents: {
    olmo: platformAgent,
    architect: architectAgent,
    formatter: formatterAgent,
    prd: prdAgent,
    pm: pmAgent, // Routing supervisor — classifies intent before pmWorkflow starts
    roadmap: roadmapAgent,
    task: taskAgent,

  },
  workflows: {
    taskExecution: taskExecutionWorkflow,
    documentWorkflow,
    documentIngestion: ingestionWorkflow,

    prd: prdWorkflow,
    roadmap: roadmapWorkflow,
    tasks: taskWorkflow,
    'pm-workflow': pmWorkflow, // Primary PM orchestration flow (workflow-first architecture)
    'task-execution-plan': taskExecutionPlanWorkflow,
  },
  storage: getMastraStore(),
  scheduler: {
    enabled: true,
    tickIntervalMs: 30_000, // check every 30s
  },
  scorers: {
    dodPass: dodPassScorer,
    prdCompleteness: prdCompletenessScorer,
    delegationAccuracy: delegationAccuracyScorer,
    clarityBeforeDelegate: clarityBeforeDelegateScorer,
    roadmapCompleteness: roadmapCompletenessScorer,
    taskCompleteness: taskCompletenessScorer,

  },
  editor: new MastraEditor(),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'project-context-agent-orchestrator',
        exporters: [new DefaultExporter()],
      },
    },
  }),
})

// ---------------------------------------------------------------------------
// Re-exports — all consumers import from this file unchanged.
// ---------------------------------------------------------------------------

export { platformModel } from './model.js'
export { platformAgent, SERVER_TOOLS }
export { formatterAgent }
export { prdAgent }
export { pmAgent }
export { prdWorkspace } from './workspace/prdWorkspace.js'
export { getMastraStore, getMastraMemory } from './memory.js'
export { getMCPClientForTenant, getToolsForTenant } from './tools.js'
export { createTenantAgent } from './agent.js'
export type { TenantAgentWithClient } from './agent.js'
export { taskExecutionWorkflow } from './workflows/taskExecution.js'
export { documentWorkflow } from './workflows/documentWorkflow.js'
export { prdWorkflow } from './workflows/prdWorkflow.js'

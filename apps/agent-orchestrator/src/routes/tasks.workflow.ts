import { INTERNAL_SERVICE_KEY, INTERNAL_API_URL } from '../types.js'
import type { WorkflowStep } from '../types.js'
import { fetchAgentSkill, fetchConnectedProviders, fetchToolGovernance, fetchAgentPolicy } from '../usage.js'
import { runMastraWorkflow } from '../mastra/index.js'
import type { WorkflowContext } from '../mastra/index.js'

export async function runMastraWorkflowSteps(
  workflowId: string,
  workflowRunId: string,
  agentId: string,
  tenantId: string,
  steps: WorkflowStep[],
  systemPrompt: string | null,
  requiresApproval: boolean,
  traceId: string = crypto.randomUUID()
): Promise<void> {
  const skill = await fetchAgentSkill(agentId)
  const instructions = systemPrompt ?? skill?.systemPrompt ?? 'You are a helpful AI assistant.'
  const connectedProviders = await fetchConnectedProviders(tenantId)
  const toolGovernance = await fetchToolGovernance(agentId, tenantId, connectedProviders)
  const policy = await fetchAgentPolicy(agentId, tenantId)

  const mergedRequiresApproval = [
    ...new Set([
      ...toolGovernance.requiresApprovalTools,
      ...policy.requiresApproval,
      ...(requiresApproval ? ['*'] : []),
    ])
  ]

  const wfStepsCompleted: unknown[] = []
  const wfToolsCalled: unknown[] = []

  const ctx: WorkflowContext = {
    taskId: workflowRunId, tenantId, agentId, agentSlug: agentId, instructions,
    taskTitle: `Workflow ${workflowId}`, taskDescription: undefined,
    steps: steps.map((s, i) => ({
      id: s.id ?? `step-${i}`, stepNumber: s.stepNumber ?? i + 1,
      title: s.title, description: s.description, toolName: s.toolName,
    })),
    connectedProviders, enabledTools: skill?.tools ?? null,
    highStakeTools: toolGovernance.highStakeTools, requiresApprovalTools: mergedRequiresApproval,
    blockedTools: policy.blockedActions, allowedTools: policy.allowedActions,
    maxTokensPerMessage: policy.maxTokensPerMessage,
    onStepStart: async (_stepId) => { /* workflow steps have no separate start endpoint */ },
    onStepComplete: async (stepId, output) => {
      wfStepsCompleted.push({
        stepId,
        title: steps.find((s: WorkflowStep) => s.id === stepId)?.title ?? stepId,
        status: output.status, summary: output.summary,
        toolCalled: output.toolCalled ?? null, completedAt: new Date().toISOString(),
      })
      if (output.toolCalled) {
        wfToolsCalled.push({ tool: output.toolCalled, result: output.toolResult ?? null })
      }
      console.log(JSON.stringify({ level: 'info', msg: 'workflow step complete', traceId, workflowRunId, stepId, status: output.status, ts: Date.now() }))
    },
    onStepFail: async (stepId, error) => {
      wfStepsCompleted.push({ stepId, status: 'failed', error, completedAt: new Date().toISOString() })
      await fetch(`${INTERNAL_API_URL}/internal/workflows/${workflowRunId}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-service-key': INTERNAL_SERVICE_KEY,
          'x-trace-id': traceId,
        },
        body: JSON.stringify({
          status: 'failed', stepsCompleted: wfStepsCompleted,
          toolsCalled: wfToolsCalled, completedAt: new Date().toISOString(),
        }),
      }).catch((e: Error) => console.error('[workflow] update failed:', e.message))
      console.error(JSON.stringify({ level: 'error', msg: 'workflow step failed', traceId, workflowRunId, stepId, error, ts: Date.now() }))
    },
    onTaskComment: async (comment) => {
      console.log(`[workflows] workflowRunId=${workflowRunId} comment: ${comment}`)
    },
  }

  await runMastraWorkflow(ctx)

  await fetch(`${INTERNAL_API_URL}/internal/workflows/${workflowRunId}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service-key': INTERNAL_SERVICE_KEY,
      'x-trace-id': traceId,
    },
    body: JSON.stringify({
      status: 'completed', stepsCompleted: wfStepsCompleted, toolsCalled: wfToolsCalled,
      insights: (wfStepsCompleted as Array<{ summary?: string }>)
        .map(s => s.summary).filter(Boolean).join('\n'),
      completedAt: new Date().toISOString(),
    }),
  }).catch((e: Error) => console.error('[workflow] update failed:', e.message))
}

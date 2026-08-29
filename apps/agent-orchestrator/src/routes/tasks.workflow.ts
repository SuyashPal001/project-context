import { INTERNAL_SERVICE_KEY, INTERNAL_API_URL } from '../types.js'
import type { WorkflowStep } from '../types.js'
import { fetchAgentSkill, fetchConnectedProviders, fetchToolGovernance, fetchAgentPolicy } from '../usage.js'
import { refundTask, settleTask, DEFAULT_TASK_MODEL } from '../credits.js'
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
  traceId: string = crypto.randomUUID(),
  // The model the estimate was priced at, threaded from the route so the
  // settle below reconciles against the same one. Only a FALLBACK inside
  // settleTask — it prices actual usage from the rate stored on the original
  // charge's ledger rows, and reaches for this only if that charge landed
  // unmetered.
  model: string = DEFAULT_TASK_MODEL,
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
  // Real token totals for the settle below. runMastraWorkflow already reports
  // per-step usage on the onStepComplete payload (it sums the two generate
  // passes) — this flow simply never read it, so a SUCCESSFUL workflow stayed
  // charged at the up-front estimate forever while an equivalent task run got
  // reconciled to what it actually cost.
  let wfInputTokens = 0
  let wfOutputTokens = 0
  // A failed step is this flow's only terminal-failure signal, so it is also
  // the only place the charge can be refunded.
  let hadFailure = false

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
      wfInputTokens += output.inputTokens ?? 0
      wfOutputTokens += output.outputTokens ?? 0
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
      hadFailure = true
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

  if (hadFailure) {
    // onStepFail already posted the 'failed' status update per-step; refund
    // the estimate charged at submit time so a failed workflow run doesn't
    // leave the tenant charged for work that didn't land. Skip the
    // 'completed' update below — it would otherwise overwrite the 'failed'
    // status onStepFail already reported.
    await refundTask({ tenantId, taskId: workflowRunId })
    return
  }

  // The run succeeded, so reconcile the up-front estimate against what it
  // actually cost — the same treatment runMastraTaskSteps gives a task.
  // Defaults for chargeKey and key are `task:{workflowRunId}` and
  // `task:{workflowRunId}:settle`, which is exactly what the estimate at
  // /api/workflows/execute was charged under.
  //
  // Awaited, not fire-and-forget: nothing races it here, and letting it finish
  // before the 'completed' status update means a workflow reported complete has
  // already had its price fixed.
  await settleTask({
    tenantId, taskId: workflowRunId, agentId, model,
    inputTokens: wfInputTokens, outputTokens: wfOutputTokens,
  })

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

import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context'
import { INTERNAL_SERVICE_KEY, INTERNAL_API_URL } from '../types.js'
import type { WorkflowStep } from '../types.js'
import { fetchConnectedProviders, fetchToolGovernance, fetchAgentPolicy } from '../usage.js'
import { refundTask, settleTask, DEFAULT_TASK_MODEL } from '../credits.js'
import { mastra } from '../mastra/index.js'
import type { TenantContext } from '../mastra/context.js'

// Shape of a completed `task-execution-plan` run's `result.result` — shared
// between the initial run.start() success path here and the resume route's
// run.resume() success path (routes/tasks.ts) so both call
// finishSuccessfulWorkflowRun with the same typed shape instead of an `as never` cast.
export type WorkflowStepOutputs = Array<{
  stepId: string; status: string; summary: string
  toolCalled?: string; toolResult?: unknown
  inputTokens?: number; outputTokens?: number
}>

export async function postWorkflowUpdate(
  workflowRunId: string,
  body: Record<string, unknown>,
  traceId: string,
): Promise<void> {
  await fetch(`${INTERNAL_API_URL}/internal/workflows/${workflowRunId}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-service-key': INTERNAL_SERVICE_KEY,
      'x-trace-id': traceId,
    },
    body: JSON.stringify(body),
  }).catch((e: Error) => console.error('[workflow] update failed:', e.message))
}

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
  const instructions = systemPrompt ?? 'You are a helpful AI assistant.'
  const connectedProviders = await fetchConnectedProviders(tenantId)
  const toolGovernance = await fetchToolGovernance(agentId, tenantId, connectedProviders)
  const policy = await fetchAgentPolicy(agentId, tenantId)

  const mergedRequiresApproval = [
    ...new Set([
      ...toolGovernance.requiresApprovalTools,
      ...policy.requiresApproval,
      ...(requiresApproval ? ['*'] : []),
    ]),
  ]

  // Typed explicitly as TenantContext (not the bare `new RequestContext()`
  // used elsewhere in this codebase): taskExecutionPlanWorkflow declares
  // `requestContextSchema: tenantContextSchema`, and its `.map().foreach()`
  // chain (unlike pmWorkflow's more elaborate chain, which loses the type
  // param) actually propagates that schema type to `run.start()`'s
  // `requestContext` parameter, so a `RequestContext<unknown>` fails to
  // typecheck against it. MASTRA_RESOURCE_ID_KEY is a reserved
  // middleware-only key outside the declared schema, so it goes through
  // `setRaw` rather than the schema-checked `set`.
  const requestContext = new RequestContext<TenantContext>()
  requestContext.setRaw(MASTRA_RESOURCE_ID_KEY, tenantId)
  requestContext.set('tenantId', tenantId)
  requestContext.set('agentId', agentId)

  const workflow = mastra.getWorkflow('task-execution-plan')
  const run = await workflow.createRun({ resourceId: tenantId })

  await postWorkflowUpdate(workflowRunId, { mastraRunId: run.runId, status: 'running' }, traceId)

  const result = await run.start({
    inputData: {
      taskId: workflowRunId,
      taskTitle: `Workflow ${workflowId}`,
      instructions,
      steps: steps.map((s, i) => ({
        stepId: s.id ?? `step-${i}`, stepNumber: s.stepNumber ?? i + 1,
        title: s.title, description: s.description, toolName: s.toolName,
      })),
      highStakeTools: toolGovernance.highStakeTools,
      requiresApprovalTools: mergedRequiresApproval,
      blockedTools: policy.blockedActions,
      allowedTools: policy.allowedActions,
      maxTokensPerMessage: policy.maxTokensPerMessage,
      attachmentContext: null,
      acceptanceCriteria: null,
    },
    requestContext,
  })

  if (result.status === 'suspended') {
    await postWorkflowUpdate(workflowRunId, { status: 'awaiting_approval' }, traceId)
    console.log(JSON.stringify({ level: 'info', msg: 'workflow suspended for approval', traceId, workflowRunId, mastraRunId: run.runId, ts: Date.now() }))
    return
  }

  if (result.status !== 'success') {
    // Covers 'failed' plus the 'tripwire'/'paused' states the plan-workflow
    // never intentionally produces (no output processors, no manual pause
    // call) — treated the same as a failure so a stuck run still refunds
    // and reports instead of falling through silently.
    await refundTask({ tenantId, taskId: workflowRunId })
    const errorMessage = result.status === 'failed' ? result.error.message : `workflow ended with status '${result.status}'`
    await postWorkflowUpdate(workflowRunId, {
      status: 'failed', completedAt: new Date().toISOString(),
    }, traceId)
    console.error(JSON.stringify({ level: 'error', msg: 'workflow failed', traceId, workflowRunId, error: errorMessage, ts: Date.now() }))
    return
  }

  // status === 'success' — same completion accounting as the resume route
  // (routes/tasks.ts's POST /api/workflows/:workflowRunId/resume), shared
  // here rather than duplicated.
  const stepOutputs = result.result as WorkflowStepOutputs
  await finishSuccessfulWorkflowRun(workflowRunId, tenantId, stepOutputs, traceId, agentId, model)
}

/**
 * Shared success-path accounting for a completed `task-execution-plan` run —
 * settle (or refund on a per-step failure) plus the `postWorkflowUpdate` that
 * marks the workflow run terminal. Called both from `runMastraWorkflowSteps`
 * above (the initial `run.start()` path) and from the resume route
 * (`routes/tasks.ts`'s `POST /api/workflows/:workflowRunId/resume`, the
 * `run.resume()` path) so the two don't drift.
 */
export async function finishSuccessfulWorkflowRun(
  workflowRunId: string,
  tenantId: string,
  stepOutputs: WorkflowStepOutputs,
  traceId: string,
  agentId: string,
  model: string,
): Promise<void> {
  const hadFailure = stepOutputs.some((s) => s.status === 'failed')
  const wfInputTokens = stepOutputs.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0)
  const wfOutputTokens = stepOutputs.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0)
  const wfStepsCompleted = stepOutputs.map((s) => ({
    stepId: s.stepId, title: s.stepId, status: s.status, summary: s.summary,
    toolCalled: s.toolCalled ?? null, completedAt: new Date().toISOString(),
  }))
  const wfToolsCalled = stepOutputs
    .filter((s) => s.toolCalled)
    .map((s) => ({ tool: s.toolCalled, result: s.toolResult ?? null }))

  if (hadFailure) {
    await refundTask({ tenantId, taskId: workflowRunId })
    await postWorkflowUpdate(workflowRunId, {
      status: 'failed', stepsCompleted: wfStepsCompleted, toolsCalled: wfToolsCalled,
      completedAt: new Date().toISOString(),
    }, traceId)
    return
  }

  await settleTask({
    tenantId, taskId: workflowRunId, agentId, model,
    inputTokens: wfInputTokens, outputTokens: wfOutputTokens,
  })

  await postWorkflowUpdate(workflowRunId, {
    status: 'completed', stepsCompleted: wfStepsCompleted, toolsCalled: wfToolsCalled,
    insights: wfStepsCompleted.map((s) => s.summary).filter(Boolean).join('\n'),
    completedAt: new Date().toISOString(),
  }, traceId)
}

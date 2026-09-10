import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context'
import { INTERNAL_SERVICE_KEY, INTERNAL_API_URL } from '../types.js'
import type { WorkflowStep } from '../types.js'
import { fetchConnectedProviders, fetchToolGovernance, fetchAgentPolicy, fetchAgentModelSelection } from '../usage.js'
import { refundTask, settleTask, DEFAULT_TASK_MODEL } from '../credits.js'
import { mastra } from '../mastra/index.js'
import type { TenantContext } from '../mastra/context.js'
import { approvalResumeLabel } from '../mastra/workflows/taskExecutionPlanWorkflow.js'

// Shape of a completed `task-execution-plan` run's `result.result` — shared
// between the initial run.start() success path here and the resume route's
// run.resume() success path (routes/tasks.ts) so both call
// finishSuccessfulWorkflowRun with the same typed shape instead of an `as never` cast.
export type WorkflowStepOutputs = Array<{
  stepId: string; title?: string; status: string; summary: string
  toolCalled?: string; toolResult?: unknown
  inputTokens?: number; outputTokens?: number
}>

export async function postWorkflowUpdate(
  workflowRunId: string,
  body: Record<string, unknown>,
  traceId: string,
): Promise<void> {
  try {
    const res = await fetch(`${INTERNAL_API_URL}/internal/workflows/${workflowRunId}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': INTERNAL_SERVICE_KEY,
        'x-trace-id': traceId,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[workflow] update rejected ${res.status}: ${text}`, { workflowRunId, body })
    }
  } catch (e) {
    console.error('[workflow] update failed:', (e as Error).message)
  }
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
    const payload = (result.suspendPayload as Record<string, { stepId: string; title: string; toolName: string; reason: 'requires_approval' }> | undefined)?.['run-plan-step']
    if (!payload) {
      // Should be unreachable — runPlanStep is the workflow's only step, and
      // a 'suspended' result always carries this step's payload. Logged
      // rather than thrown so a Mastra internals change surfaces here
      // instead of crashing the caller silently. Since there's no usable
      // descriptor, this row can never be approved and would otherwise sit
      // forever unrefunded (the watchdog sweep skips rows with no
      // resumeLabel) — treat it as a failure instead.
      console.error(JSON.stringify({ level: 'error', msg: 'suspended result missing run-plan-step payload', traceId, workflowRunId, ts: Date.now() }))
      await refundTask({ tenantId, taskId: workflowRunId })
      await postWorkflowUpdate(workflowRunId, {
        status: 'failed', pendingApproval: null, pendingApprovalAt: null, completedAt: new Date().toISOString(),
      }, traceId)
      return
    }
    await postWorkflowUpdate(workflowRunId, {
      status: 'awaiting_approval',
      tenantId,
      pendingApproval: {
        stepId: payload.stepId, title: payload.title, toolName: payload.toolName, reason: payload.reason,
        resumeLabel: approvalResumeLabel(payload.stepId),
      },
      pendingApprovalAt: new Date().toISOString(),
    }, traceId)
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
    stepId: s.stepId, title: s.title ?? s.stepId, status: s.status, summary: s.summary,
    toolCalled: s.toolCalled ?? null, completedAt: new Date().toISOString(),
  }))
  const wfToolsCalled = stepOutputs
    .filter((s) => s.toolCalled)
    .map((s) => ({ tool: s.toolCalled, result: s.toolResult ?? null }))

  if (hadFailure) {
    await refundTask({ tenantId, taskId: workflowRunId })
    await postWorkflowUpdate(workflowRunId, {
      status: 'failed', stepsCompleted: wfStepsCompleted, toolsCalled: wfToolsCalled,
      pendingApproval: null, pendingApprovalAt: null,
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
    pendingApproval: null, pendingApprovalAt: null,
    completedAt: new Date().toISOString(),
  }, traceId)
}

/**
 * Shared resume-outcome handling for a suspended `task-execution-plan` run —
 * the 3-way branch (re-suspended / failed-or-other / success) that follows a
 * `run.resume()` call. Dispatched fire-and-forget by the resume route
 * (`routes/tasks.ts`'s `POST /api/workflows/:workflowRunId/resume`, which
 * returns its own HTTP 202 before this settles) and, later, by the watchdog
 * sweep for stale `awaiting_approval` runs — both need the identical
 * suspended/failed/success handling, so it lives here rather than being
 * duplicated.
 */
export async function resumeWorkflowRun(args: {
  workflowRunId: string
  tenantId: string
  agentId: string
  mastraRunId: string
  resumeLabel: string
  approved: boolean
  traceId: string
}): Promise<void> {
  const { workflowRunId, tenantId, agentId, mastraRunId, resumeLabel, approved, traceId } = args
  const requestContext = new RequestContext<TenantContext>()
  requestContext.setRaw(MASTRA_RESOURCE_ID_KEY, tenantId)
  requestContext.set('tenantId', tenantId)
  requestContext.set('agentId', agentId)

  try {
    const workflow = mastra.getWorkflow('task-execution-plan')
    const run = await workflow.createRun({ runId: mastraRunId })
    const result = await run.resume({ label: resumeLabel, resumeData: { approved }, requestContext })

    if (result.status === 'suspended') {
      // A LATER step in the same run also requires approval — write the NEW
      // descriptor. Do not clear pending_approval here: that would make
      // this second approval unreachable, the exact defect class this plan
      // exists to fix.
      const payload = (result.suspendPayload as Record<string, { stepId: string; title: string; toolName: string; reason: 'requires_approval' }> | undefined)?.['run-plan-step']
      await postWorkflowUpdate(workflowRunId, {
        status: 'awaiting_approval',
        tenantId,
        pendingApproval: payload ? {
          stepId: payload.stepId, title: payload.title, toolName: payload.toolName, reason: payload.reason,
          resumeLabel: approvalResumeLabel(payload.stepId),
        } : null,
        pendingApprovalAt: new Date().toISOString(),
      }, traceId)
      return
    }
    if (result.status !== 'success') {
      await refundTask({ tenantId, taskId: workflowRunId })
      await postWorkflowUpdate(workflowRunId, {
        status: 'failed', pendingApproval: null, pendingApprovalAt: null, completedAt: new Date().toISOString(),
      }, traceId)
      const errorMessage = result.status === 'failed' ? result.error.message : `workflow ended with status '${result.status}'`
      console.error(JSON.stringify({ level: 'error', msg: 'workflow resume failed', traceId, workflowRunId, error: errorMessage, ts: Date.now() }))
      return
    }

    const modelSelection = await fetchAgentModelSelection(agentId)
    const model = modelSelection?.model ?? DEFAULT_TASK_MODEL
    await finishSuccessfulWorkflowRun(workflowRunId, tenantId, result.result as WorkflowStepOutputs, traceId, agentId, model)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Mastra's own compare-and-set throws a distinct error when a second
    // resume races this one and loses — surfaced only as a log, since
    // whichever caller (the route or the watchdog sweep) dispatched this
    // already returned its own response before this catch can run.
    console.error(JSON.stringify({ level: 'error', msg: 'workflow resume threw', traceId, workflowRunId, error: message, ts: Date.now() }))
    // This function runs detached/fire-and-forget — nobody else will retry
    // it, so a thrown run.resume() (bad label, Mastra claim conflict,
    // network error to Mastra's storage, etc.) must not leave the row stuck
    // at status='running' forever. Take a terminal recovery action instead.
    try {
      await postWorkflowUpdate(workflowRunId, { status: 'failed', pendingApproval: null, pendingApprovalAt: null, completedAt: new Date().toISOString() }, traceId)
      await refundTask({ tenantId, taskId: workflowRunId })
    } catch (cleanupErr) {
      console.error(JSON.stringify({ level: 'error', msg: 'resumeWorkflowRun cleanup after throw also failed', traceId, workflowRunId, error: (cleanupErr as Error).message, ts: Date.now() }))
    }
  }
}

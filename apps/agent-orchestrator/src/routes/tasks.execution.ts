import { InsufficientCreditsError } from '@serverless-saas/credits'
import type { TaskStep } from '../types.js'
import {
  fetchAgentSkill, fetchAgentModelSelection,
  fetchConnectedProviders, fetchToolGovernance, fetchAgentPolicy, recordUsage,
} from '../usage.js'
import { estimateTaskMicro, chargeTaskEstimate, resolveTaskRate, settleTask, refundTask, DEFAULT_TASK_MODEL } from '../credits.js'
import { taskExecutionWorkflow, documentWorkflow } from '../mastra/index.js'
import type { WorkflowContext } from '../mastra/index.js'
import { callInternalTaskApi, postTaskEval, logToolCall, postTaskComment } from './tasks.helpers.js'

export type PlanResult = {
  summary: string
  dodPassed: boolean
  prdData: object
}

export async function runMastraTaskSteps(
  taskId: string,
  agentId: string,
  tenantId: string,
  steps: TaskStep[],
  taskTitle: string,
  taskDescription: string,
  agentName: string,
  referenceText?: string | null,
  links?: string[] | null,
  attachmentContext?: string | null,
  acceptanceCriteria?: string | null,
  traceId: string = crypto.randomUUID()
): Promise<{ planResult?: PlanResult }> {
  // Charging IS the balance check (see credits.ts) — do not add a separate
  // checkCreditBalance pre-check in front of this. Idempotent by
  // `task:{taskId}`: the route handler that dispatches to runMastraTaskSteps
  // already charged this same estimate before calling in, so this call
  // safely replays rather than double-charging.
  const modelSelection = await fetchAgentModelSelection(agentId)
  const model = modelSelection?.model ?? DEFAULT_TASK_MODEL
  const estimateMicro = await estimateTaskMicro(steps.length, model)
  try {
    const rate = await resolveTaskRate(model)
    await chargeTaskEstimate({
      tenantId, taskId, agentId, estimateMicro,
      rateId: rate?.id ?? null, rateVersion: rate?.version ?? null,
    })
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      console.warn(`[mastra] tenantId=${tenantId} taskId=${taskId} insufficient credits for estimate=${estimateMicro}`)
      await postTaskComment(taskId, `❌ Insufficient credits to run this task. Add credits to continue.`, agentId)
      await callInternalTaskApi(`/internal/tasks/${taskId}/fail`, { error: 'Insufficient credits' }, traceId)
      return {}
    }
    throw err
  }

  const skill = await fetchAgentSkill(agentId)
  const instructions = skill?.systemPrompt ?? `You are ${agentName}, a helpful AI assistant.`
  const connectedProviders = await fetchConnectedProviders(tenantId)
  const toolGovernance = await fetchToolGovernance(agentId, tenantId, connectedProviders)
  const policy = await fetchAgentPolicy(agentId, tenantId)
  const mergedRequiresApproval = [...new Set([...toolGovernance.requiresApprovalTools, ...policy.requiresApproval])]

  let earlyTermination = false
  const stepOutputs: string[] = []
  let totalInputTokens = 0
  let totalOutputTokens = 0

  const ctx: WorkflowContext = {
    taskId, tenantId, agentId, agentSlug: agentId, instructions, taskTitle, taskDescription,
    steps: steps.map(s => ({ id: s.id, stepNumber: s.stepOrder, title: s.title, description: s.description, toolName: s.toolName })),
    connectedProviders, enabledTools: skill?.tools ?? null,
    highStakeTools: toolGovernance.highStakeTools, requiresApprovalTools: mergedRequiresApproval,
    blockedTools: policy.blockedActions, allowedTools: policy.allowedActions,
    maxTokensPerMessage: policy.maxTokensPerMessage,
    attachmentContext: attachmentContext ?? null, acceptanceCriteria: acceptanceCriteria ?? null,
    referenceText: referenceText ?? undefined, links: links ?? undefined,
    onStepStart: async (stepId) => {
      await callInternalTaskApi(`/internal/tasks/${taskId}/steps/${stepId}/start`, {}, traceId)
    },
    onStepComplete: async (stepId, output) => {
      stepOutputs.push(output.summary)
      const raw = output.toolResult
      const toolResult = raw == null ? undefined
        : typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown>
        : { result: raw }
      await callInternalTaskApi(`/internal/tasks/${taskId}/steps/${stepId}/complete`, {
        agentOutput: output.summary, summary: output.summary,
        reasoning: output.reasoning ?? undefined, actualToolUsed: output.toolCalled ?? undefined,
        ...(toolResult !== undefined && { toolResult }),
      }, traceId)
      if (output.toolCalled) {
        await logToolCall({ tenantId, toolName: output.toolCalled, success: output.status === 'done',
          latencyMs: output.latencyMs, taskId, args: toolResult })
      }
      totalInputTokens += output.inputTokens ?? 0
      totalOutputTokens += output.outputTokens ?? 0
    },
    onStepFail: async (stepId, error) => {
      earlyTermination = true
      await postTaskComment(taskId, `❌ Step failed: ${error}`, agentId)
      await callInternalTaskApi(`/internal/tasks/${taskId}/steps/${stepId}/fail`, { error }, traceId)
      const failedStep = steps.find(s => s.id === stepId)
      if (failedStep?.toolName) {
        await logToolCall({ tenantId, toolName: failedStep.toolName, success: false, errorMessage: error, taskId })
      }
    },
    onTaskComment: async (comment) => {
      earlyTermination = true
      await postTaskComment(taskId, comment, agentId)
      await callInternalTaskApi(`/internal/tasks/${taskId}/clarify`, { questions: [comment] }, traceId)
    },
  }

  // ─── Document workflow branch — PRD attached, no links ────────────────────
  const isDocWorkflow = !!(attachmentContext) && (!links || links.length === 0)

  if (isDocWorkflow) {
    let docPlanResult: PlanResult | undefined
    try {
      const docRun = await documentWorkflow.createRun()
      const docResult = await docRun.start({
        inputData: {
          taskTitle,
          taskDescription: taskDescription ?? undefined,
          attachmentContext: attachmentContext!,
          tenantId,
          autoApprove: true,
        },
      })
      if (docResult.status === 'success') {
        totalInputTokens = docResult.result?.inputTokens ?? 0
        totalOutputTokens = docResult.result?.outputTokens ?? 0
        console.log(`[mastra/doc] tenantId=${tenantId} taskId=${taskId} tokens in=${totalInputTokens} out=${totalOutputTokens}`)
        const docMsgs = [
          'Analyzing PRD and planning milestones...',
          'Extracting tasks and acceptance criteria...',
          'Verifying completeness and composing plan...',
        ]
        for (let i = 0; i < ctx.steps.length - 1; i++) {
          await ctx.onStepComplete(ctx.steps[i].id, {
            stepId: ctx.steps[i].id, summary: docMsgs[i] ?? `Step ${i + 1} completed`,
            status: 'done', reasoning: '', toolCalled: '', toolResult: '',
          })
        }
        const lastStep = ctx.steps[ctx.steps.length - 1]
        await ctx.onStepComplete(lastStep.id, {
          stepId: lastStep.id, summary: docResult.result?.summary ?? '',
          status: 'done', reasoning: '', toolCalled: '', toolResult: '',
        })
        docPlanResult = {
          summary: docResult.result?.summary ?? '',
          dodPassed: docResult.result?.dodPassed ?? false,
          prdData: docResult.result?.prdData ?? {},
        }
      } else {
        earlyTermination = true
        const errMsg = (docResult as unknown as { error?: { message?: string } }).error?.message ?? 'Document workflow failed'
        for (const step of ctx.steps) { await ctx.onStepFail(step.id, errMsg) }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[mastra/doc] tenantId=${tenantId} taskId=${taskId} error:`, message)
      await postTaskComment(taskId, `❌ Task failed: ${message}`, agentId)
      await callInternalTaskApi(`/internal/tasks/${taskId}/fail`, { error: message }, traceId)
      await refundTask({ tenantId, taskId })
      return {}
    }
    if (!earlyTermination) {
      await postTaskComment(taskId, `✅ All steps completed.`, agentId)
      await callInternalTaskApi(`/internal/tasks/${taskId}/complete`, { summary: 'All steps completed successfully.' }, traceId)
      recordUsage({ tenantId, actorId: agentId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
      void settleTask({ tenantId, taskId, agentId, model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
    } else {
      // A workflow returning `status !== 'success'` (the ordinary failure
      // shape) sets earlyTermination but throws nothing, so it never reaches
      // either catch block below. Without this, the estimate charged at :42
      // stands forever for work that never landed. refundTask is safe to
      // call unconditionally: it no-ops for unlimited tenants, no-ops if a
      // settle already ran for this task, and no-ops if net >= 0 (nothing
      // was ever charged) — see tasks.workflow.ts for the same pattern.
      await refundTask({ tenantId, taskId })
    }
    return { planResult: docPlanResult }
  }

  // ─── Task execution workflow ───────────────────────────────────────────────
  try {
    const run = await taskExecutionWorkflow.createRun()
    await callInternalTaskApi(`/internal/tasks/${taskId}/mastra-run`, { mastraRunId: run.runId }, traceId)
    for (const step of ctx.steps) { await ctx.onStepStart(step.id) }

    const result = await run.start({
      inputData: {
        taskTitle: ctx.taskTitle, taskDescription: ctx.taskDescription ?? '',
        acceptanceCriteria: ctx.acceptanceCriteria ?? '', tenantId: ctx.tenantId,
        attachmentContext: ctx.attachmentContext ?? '', referenceText: ctx.referenceText ?? '',
        links: ctx.links ?? [],
      },
    })

    if ((result as unknown as { status: string }).status === 'suspended') {
      console.log(`[mastra] tenantId=${tenantId} taskId=${taskId} workflow suspended — awaiting approval`)
      await callInternalTaskApi(`/internal/tasks/${taskId}/suspend`, {}, traceId)
      return {}
    }

    if (result.status === 'success') {
      const stepMessages = [
        'Analyzing task and generating search strategy...',
        'Searching across multiple sources in parallel...',
        'Merging and deduplicating results...',
      ]
      for (let i = 0; i < ctx.steps.length - 1; i++) {
        await ctx.onStepComplete(ctx.steps[i].id, {
          stepId: ctx.steps[i].id, summary: stepMessages[i] ?? `Step ${i + 1} completed`,
          status: 'done', reasoning: '', toolCalled: '', toolResult: '',
        })
      }
      totalInputTokens = result.result?.inputTokens ?? 0
      totalOutputTokens = result.result?.outputTokens ?? 0
      console.log(`[mastra] tenantId=${tenantId} taskId=${taskId} tokens in=${totalInputTokens} out=${totalOutputTokens}`)
      const lastStep = ctx.steps[ctx.steps.length - 1]
      await ctx.onStepComplete(lastStep.id, {
        stepId: lastStep.id, summary: result.result?.summary ?? '',
        status: result.result?.status ?? 'done', reasoning: result.result?.reasoning ?? '',
        toolCalled: 'internet_search', toolResult: '',
      })
    } else {
      earlyTermination = true
      for (const step of ctx.steps) {
        await ctx.onStepFail(step.id, (result as unknown as { error?: { message?: string } }).error?.message ?? 'Workflow failed')
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[mastra] tenantId=${tenantId} taskId=${taskId} workflow error:`, message)
    await postTaskComment(taskId, `❌ Task failed: ${message}`, agentId)
    await callInternalTaskApi(`/internal/tasks/${taskId}/fail`, { error: message }, traceId)
    await refundTask({ tenantId, taskId })
    return {}
  }

  if (!earlyTermination) {
    await postTaskComment(taskId, `✅ All steps completed.`, agentId)
    await callInternalTaskApi(`/internal/tasks/${taskId}/complete`, { summary: 'All steps completed successfully.' }, traceId)
    await postTaskEval({ taskId, tenantId, taskTitle, taskDescription, finalOutput: stepOutputs.join('\n\n') || taskTitle })
    recordUsage({ tenantId, actorId: agentId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
    void settleTask({ tenantId, taskId, agentId, model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
  } else {
    // Reachable from onStepFail, onTaskComment, or the workflow's own
    // non-success result branch above — none of those throw, so none reach
    // the catch block's refundTask call. Without this, the estimate charged
    // at :42 stands forever for work that never landed. Safe unconditionally
    // — see refundTask's settled-row and net>=0n guards.
    await refundTask({ tenantId, taskId })
  }
  return {}
}

import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { platformAgent, formatterAgent } from '../index.js'
import { tenantContextSchema } from '../context.js'

// ─── Schemas ──────────────────────────────────────────────────────────────────
// Mirrors the pre-migration hand-rolled step loop's StepInputSchema/
// StepOutputSchema exactly — the plan's shape hasn't changed, only how each
// step executes.

const planStepInputSchema = z.object({
  stepId: z.string(),
  stepNumber: z.number(),
  title: z.string(),
  description: z.string().optional(),
  toolName: z.string().optional(),
})

const planStepOutputSchema = z.object({
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

const stepFormatSchema = z.object({
  status: z.enum(['done', 'needs_clarification', 'failed']),
  summary: z.string(),
  reasoning: z.string().optional(),
  question: z.string().optional(),
  toolCalled: z.string().optional(),
})

// Every prior successfully-completed step's summary, in order — threaded
// into later steps' prompts (buildStepPrompt) so a .foreach() iteration
// that runs independently of its siblings still sees what came before it.
// Declared here (on the WORKFLOW, not just the step) because only the
// workflow-level stateSchema's default is actually applied by Mastra's
// _validateInitialState on the first iteration — a step-only stateSchema
// leaves the runtime value undefined while the type system still infers a
// populated array, which throws on every run's very first step.
const workflowStateSchema = z.object({
  completedSummaries: z.array(z.object({
    stepId: z.string(), title: z.string(), summary: z.string(),
  })).default([]),
  // Set true the moment a step's approval is declined — every later step
  // checks this and short-circuits to a failed output without calling the
  // agent, implementing fail-fast decline without a workflow-level abort
  // primitive.
  declined: z.boolean().default(false),
})

const workflowInputSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  taskDescription: z.string().optional(),
  instructions: z.string(),
  steps: z.array(planStepInputSchema),
  highStakeTools: z.array(z.string()),
  requiresApprovalTools: z.array(z.string()),
  blockedTools: z.array(z.string()),
  allowedTools: z.array(z.string()),
  maxTokensPerMessage: z.number().nullable(),
  attachmentContext: z.string().nullable(),
  acceptanceCriteria: z.string().nullable(),
})

// ─── Tool-name normalization (ported from the pre-migration hand-rolled step loop) ──

const TOOL_NAME_MAP: Record<string, string> = {
  web_search: 'internet_search',
  code_execution: 'code_execution',
  web_fetch: 'web_fetch',
}

function normalizeToolName(toolName: string): string {
  for (const [planName, agentName] of Object.entries(TOOL_NAME_MAP)) {
    if (toolName === planName || toolName.endsWith(`_${planName}`)) return agentName
  }
  return toolName
}

function buildStepPrompt(
  taskTitle: string,
  taskDescription: string | undefined,
  step: { title: string; description?: string; toolName?: string },
  attachmentContext: string | null | undefined,
  acceptanceCriteria: string | null | undefined,
  completedSummaries: Array<{ stepId: string; title: string; summary: string }>,
  requiresApprovalTools: string[],
): string {
  // Matches routes/tasks.prompt.ts's existing convention for rendering prior
  // work, rather than inventing a new heading for this workflow's local copy.
  // Capped to the last 5 steps and 400 chars per summary — unbounded replay
  // of "the actual output data the user needs" (this schema's own summary
  // field description) grows every later step's prompt without limit
  // otherwise.
  const priorWork = completedSummaries.slice(-5).map((s) =>
    `- ✅ ${s.title}: ${s.summary.length > 400 ? s.summary.slice(0, 400) + '…' : s.summary}`
  ).join('\n')

  const governanceNote = requiresApprovalTools.length > 0
    ? `\n\nTOOL GOVERNANCE:\nThese tools require human approval before use: ${requiresApprovalTools.join(', ')}. If a step requires one of these tools, respond with status "needs_clarification" unless you have already been granted approval for this step.`
    : ''

  return [
    `Task: ${taskTitle}`,
    taskDescription ? `Context: ${taskDescription}` : null,
    priorWork ? `\n**Previously Completed Steps:**\n${priorWork}` : null,
    attachmentContext ? `\n## Attached Files\n${attachmentContext}` : null,
    acceptanceCriteria
      ? `\n## Definition of Done\n${acceptanceCriteria}\n\nYou MUST verify your output meets these criteria before marking this step complete.`
      : null,
    ``,
    `Current step: ${step.title}`,
    step.description ? `Step details: ${step.description}` : null,
    step.toolName ? `Use tool: ${normalizeToolName(step.toolName)}` : null,
    governanceNote,
    ``,
    `You MUST respond with valid JSON matching:`,
    `{`,
    `  "status": "done" | "needs_clarification" | "failed",`,
    `  "summary": "REQUIRED: the actual output data the user needs.",`,
    `  "reasoning": "why you did it this way",`,
    `  "question": "only if needs_clarification",`,
    `  "toolCalled": "tool name if you used one",`,
    `  "toolResult": "the raw result from the tool call if used"`,
    `}`,
  ].filter(Boolean).join('\n')
}

// ─── Step: runPlanStep ────────────────────────────────────────────────────────
// One step definition, iterated by .foreach() over workflowInputSchema.steps.
// Policy checks (blocked/allowed/requiresApproval) run before any agent call —
// same order the pre-migration hand-rolled step loop used. requiresApproval
// suspends via Mastra's native mechanism instead of the old code's early
// `return` that discarded all remaining-step state.

const runPlanStep = createStep({
  id: 'run-plan-step',
  requestContextSchema: tenantContextSchema,
  inputSchema: planStepInputSchema,
  outputSchema: planStepOutputSchema,
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({
    stepId: z.string(),
    title: z.string(),
    toolName: z.string(),
    reason: z.literal('requires_approval'),
  }),
  stateSchema: workflowStateSchema,
  execute: async ({ inputData, resumeData, suspend, suspendData, requestContext, getInitData, state, setState }) => {
    // `getInitData<z.infer<typeof workflowInputSchema>>()` — the established
    // pattern used by every other workflow step in this codebase — because
    // `getInitData<typeof workflowInputSchema>()` resolves to the ZodObject
    // schema type itself rather than the inferred data type.
    const init = getInitData<z.infer<typeof workflowInputSchema>>()
    const rawStep = inputData
    const step = {
      ...rawStep,
      toolName: rawStep.toolName ? normalizeToolName(rawStep.toolName) : rawStep.toolName,
    }

    // A prior step's approval was declined — stop immediately instead of
    // burning tokens running steps that will only need refunding later.
    if (state?.declined) {
      return {
        stepId: step.stepId, status: 'failed' as const,
        summary: `Run stopped: an earlier tool call was declined.`,
      }
    }

    // Resuming a suspended approval — resumeData is only present on that path.
    if (suspendData?.stepId && resumeData) {
      if (!resumeData.approved) {
        await setState({ ...state, declined: true })
        return {
          stepId: step.stepId, status: 'failed' as const,
          summary: `Tool "${suspendData.toolName}" approval was declined.`,
        }
      }
      // Approved — fall through to execute the step below, exactly as a
      // first-run step with no approval requirement would.
    } else {
      // First run — policy checks, in the same order the pre-migration hand-rolled step loop used.
      if (step.toolName && init.blockedTools.includes(step.toolName)) {
        return {
          stepId: step.stepId, status: 'failed' as const,
          summary: `Tool "${step.toolName}" is blocked by agent policy.`,
        }
      }
      if (step.toolName && init.allowedTools.length > 0 && !init.allowedTools.includes(step.toolName)) {
        return {
          stepId: step.stepId, status: 'failed' as const,
          summary: `Tool "${step.toolName}" is not in the allowed tools list for this agent.`,
        }
      }
      if (step.toolName && (init.requiresApprovalTools.includes(step.toolName) || init.requiresApprovalTools.includes('*'))) {
        return await suspend(
          { stepId: step.stepId, title: step.title, toolName: step.toolName, reason: 'requires_approval' as const },
          { resumeLabel: `approve:${step.stepId}` },
        )
      }
    }

    const stepStartMs = Date.now()
    const prompt = buildStepPrompt(
      init.taskTitle, init.taskDescription, step,
      init.attachmentContext, init.acceptanceCriteria,
      state?.completedSummaries ?? [], init.requiresApprovalTools,
    )

    let pass1Result
    let genAttempts = 0
    while (genAttempts < 2) {
      try {
        pass1Result = await platformAgent.generate(prompt, {
          memory: { thread: `task:${init.taskId}:step:${step.stepNumber}`, resource: requestContext.get('tenantId') as string },
          requestContext,
          ...(init.maxTokensPerMessage ? { modelSettings: { maxOutputTokens: init.maxTokensPerMessage } } : {}),
        })
        break
      } catch (genErr) {
        const msg = genErr instanceof Error ? genErr.message : String(genErr)
        if (genAttempts === 0 && /timeout|ECONNRESET|ECONNREFUSED|503|429/i.test(msg)) {
          console.warn(`[taskExecutionPlan] step ${step.stepId} transient error, retrying in 2s: ${msg}`)
          await new Promise((r) => setTimeout(r, 2000))
          genAttempts++
        } else {
          throw genErr
        }
      }
    }
    if (!pass1Result) throw new Error('agent.generate failed after retry')
    const stepLatencyMs = Date.now() - stepStartMs
    const pass1Usage = pass1Result.totalUsage ?? pass1Result.usage

    const agentText = pass1Result.text ?? '(no output)'
    const formatPrompt = [
      `An AI agent executed this task step and produced the output below.`,
      `Step: ${step.title}`,
      step.description ? `Details: ${step.description}` : null,
      ``, `--- Agent output ---`, agentText, `--- End output ---`, ``,
      `Convert this into the required JSON format:`,
      `- status: "done" if completed successfully, "failed" if it could not complete, "needs_clarification" if a question must be answered first`,
      `- summary: the actual data the user needs. Human-readable text, never raw JSON.`,
      `- reasoning: brief explanation of approach`,
      `- question: only if status is "needs_clarification"`,
      `- toolCalled: name of the tool used, if identifiable from the output`,
    ].filter(Boolean).join('\n')

    const pass2Result = await formatterAgent.generate(formatPrompt, {
      structuredOutput: { schema: stepFormatSchema },
    })
    const pass2Usage = pass2Result.totalUsage ?? pass2Result.usage

    if (!pass2Result.object) {
      return {
        stepId: step.stepId, status: 'failed' as const,
        summary: `Formatter returned no structured output. Raw: ${String(pass2Result.text ?? '').slice(0, 200)}`,
      }
    }

    if (pass2Result.object.status === 'done') {
      await setState({
        ...state,
        completedSummaries: [
          ...(state?.completedSummaries ?? []),
          { stepId: step.stepId, title: step.title, summary: pass2Result.object.summary },
        ],
      })
    }

    return {
      ...pass2Result.object,
      stepId: step.stepId,
      latencyMs: stepLatencyMs,
      inputTokens: (pass1Usage?.inputTokens ?? 0) + (pass2Usage?.inputTokens ?? 0),
      outputTokens: (pass1Usage?.outputTokens ?? 0) + (pass2Usage?.outputTokens ?? 0),
    }
  },
})

// ─── Workflow ─────────────────────────────────────────────────────────────────

export const taskExecutionPlanWorkflow = createWorkflow({
  id: 'task-execution-plan',
  requestContextSchema: tenantContextSchema,
  inputSchema: workflowInputSchema,
  outputSchema: z.array(planStepOutputSchema),
  stateSchema: workflowStateSchema,
})
  .map(async ({ inputData }) => inputData.steps)
  .foreach(runPlanStep)
  .commit()

import { z } from 'zod'
import { createTenantAgent, TenantAgentConfig } from './agent.js'
import { formatterAgent } from './index.js'

// Task step schema — matches our existing taskSteps table
const StepInputSchema = z.object({
  stepId: z.string(),
  stepNumber: z.number(),
  title: z.string(),
  description: z.string().optional(),
  toolName: z.string().optional(),
})

const StepOutputSchema = z.object({
  stepId: z.string(),
  status: z.enum(['done', 'needs_clarification',
                  'failed']),
  summary: z.string(),
  reasoning: z.string().optional(),
  question: z.string().optional(),
  toolCalled: z.string().optional(),
  toolResult: z.unknown().optional(),
  latencyMs: z.number().int().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
})

// Schema for the Pass 2 formatting call — relay-injected fields (stepId, latencyMs,
// inputTokens, outputTokens) are excluded and merged in after generateObject returns.
const StepFormatSchema = z.object({
  status: z.enum(['done', 'needs_clarification', 'failed']),
  summary: z.string(),
  reasoning: z.string().optional(),
  question: z.string().optional(),
  toolCalled: z.string().optional(),
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

export async function runMastraWorkflow(
  ctx: WorkflowContext
): Promise<void> {
  const agentConfig: TenantAgentConfig = {
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    agentSlug: ctx.agentSlug,
    instructions: ctx.instructions,
    connectedProviders: ctx.connectedProviders,
    enabledTools: ctx.enabledTools,
    maxTokens: ctx.maxTokensPerMessage ?? null,
  }

  let agent: Awaited<ReturnType<typeof createTenantAgent>>['agent']
  let mcpClient: Awaited<ReturnType<typeof createTenantAgent>>['mcpClient']
  try {
    const result = await createTenantAgent(agentConfig)
    agent = result.agent
    mcpClient = result.mcpClient
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[mastra] createTenantAgent failed:', message)
    for (const step of ctx.steps) {
      await ctx.onStepStart(step.id)
      await ctx.onStepFail(step.id, `Agent initialization failed: ${message}`)
    }
    return
  }

  // Governance note injected into the first step prompt so the agent knows
  // which tools require approval before it attempts to use them.
  const governanceNote = ctx.requiresApprovalTools.length > 0
    ? `\n\nTOOL GOVERNANCE:\nThese tools require human approval before use: ${ctx.requiresApprovalTools.join(', ')}. If a step requires one of these tools, respond with status "needs_clarification" and explain which tool needs approval.`
    : ''

  // Disconnect the SSE connection to mcp-server when done —
  // success, early return (clarification/fail), or thrown exception.
  try {
    // Execute steps sequentially
    // Mirrors existing runTaskSteps() behavior
    // but uses Mastra agent instead of OpenClaw
    let isFirstStep = true
    const completedStepOutputs: string[] = []
    for (const rawStep of ctx.steps.sort(
      (a, b) => a.stepNumber - b.stepNumber
    )) {
      // Normalize toolName to strip any MCP server prefix stored in old plans
      const step = {
        ...rawStep,
        toolName: rawStep.toolName ? normalizeToolName(rawStep.toolName) : rawStep.toolName,
      }
      try {
        // Step must be running before any terminal transition (fail/complete).
        // Policy checks below may exit early — all must come after onStepStart.
        await ctx.onStepStart(step.id)

        // Policy: blocked tools — hard stop, fail the step
        if (step.toolName && ctx.blockedTools.includes(step.toolName)) {
          await ctx.onStepFail(
            step.id,
            `Tool "${step.toolName}" is blocked by agent policy.`
          )
          await ctx.onTaskComment(
            `🚫 Step "${step.title}" blocked — tool "${step.toolName}" is not permitted by policy.`
          )
          return
        }

        // Policy: allowedTools — if set, only these are permitted
        if (
          step.toolName &&
          ctx.allowedTools.length > 0 &&
          !ctx.allowedTools.includes(step.toolName)
        ) {
          await ctx.onStepFail(
            step.id,
            `Tool "${step.toolName}" is not in the allowed tools list for this agent.`
          )
          await ctx.onTaskComment(
            `🚫 Step "${step.title}" blocked — tool "${step.toolName}" is not in this agent's allowed tools.`
          )
          return
        }

        // If the step's designated tool requires approval — stop immediately
        // before calling the agent. The human must confirm first.
        if (step.toolName && ctx.requiresApprovalTools.includes(step.toolName)) {
          await ctx.onStepComplete(step.id, {
            stepId: step.id,
            status: 'needs_clarification',
            summary: `Tool "${step.toolName}" requires human approval before execution.`,
            question: `This step uses "${step.toolName}" which is configured to require approval. Please confirm you want to proceed.`,
          })
          await ctx.onTaskComment(
            `⚠️ Step "${step.title}" requires approval to use tool: ${step.toolName}`
          )
          return
        }

        const stepOutputsSoFar = completedStepOutputs.slice()
        const basePrompt = buildStepPrompt(
          ctx.taskTitle,
          ctx.taskDescription,
          step,
          ctx.attachmentContext,
          ctx.acceptanceCriteria,
          stepOutputsSoFar
        )
        const prompt = isFirstStep ? governanceNote + basePrompt : basePrompt
        isFirstStep = false

        const stepStartMs = Date.now()

        // Pass 1 — free generation with tools.
        // No structuredOutput so Gemini can use functionDeclarations (tool calls).
        // Mastra handles the tool-call loop and returns the final text in result.text.
        let pass1Result
        let genAttempts = 0
        while (genAttempts < 2) {
          try {
            pass1Result = await agent.generate(prompt, {
              // Scope memory to this task session
              memory: {
                thread: `task:${ctx.taskId}:step:${step.stepNumber}`,
                resource: ctx.tenantId,
              },
              ...(ctx.maxTokensPerMessage
                ? { modelSettings: { maxOutputTokens: ctx.maxTokensPerMessage } }
                : {}),
            })
            break
          } catch (genErr) {
            const msg = genErr instanceof Error
              ? genErr.message
              : String(genErr)
            if (
              genAttempts === 0 &&
              /timeout|ECONNRESET|ECONNREFUSED|503|429/i.test(msg)
            ) {
              console.warn(
                `[mastra] step ${step.id} transient error, ` +
                `retrying in 2s: ${msg}`
              )
              await new Promise(r => setTimeout(r, 2000))
              genAttempts++
            } else {
              throw genErr
            }
          }
        }
        if (!pass1Result) throw new Error('agent.generate failed after retry')
        const stepLatencyMs = Date.now() - stepStartMs
        const pass1Usage = pass1Result.totalUsage ?? pass1Result.usage

        // Pass 2 — format into StepFormatSchema using a no-tools agent.
        // formatterAgent has tools:{} so Gemini uses responseSchema without conflict
        // from functionDeclarations (the two are mutually exclusive in the Gemini API).
        const agentText = pass1Result.text ?? '(no output)'
        const formatPrompt = [
          `An AI agent executed this task step and produced the output below.`,
          `Step: ${step.title}`,
          step.description ? `Details: ${step.description}` : null,
          ``,
          `--- Agent output ---`,
          agentText,
          `--- End output ---`,
          ``,
          `Convert this into the required JSON format:`,
          `- status: "done" if completed successfully, "failed" if it could not complete, "needs_clarification" if a question must be answered first`,
          `- summary: the actual data the user needs — for jobs: list each with title, company, location, salary, apply URL; for research: key findings with source URLs. Human-readable text, never raw JSON.`,
          `- reasoning: brief explanation of approach`,
          `- question: only if status is "needs_clarification"`,
          `- toolCalled: name of the tool used, if identifiable from the output`,
        ].filter(Boolean).join('\n')

        const pass2Result = await formatterAgent.generate(formatPrompt, {
          structuredOutput: { schema: StepFormatSchema },
        })
        const pass2Usage = pass2Result.totalUsage ?? pass2Result.usage

        if (!pass2Result.object) {
          await ctx.onStepFail(
            step.id,
            `Formatter returned no structured output. Raw: ${String(pass2Result.text ?? '').slice(0, 200)}`
          )
          return
        }

        const parsed: z.infer<typeof StepOutputSchema> = {
          ...(pass2Result.object as z.infer<typeof StepFormatSchema>),
          stepId: step.id,
          latencyMs: stepLatencyMs,
          inputTokens: (pass1Usage?.inputTokens ?? 0) + (pass2Usage?.inputTokens ?? 0),
          outputTokens: (pass1Usage?.outputTokens ?? 0) + (pass2Usage?.outputTokens ?? 0),
        }

        await ctx.onStepComplete(step.id, parsed)

        // Track completed output for chaining into subsequent step prompts
        if (parsed.status === 'done') {
          completedStepOutputs.push(parsed.summary)
        }

        // If agent needs clarification — stop execution
        // Same behavior as existing OpenClaw path
        if (parsed.status === 'needs_clarification') {
          await ctx.onTaskComment(
            `❓ ${parsed.question ??
              'Clarification needed before continuing.'}`
          )
          return
        }

        if (parsed.status === 'failed') {
          await ctx.onStepFail(
            step.id,
            parsed.summary ?? 'Step failed'
          )
          return
        }

      } catch (err) {
        const message = err instanceof Error
          ? err.message
          : String(err)
        await ctx.onStepFail(step.id, message)
        return
      }
    }
  } finally {
    await mcpClient.disconnect()
  }
}

// Map of plan/DB tool names → actual agent tool names.
// 'web_search' is stored in plans but the agent tool is 'internet_search' to avoid
// Vertex AI's reserved name conflict (web_search triggers native Search tool behavior
// which is incompatible with responseSchema/structured output).
const TOOL_NAME_MAP: Record<string, string> = {
  web_search: 'internet_search',
  code_execution: 'code_execution',
  web_fetch: 'web_fetch',
}

// Strip MCP server prefix (e.g. "saarthiTools_web_search" → "internet_search").
// Plans created before the server-tool filter fix may have stored prefixed names.
function normalizeToolName(toolName: string): string {
  // Check against known server tool names (with or without MCP prefix)
  for (const [planName, agentName] of Object.entries(TOOL_NAME_MAP)) {
    if (toolName === planName || toolName.endsWith(`_${planName}`)) return agentName
  }
  return toolName
}

function buildStepPrompt(
  taskTitle: string,
  taskDescription: string | undefined,
  step: {
    title: string
    description?: string
    toolName?: string
  },
  attachmentContext?: string | null,
  acceptanceCriteria?: string | null,
  previousStepOutputs?: string[]
): string {
  return [
    `Task: ${taskTitle}`,
    taskDescription
      ? `Context: ${taskDescription}`
      : null,
    attachmentContext
      ? `\n## Attached Files\n${attachmentContext}`
      : null,
    acceptanceCriteria
      ? `\n## Definition of Done\n${acceptanceCriteria}\n\nYou MUST verify your output meets these criteria before marking this step complete.`
      : null,
    previousStepOutputs && previousStepOutputs.length > 0
      ? `\n## Previous Step Results\n${previousStepOutputs.map((o, i) => `Step ${i + 1}: ${o}`).join('\n')}`
      : null,
    ``,
    `Current step: ${step.title}`,
    step.description
      ? `Step details: ${step.description}`
      : null,
    step.toolName
      ? `Use tool: ${normalizeToolName(step.toolName)}`
      : null,
    ``,
    `You MUST respond with valid JSON matching:`,
    `{`,
    `  "status": "done" | "needs_clarification" | "failed",`,
    `  "summary": "REQUIRED: the actual output data the user needs. For jobs: include job title, company, location, salary, apply URL. For research: include specific facts and source URLs. For extracted data: include the actual extracted content. Never write a description of what you did — write the actual result.",`,
    `  "reasoning": "why you did it this way",`,
    `  "question": "only if needs_clarification",`,
    `  "toolCalled": "tool name if you used one",`,
    `  "toolResult": "the raw result from the tool call if used"`,
    `}`,
  ].filter(Boolean).join('\n')
}

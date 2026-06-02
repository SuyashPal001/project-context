import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { prdAgent } from '../agents/prdAgent.js'
import { formatterAgent } from '../agents/formatterAgent.js'
import {
  workflowInputSchema,
  prdDataSchema,
  planOutputSchema,
  extractOutputSchema,
} from './documentWorkflow.schemas.js'

// ─── Step 1: planStep ─────────────────────────────────────────────────────────
// Reads the PRD and produces a milestone plan in plain text.
// prdAgent, no tools, free-text output.

export const planStep = createStep({
  id: 'doc-plan',
  inputSchema: workflowInputSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData }) => {
    const { taskTitle, attachmentContext } = inputData

    const prompt = [
      `You are a senior engineering lead. Read this PRD and produce a milestone plan in plain text.`,
      ``,
      `Rules:`,
      `- Produce 2-5 milestones ordered by dependency`,
      `- Each milestone: phase number + name + one sentence outcome + list of PRD features that belong to it`,
      `- Mark any features explicitly deferred as post-launch/Phase 2 as OUT OF SCOPE — do not include in milestones`,
      `- Flag ambiguous requirements explicitly`,
      `- Do NOT produce tasks yet — milestones only`,
      ``,
      `PRD Title: ${taskTitle}`,
      `PRD Content: ${attachmentContext}`,
    ].join('\n')

    try {
      const result = await prdAgent.generate(prompt, { activeTools: [] })
      console.log(`[doc:planStep] plan length=${result.text?.length ?? 0}`)
      return {
        plan: result.text ?? '',
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      }
    } catch (err) {
      console.error('[doc:planStep] error:', (err as Error).message)
      return { plan: '', inputTokens: 0, outputTokens: 0 }
    }
  },
})

// ─── Step 2: extractStep ──────────────────────────────────────────────────────
// Two-pass to avoid Gemini responseSchema + functionDeclarations conflict:
// Pass 1 — prdAgent, no tools, free-text breakdown
// Pass 2 — formatterAgent, structuredOutput (prdDataSchema), no tools

export const extractStep = createStep({
  id: 'doc-extract',
  inputSchema: planOutputSchema,
  outputSchema: extractOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    const { plan, inputTokens: planInputTokens, outputTokens: planOutputTokens } = inputData
    const initData = getInitData<z.infer<typeof workflowInputSchema>>()
    const { taskTitle, attachmentContext } = initData

    const emptyFallback: z.infer<typeof extractOutputSchema> = {
      plan: { title: taskTitle, description: '' },
      milestones: [],
      risks: [],
      inputTokens: planInputTokens,
      outputTokens: planOutputTokens,
    }

    const pass1Prompt = [
      `CRITICAL: You MUST produce tasks for ALL milestones listed in the plan above. Do not stop after the first milestone. The output is incomplete unless every milestone has 3-8 tasks. Count the milestones in the plan and ensure your output covers every single one.`,
      ``,
      `You are a senior engineering lead.`,
      `You have already planned these milestones:`,
      plan,
      ``,
      `Now extract the full task breakdown for each milestone.`,
      ``,
      `For every milestone produce 3-8 tasks. Each task must have:`,
      `- Title (action verb + noun)`,
      `- Description (what needs to be built)`,
      `- Acceptance criteria (3-5 testable conditions)`,
      `- Estimate in hours: XS=2 S=4 M=8 L=16 XL=32`,
      `- Type: feature | bug | chore | spike`,
      `- Priority: low | medium | high | urgent`,
      ``,
      `Rules:`,
      `- Every PRD feature maps to at least one task`,
      `- Ambiguous requirements → spike task`,
      `- Post-launch features stay OUT of milestones`,
      `- Estimates must be specific numbers, never TBD`,
      ``,
      `PRD Content: ${attachmentContext}`,
    ].join('\n')

    let pass1Text = ''
    let pass1InputTokens = 0
    let pass1OutputTokens = 0
    try {
      const pass1 = await prdAgent.generate(pass1Prompt, { activeTools: [], modelSettings: { maxOutputTokens: 24000 } })
      pass1Text = pass1.text ?? ''
      pass1InputTokens = pass1.usage?.inputTokens ?? 0
      pass1OutputTokens = pass1.usage?.outputTokens ?? 0
      console.log(`[doc:extractStep] pass1 length=${pass1Text.length}`)
    } catch (err) {
      console.error('[doc:extractStep] pass1 error:', (err as Error).message)
      return emptyFallback
    }

    const pass2Prompt = [
      `CRITICAL: Extract ALL milestones from the input. The input contains multiple milestones. Do not stop after extracting the first one. Your output is incomplete if milestones array has fewer items than the input describes.`,
      ``,
      `Extract the project plan and milestone/task breakdown from the text below into structured JSON.`,
      ``,
      `--- Breakdown text ---`,
      pass1Text.slice(0, 24000),
      `--- End ---`,
      ``,
      `Instructions:`,
      `- plan.title: use "${taskTitle}"`,
      `- plan.description: 1-2 sentence summary of what this PRD delivers`,
      `- milestones: each milestone from the breakdown, with all tasks`,
      `- tasks: every task under its milestone, with all fields populated`,
      `- risks: 2-5 top project risks as short strings`,
      `- totalEstimatedHours: sum of all task estimatedHours`,
    ].join('\n')

    try {
      const pass2 = await formatterAgent.generate(pass2Prompt, {
        structuredOutput: { schema: prdDataSchema },
        modelSettings: { maxOutputTokens: 24000 },
      })
      console.log('[doc:extractStep] pass2.object:', pass2.object ? 'populated' : 'null')
      const pass2InputTokens = pass2.usage?.inputTokens ?? 0
      const pass2OutputTokens = pass2.usage?.outputTokens ?? 0
      if (pass2.object) {
        const extracted = pass2.object as z.infer<typeof prdDataSchema>
        return {
          ...extracted,
          inputTokens: planInputTokens + pass1InputTokens + pass2InputTokens,
          outputTokens: planOutputTokens + pass1OutputTokens + pass2OutputTokens,
        }
      }
    } catch (err) {
      console.error('[doc:extractStep] pass2 error:', (err as Error).message)
    }

    return {
      ...emptyFallback,
      inputTokens: planInputTokens + pass1InputTokens,
      outputTokens: planOutputTokens + pass1OutputTokens,
    }
  },
})

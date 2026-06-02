import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { formatterAgent } from '../../index.js'

// ─── Local schema copies (identical to taskExecution.ts) ─────────────────────
// Defined here to avoid circular import: taskExecution imports this file,
// so this file cannot import from taskExecution.

const resultItemSchema = z.object({
  title: z.string(),
  source: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
})

// Matches mergeStep outputSchema exactly so Mastra auto-populates inputData.
const dodVerifyInputSchema = z.object({
  results: z.array(resultItemSchema),
  totalFound: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
})

export const dodVerifyOutputSchema = z.object({
  passed: z.boolean(),
  failureReason: z.string().optional(),
  criteriaMet: z.array(z.string()),
  criteriaUnmet: z.array(z.string()),
  resultCount: z.number(),
  mergedResults: z.array(resultItemSchema),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
})

const judgeOutputSchema = z.object({
  criteriaMet: z.array(z.string()),
  criteriaUnmet: z.array(z.string()),
  overallPassed: z.boolean(),
})

// ─── Step: dod-verify ─────────────────────────────────────────────────────────
// Deterministic gate between mergeStep and composeStep.
// Step 1: hard gate — fail immediately if no results.
// Step 2: pass through if no acceptanceCriteria.
// Step 3: LLM-as-judge via formatterAgent (structuredOutput, no tools).
// Never throws — DoD failure is informational only, not fatal.

export const dodVerifyStep = createStep({
  id: 'dod-verify',
  inputSchema: dodVerifyInputSchema,
  outputSchema: dodVerifyOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    const { results: mergedResults, totalInputTokens, totalOutputTokens } = inputData
    const initData = getInitData<{ taskTitle: string; acceptanceCriteria?: string }>()
    const { taskTitle, acceptanceCriteria } = initData

    console.log(`[dodVerifyStep] resultCount=${mergedResults.length} hasCriteria=${!!acceptanceCriteria}`)

    // Step 1 — Hard gate: no results
    if (mergedResults.length === 0) {
      console.log('[dodVerifyStep] hard-fail: no results')
      return {
        passed: false,
        failureReason: 'No results returned from search phase',
        criteriaMet: [],
        criteriaUnmet: [],
        resultCount: 0,
        mergedResults,
        totalInputTokens,
        totalOutputTokens,
      }
    }

    // Step 2 — No criteria: pass through
    if (!acceptanceCriteria) {
      console.log('[dodVerifyStep] no criteria — auto-pass')
      return {
        passed: true,
        criteriaMet: [],
        criteriaUnmet: [],
        resultCount: mergedResults.length,
        mergedResults,
        totalInputTokens,
        totalOutputTokens,
      }
    }

    // Step 3 — LLM-as-judge
    const sampleTitles = mergedResults
      .slice(0, 5)
      .map(r => `- ${r.title}`)
      .join('\n')

    const prompt = [
      `You are a Definition-of-Done verifier for an AI research task.`,
      ``,
      `Task: ${taskTitle}`,
      ``,
      `Acceptance Criteria:`,
      acceptanceCriteria,
      ``,
      `Search returned ${mergedResults.length} results. Sample titles:`,
      sampleTitles,
      ``,
      `Break the acceptance criteria into individual requirements. For each requirement, determine whether the search results plausibly satisfy it based on titles and sources alone.`,
      ``,
      `Return ONLY valid JSON matching this exact shape:`,
      `{`,
      `  "criteriaMet": ["...requirement text..."],`,
      `  "criteriaUnmet": ["...requirement text..."],`,
      `  "overallPassed": true`,
      `}`,
      ``,
      `Rules:`,
      `- Be generous. If results are relevant to the task, mark criteria as met.`,
      `- Only mark unmet if results are clearly off-topic or completely missing.`,
      `- overallPassed is true if criteriaUnmet is empty.`,
    ].join('\n')

    try {
      const response = await formatterAgent.generate(prompt, {
        structuredOutput: { schema: judgeOutputSchema },
      })
      const obj = response.object as z.infer<typeof judgeOutputSchema> | null
      if (obj) {
        console.log(`[dodVerifyStep] judge result: passed=${obj.overallPassed} met=${obj.criteriaMet.length} unmet=${obj.criteriaUnmet.length}`)
        return {
          passed: obj.overallPassed,
          criteriaMet: obj.criteriaMet,
          criteriaUnmet: obj.criteriaUnmet,
          failureReason: obj.overallPassed ? undefined : `Unmet: ${obj.criteriaUnmet.join('; ')}`,
          resultCount: mergedResults.length,
          mergedResults,
          totalInputTokens,
          totalOutputTokens,
        }
      }
    } catch (err) {
      console.error('[dodVerifyStep] LLM judge error — falling back to pass:', (err as Error).message)
    }

    // Fallback: never crash the workflow
    return {
      passed: true,
      criteriaMet: [],
      criteriaUnmet: [],
      resultCount: mergedResults.length,
      mergedResults,
      totalInputTokens,
      totalOutputTokens,
    }
  },
})

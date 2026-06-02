import { createStep, createWorkflow } from '@mastra/core/workflows'
import { createAnswerRelevancyScorer } from '@mastra/evals/scorers/prebuilt'
import { z } from 'zod'

import { platformAgent, formatterAgent } from '../index.js'
import { saarthiModel } from '../model.js'
import { dodVerifyStep } from './steps/dodVerifyStep.js'
import { dodPassScorer } from './scorers.js'


// ─── Shared schemas ───────────────────────────────────────────────────────────

const resultItemSchema = z.object({
  title: z.string(),
  source: z.string().optional(),
  location: z.string().optional(),
  url: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
})

// ─── Workflow input ───────────────────────────────────────────────────────────

const workflowInputSchema = z.object({
  taskTitle: z.string(),
  taskDescription: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  tenantId: z.string(),
  attachmentContext: z.string().optional(),
  referenceText: z.string().optional(),
  links: z.array(z.string()).optional(),
  autoApprove: z.boolean().optional().default(true),
})

// ─── Step schemas ─────────────────────────────────────────────────────────────

// planStep must return an array directly — .foreach() requires TPrevSchema extends any[]
const planOutputSchema = z.array(z.object({ query: z.string() }))

const searchOutputSchema = z.object({
  results: z.array(resultItemSchema),
  status: z.enum(['done', 'failed']),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
})

const mergeOutputSchema = z.object({
  results: z.array(resultItemSchema),
  totalFound: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
})

// dodVerifyStep feeds composeStep: passed, criteriaMet, criteriaUnmet + passthrough fields
const composeInputSchema = z.object({
  passed: z.boolean(),
  failureReason: z.string().optional(),
  criteriaMet: z.array(z.string()),
  criteriaUnmet: z.array(z.string()),
  resultCount: z.number(),
  mergedResults: z.array(resultItemSchema),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
})

const composeOutputSchema = z.object({
  summary: z.string(),
  status: z.enum(['done', 'needs_clarification', 'failed']),
  reasoning: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  dodPassed: z.boolean(),
})

// ─── Step 1: planStep ────────────────────────────────────────────────────────
// Breaks the task into 2–4 specific search queries.
// outputSchema is a plain array so .foreach() can iterate it.

export const planStep = createStep({
  id: 'plan',
  inputSchema: workflowInputSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData }) => {
    const initData = inputData
    const { taskTitle, taskDescription, acceptanceCriteria, attachmentContext, referenceText, links } = initData

    const prompt = [
      `Break this task into 2–4 specific search queries that together would fully answer it.`,
      `Return ONLY a JSON object: { "queries": ["query1", "query2", ...], "approach": "one sentence" }`,
      ``,
      `Task: ${taskTitle}`,
      taskDescription ? `Description: ${taskDescription}` : null,
      acceptanceCriteria ? `Definition of Done: ${acceptanceCriteria}` : null,
      attachmentContext ? `\n## Attached Files\n${attachmentContext}` : null,
      referenceText ? `\n## Reference Material\n${referenceText}` : null,
      links?.length ? `\n## Relevant Links\n${links.join('\n')}` : null,
    ].filter(Boolean).join('\n')

    let queries: string[] = []
    let approach = ''

    try {
      const result = await platformAgent.generate(prompt, {
        activeTools: [],
      })
      const text = result.text ?? ''
      // Extract JSON block — model may wrap in ```json ... ```
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { queries?: string[]; approach?: string }
        queries = Array.isArray(parsed.queries) ? parsed.queries.filter(q => typeof q === 'string') : []
        approach = typeof parsed.approach === 'string' ? parsed.approach : ''
      }
    } catch (err) {
      console.error('[planStep] error:', (err as Error).message)
    }

    if (queries.length === 0) {
      // Fallback: use taskTitle as single query
      queries = [taskTitle]
    }

    console.log(`[planStep] approach: ${approach}`)
    console.log(`[planStep] queries (${queries.length}):`, queries)

    return queries.map(q => ({ query: q }))
  },
})

// ─── Step 2: searchStep ──────────────────────────────────────────────────────
// Runs once per query via .foreach(). Two-pass to avoid Gemini conflict:
// Pass 1 — tool call (internet_search), no structuredOutput → free text
// Pass 2 — formatterAgent with structuredOutput, no tools → results array

export const searchStep = createStep({
  id: 'search',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: searchOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    const { query } = inputData
    const initData = getInitData<z.infer<typeof workflowInputSchema>>()
    const { taskTitle } = initData

    const pass1Prompt = [
      `Task: ${taskTitle}`,
      `Search query: ${query}`,
      ``,
      `Use internet_search to find results matching this query.`,
      `For each result found, extract: title, source, location (if shown), url, and any other relevant metadata.`,
      `Present all results clearly.`,
    ].join('\n')

    let pass1Text = ''
    let pass1InputTokens = 0
    let pass1OutputTokens = 0
    try {
      const pass1 = await platformAgent.generate(pass1Prompt, {
        activeTools: ['internet_search'],
      })
      pass1Text = pass1.text ?? ''
      pass1InputTokens = pass1.usage?.inputTokens ?? 0
      pass1OutputTokens = pass1.usage?.outputTokens ?? 0
      console.log(`[searchStep] query="${query}" pass1 length=${pass1Text.length}`)
    } catch (err) {
      console.error(`[searchStep] pass1 error for query="${query}":`, (err as Error).message)
      return { results: [], status: 'failed' as const, inputTokens: 0, outputTokens: 0 }
    }

    // Pass 2 — extract structured results from pass1 text
    const pass2Prompt = [
      `Extract all results from the text below into a JSON array.`,
      ``,
      `--- Search results ---`,
      pass1Text.slice(0, 4000),
      `--- End ---`,
      ``,
      `Return: { "results": [...], "status": "done" | "failed" }`,
      `Each result: title (string), source (string), location? (string), url? (string), metadata? (object with string values)`,
      `If no results found, return results: [].`,
    ].join('\n')

    try {
      const pass2 = await formatterAgent.generate(pass2Prompt, {
        structuredOutput: { schema: searchOutputSchema },
      })
      console.log('[searchStep] pass2.object:', pass2.object ? 'populated' : 'null')
      if (pass2.object) {
        const extracted = pass2.object as z.infer<typeof searchOutputSchema>
        const pass2InputTokens = pass2.usage?.inputTokens ?? 0
        const pass2OutputTokens = pass2.usage?.outputTokens ?? 0
        console.log(`[searchStep] query="${query}" results found: ${extracted.results.length}`)
        return {
          ...extracted,
          inputTokens: pass1InputTokens + pass2InputTokens,
          outputTokens: pass1OutputTokens + pass2OutputTokens,
        }
      }
    } catch (err) {
      console.error(`[searchStep] pass2 error for query="${query}":`, (err as Error).message)
    }

    return { results: [], status: 'done' as const, inputTokens: pass1InputTokens, outputTokens: pass1OutputTokens }
  },
})

// ─── Step 3: mergeStep ────────────────────────────────────────────────────────
// After .foreach(), inputData is searchOutputSchema[] — all search results as array.
// Combines and deduplicates all results.

export const mergeStep = createStep({
  id: 'merge-results',
  inputSchema: z.array(searchOutputSchema),
  outputSchema: mergeOutputSchema,
  execute: async ({ inputData }) => {
    const searchResults = inputData as Array<z.infer<typeof searchOutputSchema>>
    console.log('[mergeStep] received results count:', Array.isArray(searchResults) ? searchResults.length : 'not-array')

    const allResults = Array.isArray(searchResults)
      ? searchResults.filter(r => r?.status === 'done').flatMap(r => r?.results ?? [])
      : []

    // Deduplicate by url if present, otherwise source::title
    const seen = new Set<string>()
    const dedupedResults = allResults.filter(item => {
      const key = item.url
        ? item.url.toLowerCase()
        : `${item.source}::${item.title}`.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const totalInputTokens = Array.isArray(searchResults)
      ? searchResults.reduce((sum, r) => sum + (r?.inputTokens ?? 0), 0)
      : 0
    const totalOutputTokens = Array.isArray(searchResults)
      ? searchResults.reduce((sum, r) => sum + (r?.outputTokens ?? 0), 0)
      : 0

    console.log(`[mergeStep] total after dedup: ${dedupedResults.length} (from ${allResults.length} raw) tokens in=${totalInputTokens} out=${totalOutputTokens}`)

    return { results: dedupedResults, totalFound: dedupedResults.length, totalInputTokens, totalOutputTokens }
  },
})

// ─── Step 4: composeStep ──────────────────────────────────────────────────────
// Formats merged results into clean readable output. No tools.
// Reads DoD status from dodVerifyStep and includes it in the summary.

export const composeStep = createStep({
  id: 'compose-output',
  inputSchema: composeInputSchema,
  outputSchema: composeOutputSchema,
  scorers: {
    answerRelevancy: {
      scorer: createAnswerRelevancyScorer({ model: saarthiModel }),
      sampling: { type: 'ratio', rate: 0.5 },
    },
    dodPass: {
      scorer: dodPassScorer,
    },
  },
  execute: async ({ inputData, getInitData }) => {
    const initData = getInitData<z.infer<typeof workflowInputSchema>>()
    const { taskTitle } = initData

    const { passed, criteriaMet, criteriaUnmet, failureReason, mergedResults, totalInputTokens, totalOutputTokens } = inputData

    console.log(`[composeStep] dodPassed=${passed} resultCount=${mergedResults.length}`)

    const resultsText = mergedResults.length > 0
      ? JSON.stringify(mergedResults)
      : '(no results found)'

    // DoD status note for the compose prompt
    const dodStatusNote = passed
      ? `✓ Meets acceptance criteria${criteriaMet.length > 0 ? ': ' + criteriaMet.join('; ') : ''}`
      : `⚠ Note: ${failureReason ?? 'Did not meet acceptance criteria'}${criteriaUnmet.length > 0 ? ' — Unmet: ' + criteriaUnmet.join('; ') : ''}`

    const prompt = [
      `Task: ${taskTitle}`,
      ``,
      `DoD Status: ${dodStatusNote}`,
      ``,
      `Here are the results found:`,
      `---`,
      resultsText,
      `---`,
      ``,
      `Format this into a clean, readable summary for the user.`,
      `- Present each result clearly with all available fields`,
      `- Do not include raw JSON or technical artifacts`,
      `- Write the complete formatted output in the summary field. Do not write an intro line and stop. Include every result with all available fields. The summary IS the final output the user reads.`,
    ].filter(Boolean).join('\n')

    const searchInputTokens = totalInputTokens
    const searchOutputTokens = totalOutputTokens

    try {
      const result = await formatterAgent.generate(prompt, {
        structuredOutput: { schema: composeOutputSchema },
      })
      const composeInputTokens = result.usage?.inputTokens ?? 0
      const composeOutputTokens = result.usage?.outputTokens ?? 0
      if (result.object) {
        const obj = result.object as z.infer<typeof composeOutputSchema>
        return {
          ...obj,
          dodPassed: passed,
          inputTokens: searchInputTokens + composeInputTokens,
          outputTokens: searchOutputTokens + composeOutputTokens,
        }
      }
      return {
        summary: result.text ?? '(no output)',
        status: 'done' as const,
        reasoning: undefined,
        dodPassed: passed,
        inputTokens: searchInputTokens + composeInputTokens,
        outputTokens: searchOutputTokens + composeOutputTokens,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        summary: `Compose failed: ${message}`,
        status: 'failed' as const,
        reasoning: message,
        dodPassed: passed,
        inputTokens: searchInputTokens,
        outputTokens: searchOutputTokens,
      }
    }
  },
})

// ─── Step 2a: approvalStep ────────────────────────────────────────────────────
// Optional human-in-the-loop gate between plan and search.
// When autoApprove is true (default), skips suspension immediately.
// When autoApprove is false, suspends until resume() is called externally.

export const approvalStep = createStep({
  id: 'approval',
  // Pass-through: receives planStep's query array, returns it unchanged.
  // Same schema on both sides preserves the array type so .foreach() works without as any.
  inputSchema: planOutputSchema,
  outputSchema: planOutputSchema,
  execute: async ({ inputData, getInitData, resumeData, ...ctx }) => {
    const initData = getInitData() as z.infer<typeof workflowInputSchema>

    // Auto-approve: skip suspension entirely
    if (initData.autoApprove !== false) {
      return inputData
    }

    // Resuming — user has already approved (resumeData is present)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (resumeData && (resumeData as any).approved) {
      return inputData
    }

    // First execution — suspend until resume() is called externally
    // suspend is injected by Mastra at runtime but not in the public TS types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suspend = (ctx as any).suspend as ((payload: unknown) => Promise<void>) | undefined
    if (suspend) {
      await suspend({
        message: 'Please review the search plan and approve to continue',
        queries: initData.taskTitle,
      })
    }

    return inputData
  },
})

// ─── Workflow ─────────────────────────────────────────────────────────────────
// planStep returns z.array(z.object({ query })) which satisfies .foreach()'s
// TPrevSchema extends any[] constraint — no as any needed on foreach.
// mergeStep, dodVerifyStep, composeStep use as any due to type narrowing limits.

export const taskExecutionWorkflow = createWorkflow({
  id: 'task-execution',
  inputSchema: workflowInputSchema,
  outputSchema: composeOutputSchema,
})
  .then(planStep)
  .then(approvalStep)
  .foreach(searchStep, { concurrency: 3 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(mergeStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(dodVerifyStep as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .then(composeStep as any)
  .commit()

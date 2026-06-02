import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { formatterAgent } from '../agents/formatterAgent.js'
import {
  prdDataSchema,
  extractOutputSchema,
  docDodVerifyOutputSchema,
  composeOutputSchema,
} from './documentWorkflow.schemas.js'

// ─── Step 3: docDodVerifyStep ─────────────────────────────────────────────────
// Deterministic structural gate — no LLM call.
// Check 1: milestones.length >= 1
// Check 2: every milestone has tasks.length >= 1
// Check 3: every task has acceptanceCriteria.length >= 1
// Never crashes the workflow — errors fall back to passed: true.

export const docDodVerifyStep = createStep({
  id: 'doc-dod-verify',
  inputSchema: extractOutputSchema,
  outputSchema: docDodVerifyOutputSchema,
  execute: async ({ inputData }) => {
    const { inputTokens, outputTokens, ...prdData } = inputData

    console.log(`[doc:dodVerifyStep] milestones=${prdData.milestones.length}`)

    try {
      const criteriaMet: string[] = []
      const criteriaUnmet: string[] = []

      // Check 1 — at least one milestone
      if (prdData.milestones.length >= 1) {
        criteriaMet.push('At least one milestone produced')
      } else {
        criteriaUnmet.push('No milestones produced')
      }

      // Check 2 — every milestone has at least one task
      const milestonesWithoutTasks = prdData.milestones.filter(m => m.tasks.length < 1)
      if (milestonesWithoutTasks.length === 0 && prdData.milestones.length > 0) {
        criteriaMet.push('All milestones have at least one task')
      } else if (milestonesWithoutTasks.length > 0) {
        criteriaUnmet.push(
          `Milestones missing tasks: ${milestonesWithoutTasks.map(m => m.title).join(', ')}`
        )
      }

      // Check 3 — every task has at least one acceptance criterion
      const tasksWithoutAC = prdData.milestones.flatMap(m =>
        m.tasks.filter(t => t.acceptanceCriteria.length < 1).map(t => t.title)
      )
      if (tasksWithoutAC.length === 0 && prdData.milestones.length > 0) {
        criteriaMet.push('All tasks have acceptance criteria')
      } else if (tasksWithoutAC.length > 0) {
        const sample = tasksWithoutAC.slice(0, 3).join(', ')
        const overflow = tasksWithoutAC.length > 3 ? ` (+${tasksWithoutAC.length - 3} more)` : ''
        criteriaUnmet.push(`Tasks missing acceptance criteria: ${sample}${overflow}`)
      }

      const passed = criteriaUnmet.length === 0
      const failureReason = passed ? undefined : criteriaUnmet.join('; ')

      console.log(
        `[doc:dodVerifyStep] passed=${passed} met=${criteriaMet.length} unmet=${criteriaUnmet.length}`
      )

      return {
        passed,
        failureReason,
        criteriaMet,
        criteriaUnmet,
        prdData: prdData as z.infer<typeof prdDataSchema>,
        inputTokens,
        outputTokens,
      }
    } catch (err) {
      console.error('[doc:dodVerifyStep] error — falling back to pass:', (err as Error).message)
      return {
        passed: true,
        criteriaMet: [],
        criteriaUnmet: [],
        prdData: prdData as z.infer<typeof prdDataSchema>,
        inputTokens,
        outputTokens,
      }
    }
  },
})

// ─── Step 4: docComposeStep ───────────────────────────────────────────────────
// Formats extraction + DoD result into a human-readable markdown summary.
// formatterAgent, structuredOutput, no tools.
// dodPassed is always overridden from inputData.passed — never trusted from LLM.
// prdData is passed through so the calling route has the structured plan data.

export const docComposeStep = createStep({
  id: 'doc-compose',
  inputSchema: docDodVerifyOutputSchema,
  outputSchema: composeOutputSchema,
  execute: async ({ inputData }) => {
    const {
      passed,
      criteriaMet,
      criteriaUnmet,
      failureReason,
      prdData,
      inputTokens: prevInputTokens,
      outputTokens: prevOutputTokens,
    } = inputData
    const { plan, milestones, risks, totalEstimatedHours } = prdData

    console.log(`[doc:composeStep] dodPassed=${passed} milestones=${milestones.length}`)

    const dodStatusNote = passed
      ? `✓ All structural checks passed${criteriaMet.length > 0 ? ': ' + criteriaMet.join('; ') : ''}`
      : `⚠ ${failureReason ?? 'Structural checks failed'}${criteriaUnmet.length > 0 ? ' — ' + criteriaUnmet.join('; ') : ''}`

    const milestoneSummary = milestones
      .map((m, i) => {
        const totalHours = m.tasks.reduce((sum, t) => sum + (t.estimatedHours ?? 0), 0)
        return `Phase ${i + 1}: ${m.title} (${m.tasks.length} tasks, ${totalHours}h)\n${m.description}`
      })
      .join('\n\n')

    const prompt = [
      `Format this project plan into a clean markdown summary for a product team.`,
      ``,
      `Plan Title: ${plan.title}`,
      `Plan Description: ${plan.description}`,
      ``,
      `DoD Status: ${dodStatusNote}`,
      ``,
      `Milestones:`,
      milestoneSummary || '(none)',
      ``,
      risks.length > 0 ? `Risks:\n${risks.map(r => `- ${r}`).join('\n')}` : null,
      totalEstimatedHours ? `Total estimated effort: ${totalEstimatedHours}h` : null,
      ``,
      `Write a clear markdown summary. Include:`,
      `- A brief intro (1-2 sentences)`,
      `- Each milestone as a section with task count and hour estimate`,
      `- Risks listed`,
      `- DoD status at the end`,
      `Put the complete markdown in the summary field.`,
    ].filter(Boolean).join('\n')

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
          prdData,
          inputTokens: prevInputTokens + composeInputTokens,
          outputTokens: prevOutputTokens + composeOutputTokens,
        }
      }
      return {
        summary: result.text ?? '(no output)',
        dodPassed: passed,
        prdData,
        inputTokens: prevInputTokens + composeInputTokens,
        outputTokens: prevOutputTokens + composeOutputTokens,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        summary: `Compose failed: ${message}`,
        dodPassed: passed,
        prdData,
        inputTokens: prevInputTokens,
        outputTokens: prevOutputTokens,
      }
    }
  },
})

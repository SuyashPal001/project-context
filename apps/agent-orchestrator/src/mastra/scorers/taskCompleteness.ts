import { createScorer } from '@mastra/core/evals'
import { generateText } from 'ai'

import { platformModel } from '../model.js'

// ─── taskCompletenessScorer ───────────────────────────────────────────────────
// Heuristic pass checks for the four required task breakdown elements in the output.
// LLM judge produces a one-sentence reason explaining what was present or missing.
// Registered on the Mastra instance (scorers tab) and on taskAgent directly.

const REQUIRED_ELEMENTS = ['task', 'acceptance', 'estimated', 'milestone']

export const taskCompletenessScorer = createScorer({
  id: 'task-completeness',
  description: 'Checks if the task breakdown output contains all required elements: tasks, acceptance criteria, estimated hours, and milestone references.',
})
  .generateScore(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (run.output as any)?.text ?? JSON.stringify(run.output)
    const lower = output.toLowerCase()
    const found = REQUIRED_ELEMENTS.filter(e => lower.includes(e)).length
    return found / REQUIRED_ELEMENTS.length
  })
  .generateReason(async ({ run, score }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (run.output as any)?.text ?? JSON.stringify(run.output)
    const lower = output.toLowerCase()
    const present = REQUIRED_ELEMENTS.filter(e => lower.includes(e))
    const missing = REQUIRED_ELEMENTS.filter(e => !lower.includes(e))
    const result = await generateText({
      model: platformModel,
      prompt: `You are a task breakdown quality reviewer. Score: ${score.toFixed(2)}\n\nPresent elements: ${present.join(', ') || 'none'}. Missing elements: ${missing.join(', ') || 'none'}.\n\nIn one sentence, explain which required task breakdown elements (tasks, acceptance criteria, estimated hours, milestone references) were present and which were missing.\n\nOutput excerpt:\n${output.slice(0, 2000)}`,
    })
    return result.text || 'No reason generated'
  })

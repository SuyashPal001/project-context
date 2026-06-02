import { createScorer } from '@mastra/core/evals'

import { saarthiModel } from '../model.js'

// ─── prdCompletenessScorer ─────────────────────────────────────────────────────
// LLM-as-judge scorer: heuristic pass for speed, LLM judge for the reason.
// Checks whether all six required PRD sections are present in the output.
// Registered on the Mastra instance (scorers tab) and on prdAgent directly.

export const prdCompletenessScorer = createScorer({
  id: 'prd-completeness',
  description: 'Checks if the PRD output contains all required sections: problem statement, goals, user stories, functional requirements, non-functional requirements, and success metrics.',
})
  .generateScore(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (run.output as any)?.text ?? JSON.stringify(run.output)
    const sections = [
      'problem statement',
      'goal',
      'user stor',
      'functional requirement',
      'non-functional requirement',
      'success metric',
    ]
    const lower = output.toLowerCase()
    const found = sections.filter(s => lower.includes(s)).length
    // Quick heuristic pass — LLM judge below refines the reason
    return found / sections.length
  })
  .generateReason(async ({ run, score }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (run.output as any)?.text ?? JSON.stringify(run.output)
    const result = await saarthiModel.doGenerate({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a PRD quality reviewer. Score: ${score.toFixed(2)}\n\nReview this PRD output and explain in one sentence which required sections are present and which are missing. Required sections: Problem Statement, Goals, User Stories, Functional Requirements, Non-Functional Requirements, Success Metrics.\n\nPRD output:\n${output.slice(0, 2000)}`,
            },
          ],
        },
      ],
    })
    const text = result.text ?? result.rawCall?.rawPrompt ?? 'No reason generated'
    return typeof text === 'string' ? text : JSON.stringify(text)
  })

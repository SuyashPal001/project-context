import { createScorer } from '@mastra/core/evals'

// ─── dodPassScorer ────────────────────────────────────────────────────────────
// Binary 0/1 scorer that reads dodPassed from composeStep output.
// Uses builder pattern: generateScore + generateReason.
// Registered on Mastra instance so scores appear in Studio Scorers tab.

export const dodPassScorer = createScorer({
  id: 'dod-pass',
  description: 'Whether the workflow output met the Definition of Done',
})
  .generateScore(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (run.output as any)?.dodPassed ?? true
    return passed ? 1 : 0
  })
  .generateReason(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = (run.output as any)?.dodPassed ?? true
    return passed ? 'DoD passed' : 'DoD failed'
  })

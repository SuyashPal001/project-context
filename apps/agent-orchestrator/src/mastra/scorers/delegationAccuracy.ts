import { createScorer } from '@mastra/core/evals'

// ─── delegationAccuracyScorer ─────────────────────────────────────────────────
// Heuristic scorer: checks whether pmAgent delegated to a specialist agent
// instead of generating content itself. Looks for delegation signal words
// in the output text.

const DELEGATION_SIGNALS = ['prdagent', 'roadmapagent', 'taskagent', 'delegat']

export const delegationAccuracyScorer = createScorer({
  id: 'delegation-accuracy',
  description: 'Checks whether pmAgent delegated to a specialist agent instead of generating content itself.',
})
  .generateScore(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = ((run.output as any)?.text ?? JSON.stringify(run.output)).toLowerCase()
    const found = DELEGATION_SIGNALS.some(s => output.includes(s))
    return found ? 1 : 0
  })
  .generateReason(async ({ run, score }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = ((run.output as any)?.text ?? JSON.stringify(run.output)).toLowerCase()
    const signal = DELEGATION_SIGNALS.find(s => output.includes(s))
    if (score === 1) {
      return `Delegation signal found: "${signal}" indicates pmAgent handed off to a specialist.`
    }
    return `No delegation signal found in output — pmAgent may have generated content directly instead of delegating.`
  })

import { createScorer } from '@mastra/core/evals'

// ---------------------------------------------------------------------------
// findingFaithfulnessScorer
// Checks whether the finding narration matches the deterministic rule verdict.
// A `fail` finding should describe a discrepancy; a `pass` should not.
// Score 0.0–1.0 = fraction of findings where narration matches verdict.
// ---------------------------------------------------------------------------

const FAIL_SIGNALS = ['discrepan', 'mismatch', 'does not match', 'exceeds', 'below minimum', 'not met', 'shortfall', 'less than', 'greater than', 'incorrect']
const PASS_SIGNALS = ['complies', 'correct', 'verified', 'confirmed', 'meets', 'within', 'satisfied', 'no discrepancy', 'in order']

export const findingFaithfulnessScorer = createScorer({
  id: 'finding-faithfulness',
  description: 'Checks whether the pension finding narration faithfully reflects the deterministic rule verdict (pass/fail). Score = fraction of faithful findings.',
})
  .generateScore(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings: any[] = (run.output as any)?.findings ?? []
    if (!findings.length) return 1

    const faithful = findings.filter((f: any) => {
      const narr = (f.narration ?? '').toLowerCase()
      const hasFailSignal = FAIL_SIGNALS.some(s => narr.includes(s))
      const hasPassSignal = PASS_SIGNALS.some(s => narr.includes(s))
      if (f.status === 'fail') return hasFailSignal
      if (f.status === 'pass') return hasPassSignal || !hasFailSignal
      return true // cannot_evaluate — neutral
    }).length

    return faithful / findings.length
  })
  .generateReason(async ({ run, score }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings: any[] = (run.output as any)?.findings ?? []
    const faithful = Math.round(score * findings.length)
    return `${faithful}/${findings.length} findings (${(score * 100).toFixed(0)}%) have narrations that faithfully reflect the deterministic verdict.`
  })

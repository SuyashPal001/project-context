import { createScorer } from '@mastra/core/evals'

// ─── clarityBeforeDelegateScorer ──────────────────────────────────────────────
// Heuristic scorer: checks whether pmAgent asked a clarifying question when
// the user request was vague (< 50 chars). Detailed requests (>= 50 chars)
// automatically pass — clarification is not expected.

const VAGUE_THRESHOLD = 50

export const clarityBeforeDelegateScorer = createScorer({
  id: 'clarity-before-delegate',
  description: 'Checks whether pmAgent asked a clarifying question when the user request was vague.',
})
  .generateScore(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = (run.input as any)?.text ?? JSON.stringify(run.input)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (run.output as any)?.text ?? JSON.stringify(run.output)
    const isVague = input.length < VAGUE_THRESHOLD
    if (!isVague) return 1
    return output.includes('?') ? 1 : 0
  })
  .generateReason(async ({ run, score }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = (run.input as any)?.text ?? JSON.stringify(run.input)
    const isVague = input.length < VAGUE_THRESHOLD
    if (!isVague) {
      return `Input was detailed (${input.length} chars) — no clarification required before delegation.`
    }
    if (score === 1) {
      return `Input was vague (${input.length} chars) and pmAgent asked a clarifying question before delegating.`
    }
    return `Input was vague (${input.length} chars) but pmAgent did not ask a clarifying question before delegating.`
  })

import { createScorer } from '@mastra/core/evals'

// ---------------------------------------------------------------------------
// citationGroundingScorer
// Checks whether each pension finding cites a valid CCS rule ID (R001–R005)
// and has at least one source document referenced.
// Score 0.0–1.0 = fraction of findings that are fully grounded.
// ---------------------------------------------------------------------------

const VALID_RULES = new Set(['R001', 'R002', 'R003', 'R004', 'R005'])

export const citationGroundingScorer = createScorer({
  id: 'citation-grounding',
  description: 'Checks if each pension finding cites a valid CCS rule ID (R001–R005) and a source document. Score = fraction of grounded findings.',
})
  .generateScore(async ({ run }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings: any[] = (run.output as any)?.findings ?? []
    if (!findings.length) return 0

    const grounded = findings.filter((f: any) =>
      VALID_RULES.has(f.ruleId) &&
      (f.sources?.length > 0 || f.provision?.length > 0)
    ).length

    return grounded / findings.length
  })
  .generateReason(async ({ run, score }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings: any[] = (run.output as any)?.findings ?? []
    const grounded = findings.filter((f: any) =>
      VALID_RULES.has(f.ruleId) && (f.sources?.length > 0 || f.provision?.length > 0)
    ).length
    return `${grounded}/${findings.length} findings (${(score * 100).toFixed(0)}%) have a valid CCS rule ID and source document citation.`
  })

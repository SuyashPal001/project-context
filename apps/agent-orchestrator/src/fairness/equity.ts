// FREE-AI Sutra 1 — EquityCheck
// Captures response quality metrics per turn for plan-equity drift analysis.
// Always passes — this is a metrics recorder, not a gate.

export interface EquityMetrics {
  checkId: 'plan_equity'
  status: 'pass'
  responseLength: number
  toolsUsed: number
  detail: string
}

const LENGTH_THRESHOLDS = { minimal: 50, adequate: 200 }

export function captureEquityMetrics(responseLength: number, toolsUsed: number): EquityMetrics {
  let quality: string
  if (responseLength < LENGTH_THRESHOLDS.minimal) quality = 'minimal'
  else if (responseLength < LENGTH_THRESHOLDS.adequate) quality = 'brief'
  else quality = 'adequate'

  return {
    checkId: 'plan_equity',
    status: 'pass',
    responseLength,
    toolsUsed,
    detail: `Response quality: ${quality} (${responseLength} chars, ${toolsUsed} tool(s) used).`,
  }
}

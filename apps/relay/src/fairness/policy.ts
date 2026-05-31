// FREE-AI Sutra 1 — PolicyCheck
// Scans LLM output for RBI-regulated content violations and prohibited speech.

export interface PolicyCheckResult {
  checkId: 'policy_compliance'
  status: 'pass' | 'warn' | 'fail'
  violations: string[]
  detail: string
}

const PATTERNS: Array<{ pattern: RegExp; label: string; severity: 'warn' | 'fail' }> = [
  {
    pattern: /\bguaranteed\b.{0,40}\b(returns?|profit|gains?|interest|growth)\b/i,
    label: 'guaranteed_returns',
    severity: 'fail',
  },
  {
    pattern: /\b(100%|certain(ly)?|definitely|absolutely)\b.{0,40}\b(safe|no.?risk|risk.?free|profit(able)?)\b/i,
    label: 'misleading_certainty',
    severity: 'fail',
  },
  {
    pattern: /\byou (should|must|have to|need to) (invest|buy|purchase|sell|trade)\b/i,
    label: 'direct_investment_advice',
    severity: 'warn',
  },
  {
    pattern: /\b(launder|money.?laundering|tax.?evasion|evade tax|black.?money|hawala|round.?tripping)\b/i,
    label: 'illegal_financial_activity',
    severity: 'fail',
  },
  {
    pattern: /\b(ponzi|pyramid scheme|mlm scheme|get.?rich.?quick)\b/i,
    label: 'fraudulent_scheme',
    severity: 'fail',
  },
  {
    // Hindi/regional profanity and slurs — patterns kept minimal, regex non-graphical
    pattern: /\b(mc\b|bc\b|bhosd|chutiy|haramz|randi|kamina\s+teri)/i,
    label: 'profanity_slur',
    severity: 'fail',
  },
]

export function checkPolicyCompliance(text: string): PolicyCheckResult {
  const violations: string[] = []
  let maxSeverity: 'pass' | 'warn' | 'fail' = 'pass'

  for (const { pattern, label, severity } of PATTERNS) {
    if (pattern.test(text)) {
      violations.push(label)
      if (severity === 'fail') maxSeverity = 'fail'
      else if (severity === 'warn' && maxSeverity === 'pass') maxSeverity = 'warn'
    }
  }

  return {
    checkId: 'policy_compliance',
    status: maxSeverity,
    violations,
    detail: violations.length === 0
      ? 'Response complies with content policy.'
      : `Violations: ${violations.join(', ')}`,
  }
}

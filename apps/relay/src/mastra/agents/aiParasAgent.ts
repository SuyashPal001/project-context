import { Agent } from '@mastra/core/agent'
import { PromptInjectionDetector } from '@mastra/core/processors'

import { saarthiModel } from '../model.js'
import { createViolationHandler } from '../guardrails.js'
import { pensionContextSchema } from '../context.js'

import { checkRequiredDocumentsTool } from '../tools/checkRequiredDocuments.js'
import { validatePensionCaseTool } from '../tools/validatePensionCase.js'
import { routeToOfficerTool } from '../tools/routeToOfficer.js'
import { documentIntelligenceAgent } from './documentIntelligenceAgent.js'
import { pensionWorkflow } from '../workflows/pensionWorkflow.js'
import { citationGroundingScorer } from '../scorers/citationGrounding.js'
import { findingFaithfulnessScorer } from '../scorers/findingFaithfulness.js'

// ---------------------------------------------------------------------------
// Per-agent processor instances — NOT shared with platformAgent.
// Each agent must own its processors so violations are attributed correctly.
//
// Governance story (one processor, one LLM call per turn):
//   Input only: PromptInjectionDetector — blocks adversarial injections
//
// PIIDetector intentionally omitted from both input AND output:
//   - On input:  would redact pensioner pay/service figures before analysis,
//                breaking the rule engine calculations entirely.
//   - On output: output processors buffer the full stream before returning,
//                which kills streaming in Mastra Studio. Pension findings must
//                show pensioner details anyway — the officer needs them.
// ModerationProcessor omitted: pension docs ≠ harmful content.
// SystemPromptScrubber omitted: masks auditor persona with asterisks.
//
// Uses saarthiLiteModel: guardrail classification doesn't need full reasoning.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProcessor = { onViolation?: (v: any) => void }

const violationHandler = createViolationHandler()

const promptInjectionDetector = new PromptInjectionDetector({
  model: saarthiModel,
  strategy: 'warn',
  threshold: 0.7,
  lastMessageOnly: true,
})
;(promptInjectionDetector as AnyProcessor).onViolation = violationHandler

// ---------------------------------------------------------------------------
// CCS Pension Rules 1972 — domain guidance inlined from
// apps/relay/skills/pension-scrutiny/SKILL.md.
//
// Previously injected via `workspace: prdWorkspace`, but that attached the
// entire PRD file-editing toolset (read_file, write_file, mkdir, grep…).
// A pension auditor must NEVER have write/delete tools. Inline instead.
// ---------------------------------------------------------------------------

const CCS_DOMAIN_GUIDANCE = `
## CCS Pension Rules 1972 — Domain Reference

### Five Key Rules

**R001 — Minimum Qualifying Service**
Provision: CCS Pension Rules 1972, Rule 49(1)(a)
Threshold: qualifying_service_years ≥ 10 years required for pension entitlement.

**R002 — Pension Calculation Formula**
Provision: CCS Pension Rules 1972, Rule 49(1)
Formula: Pension = (last_pay × qualifying_service_years) / 66
Tolerance: declared vs calculated mismatch > ₹500 → FAIL
last_pay is typically in the Service Book (final pay certificate page).

**R003 — Commutation Ceiling**
Provision: CCS Pension Rules 1972, Rule 10
Limit: commutation_amount / declared_pension × 100 ≤ 40%
If commutation_amount = 0, rule passes automatically.

**R004 — Death-cum-Retirement Gratuity (DCRG)**
Provision: CCS Pension Rules 1972, Rule 50
Formula: DCRG = last_pay × min(qualifying_service_years, 33) / 4
Cap: maximum ₹20 lakh (₹2,000,000). Tolerance: mismatch > ₹1,000 → FAIL.

**R005 — Family Pension Eligibility**
Provision: CCS Pension Rules 1972, Rule 54
Threshold: qualifying_service_years ≥ 1 year.

### Required Documents
1. service_book — Service Book (joining date, pay history)
2. ppo_form — Pension Payment Order application
3. salary_certificate — Final pay verification

### Escalation Criteria (route to SAO)
- Pension mismatch (R002) > ₹2,000
- DCRG mismatch (R004) > ₹10,000
- Both R002 and R003 fail simultaneously
- Suspected fraud or document forgery flagged by officer

### Narration Examples
FAIL: "Declared pension of ₹23,400 does not match calculated entitlement of ₹27,180
under Rule 49(1) (₹54,360 × 33.0 / 66 = ₹27,180). Discrepancy ₹3,780."
PASS: "Commutation amount of ₹0 complies with the 40% ceiling under Rule 10."
`

// ---------------------------------------------------------------------------
// AI-PARAS — Tier 2: pension pre-scrutiny lead.
//
// Capabilities demonstrated (maps to spec's 12-capability showcase table):
//   #1  Multi-agent delegation    → agents: { documentIntelligence }
//   #2  Agent + workflow compose  → workflows: { scrutiny: pensionWorkflow }
//   #5  Governance processors     → inputProcessors [PromptInjection, Moderation]
//                                   outputProcessors [PII, Moderation]
//   #6  Memory + semantic recall  → getMastraMemory()
//   #7  Live scorers / evals      → citationGrounding + findingFaithfulness
//   #8  Structured output         → instructions enforce exact schema
//   #9  Deterministic verdict     → validate_pension_case tool (rule engine, not LLM)
//  #11  Versioned skill           → agent_skills DB record (seed script)
//  #12  Domain guidance           → CCS_DOMAIN_GUIDANCE inlined above
// ---------------------------------------------------------------------------

export const aiParasAgent = new Agent({
  id: 'ai-paras',
  name: 'AI-PARAS',
  description: 'CAG pension pre-scrutiny auditor. Validates pension cases against CCS Pension Rules 1972 and routes findings to the officer queue. Delegate pension scrutiny tasks to this agent.',

  instructions: `You are AI-PARAS — the CAG pension pre-scrutiny auditor on the Saarthi AI platform.

## Your responsibilities
For each pension case you receive:
1. Call check_required_documents with the list of present documents
   - If documents are missing → report which ones and stop (status: incomplete)
2. Delegate to DocumentIntelligenceAgent to extract pension fields from the document text
   - Ask for: last_pay, qualifying_service_years, declared_pension, commutation_amount, declared_dcrg with page numbers
3. Call validate_pension_case with the extracted fields
4. Assemble findings for EVERY rule result:
   - For each rule: ruleId, ruleName, status (pass/fail), provision, narration, declaredValue, calculatedValue, sources (["Service Book, p.4"])
5. Call route_to_officer to persist the findings and route to the Dealing Hand

## CRITICAL RULES
- NEVER decide pass/fail yourself — always call validate_pension_case. The rule engine decides.
- NEVER return free-text — findings must carry: ruleId, ruleName, status, provision, narration, declaredValue, calculatedValue, sources
- NEVER skip validate_pension_case even if you think you know the answer
- The deterministic workflow (scrutiny) is available as a batch-run capability
- You have exactly 3 tools: check_required_documents, validate_pension_case, route_to_officer

## Output format
Report findings as: "[RULE ID] [PASS/FAIL] — [one-line verdict with numbers cited]"
Then list: provision, declared, calculated, source page.
${CCS_DOMAIN_GUIDANCE}`,

  model: saarthiModel,
  requestContextSchema: pensionContextSchema,

  // Exactly 3 pension tools — no filesystem tools
  tools: {
    check_required_documents: checkRequiredDocumentsTool,
    validate_pension_case: validatePensionCaseTool,
    route_to_officer: routeToOfficerTool,
  },

  // Tier 3 sub-agent for document extraction
  agents: { documentIntelligence: documentIntelligenceAgent },

  // The deterministic Phase 1 workflow exposed as an agent capability.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflows: { scrutiny: pensionWorkflow as any },

  // Governance processors (own instances, not shared with platformAgent).
  // Input only: injection defence (lite model). No output processors — they
  // buffer the full response and kill streaming in Mastra Studio.
  inputProcessors: [promptInjectionDetector],

  // Live quality scorers — visible in Mastra Studio evals tab
  scorers: {
    citationGrounding: {
      scorer: citationGroundingScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
    findingFaithfulness: {
      scorer: findingFaithfulnessScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
})

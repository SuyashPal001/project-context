import { Agent } from '@mastra/core/agent'
import { ModerationProcessor, PIIDetector, PromptInjectionDetector, SystemPromptScrubber } from '@mastra/core/processors'

import { saarthiModel } from '../model.js'
import { getMastraMemory } from '../memory.js'
import { createViolationHandler } from '../guardrails.js'
import { prdWorkspace } from '../workspace/prdWorkspace.js'
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

const moderationProcessor = new ModerationProcessor({
  model: saarthiModel,
  strategy: 'warn',
  threshold: 0.5,
  lastMessageOnly: true,
})
;(moderationProcessor as AnyProcessor).onViolation = violationHandler

const piiDetector = new PIIDetector({
  model: saarthiModel,
  strategy: 'redact',
  redactionMethod: 'placeholder',
  lastMessageOnly: true,
})
;(piiDetector as AnyProcessor).onViolation = violationHandler

const systemPromptScrubber = new SystemPromptScrubber({
  model: saarthiModel,
})
;(systemPromptScrubber as AnyProcessor).onViolation = violationHandler

// ---------------------------------------------------------------------------
// AI-PARAS — Tier 2: pension pre-scrutiny lead.
//
// Capabilities demonstrated (maps to spec's 12-capability showcase table):
//   #1  Multi-agent delegation    → agents: { documentIntelligence }
//   #2  Agent + workflow compose  → workflows: { scrutiny: pensionWorkflow }
//   #5  Governance processors     → inputProcessors + outputProcessors (own instances)
//   #6  Memory + semantic recall  → getMastraMemory()
//   #7  Live scorers / evals      → citationGrounding + findingFaithfulness
//   #8  Structured output         → instructions enforce exact schema
//   #9  Deterministic verdict     → validate_pension_case tool (rule engine, not LLM)
//  #11  Versioned skill           → agent_skills DB record (seed script)
//  #12  Filesystem skill          → pension-scrutiny/ via prdWorkspace
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
   - Pass the document text and ask for: last_pay, qualifying_service_years, declared_pension, commutation_amount, declared_dcrg with page numbers
3. Call validate_pension_case with the extracted fields
4. Assemble findings for EVERY rule result:
   - For each rule: ruleId, ruleName, status (pass/fail), provision, narration, declaredValue, calculatedValue, sources (["Service Book, p.4"])
5. Call route_to_officer to persist the findings and route to the Dealing Hand

## CRITICAL RULES
- NEVER decide pass/fail yourself — always call validate_pension_case. The rule engine decides.
- NEVER return free-text — findings must have the exact fields: ruleId, ruleName, status, provision, narration, declaredValue, calculatedValue, sources
- NEVER skip validate_pension_case even if you think you know the answer
- The deterministic workflow (scrutiny) is available as a capability for batch runs

## Escalation criteria (refer to pension-scrutiny skill for details)
- Service < 10 years → incomplete entitlement (R001)
- Pension mismatch > ₹500 → automatic flag for SAO review
- Commutation > 40% → regulatory violation (R003)

## Output format
Report findings as: "[RULE ID] [PASS/FAIL] — [one-line verdict with numbers cited]"
Then list: provision, declared, calculated, source page.`,

  model: saarthiModel,
  memory: getMastraMemory(),
  workspace: prdWorkspace,
  requestContextSchema: pensionContextSchema,

  tools: {
    check_required_documents: checkRequiredDocumentsTool,
    validate_pension_case: validatePensionCaseTool,
    route_to_officer: routeToOfficerTool,
  },

  // Tier 3 sub-agent for document extraction
  agents: { documentIntelligence: documentIntelligenceAgent },

  // The deterministic Phase 1 workflow exposed as an agent capability.
  // Used for batch/fallback runs; the agent orchestrates for live demo runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflows: { scrutiny: pensionWorkflow as any },

  // Own governance processors — not inherited from platformAgent
  inputProcessors: [promptInjectionDetector, moderationProcessor],
  outputProcessors: [piiDetector, moderationProcessor, systemPromptScrubber],

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

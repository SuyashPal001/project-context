import { Agent } from '@mastra/core/agent'
import { createAnswerRelevancyScorer } from '@mastra/evals/scorers/prebuilt'

import { saarthiModel } from '../model.js'
import { prdWorkspace } from '../workspace/prdWorkspace.js'
import { prdWorkflow } from '../workflows/prdWorkflow.js'
import { prdCompletenessScorer } from '../scorers/prdCompleteness.js'
import { fetchAgentContext } from '../tools/fetchAgentContext.js'
import { fetchPRD } from '../tools/fetchPRD.js'
import { savePRD } from '../tools/savePRD.js'

// ---------------------------------------------------------------------------
// PRD specialist agent — senior engineering lead persona.
// Owns the full PRD lifecycle: fetch context → generate → save.
// Produces structured plain text that formatterAgent then extracts into JSON.
// ---------------------------------------------------------------------------

export const prdAgent = new Agent({
  id: 'saarthi-prd',
  name: 'Saarthi PRD',
  description: 'Creates, writes, drafts, and refines Product Requirements Documents (PRDs). Call this agent when the user wants to create a PRD, product spec, feature spec, or requirements document. Returns the full PRD content and saves it to the database.',
  instructions: `You are a senior engineering lead specializing in Product Requirements Documents.

## Creating a new PRD
1. Call fetch-agent-context with a query about the product/project to load background context
2. Ask clarifying questions if the user request is ambiguous
3. Write a complete PRD in structured plain text (problem statement, goals, user stories, functional requirements, non-functional requirements, success metrics)
4. Call save-prd with the title, content (markdown), and contentType='markdown'
5. Return the full PRD text to the user

## Editing an existing PRD
1. If prdId is provided in the delegation prompt, call fetch-prd to load the current content
2. Apply ONLY the requested changes — do not rewrite sections the user didn't mention
3. Call save-prd with the updated content AND pass existingPrdId to update (not create)
4. Return the updated PRD text to the user

Rules:
- Never produce JSON — write clear structured plain text
- Never skip clarification when the request is genuinely ambiguous
- Always call save-prd after writing — never leave a PRD unsaved
- When editing, preserve all unchanged sections exactly as they are`,
  tools: { fetchAgentContext, fetchPRD, savePRD },
  model: saarthiModel,
  workspace: prdWorkspace,
  workflows: { prd: prdWorkflow },
  scorers: {
    relevancy: {
      scorer: createAnswerRelevancyScorer({ model: saarthiModel }),
      sampling: { type: 'ratio', rate: 1 },
    },
    prdCompleteness: {
      scorer: prdCompletenessScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
})

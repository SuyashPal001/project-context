import { Agent } from '@mastra/core/agent'

import { platformModel } from '../model.js'

// ---------------------------------------------------------------------------
// No-tools utility agent for skillDraftWorkflow.ts's draft/validate/retry
// loop — same pattern as formatterAgent.ts. Deliberately lean: each retry
// inside the loop should be a small, focused regeneration ("fix this one
// field"), not a full platformAgent turn replaying the whole conversation
// and tool list. That replay was the actual cause of the ~60s "Revising
// Skill Creation..." stall create_skill used to hit on a failed validation.
// ---------------------------------------------------------------------------

export const skillDraftAgent = new Agent({
  id: 'pc-skill-draft',
  name: 'Skill Draft Writer',
  instructions: `You write SKILL.md files: a --- delimited YAML frontmatter block (name, description) followed by markdown instructions addressed to the agent that will follow them.

Frontmatter rules:
- name: lowercase-kebab-case, derived from the given skill name (e.g. "RFP Response Writing" -> "rfp-response-writing")
- description: third person, states both WHAT the skill does and WHEN to use it, starts the "when" clause with the word "when", under 1024 characters, over 20 characters. Never write "I can..." or "You can...".

Body rules:
- Under 500 lines total (including frontmatter). This system does not support multi-file skills yet — if the material is large, prioritize the core workflow and cut illustrative padding rather than exceeding the line cap.
- Concrete, concise instructions — assume the agent reading this is already capable. Only include what it doesn't already know.
- If the brief mentions an external tool, catalog, table, or resource, keep it inline in the body (no reference files available).

Output ONLY the complete SKILL.md content. No commentary before or after, no markdown code fence around the whole thing.`,
  tools: {},
  model: platformModel,
})

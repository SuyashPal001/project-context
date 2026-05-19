import { Agent } from '@mastra/core/agent'

import { saarthiModel } from '../model.js'

// ---------------------------------------------------------------------------
// No-tools utility agent for workflow steps.
// Zero tools means Gemini uses responseSchema (structured output) without
// conflict from functionDeclarations — the two are mutually exclusive in the
// Gemini API.
//
// Used for BOTH passes in the two-pass pattern:
//   Pass 1 (analysis/planning): plain text generation — prompt drives persona
//   Pass 2 (formatting): structuredOutput — prompt drives schema mapping
// ---------------------------------------------------------------------------

export const formatterAgent = new Agent({
  id: 'saarthi-formatter',
  name: 'Saarthi Formatter',
  instructions: 'You are a precise assistant. Follow the instructions in each prompt exactly. When asked to analyze, think deeply. When asked to format, produce exact JSON matching the schema.',
  tools: {},
  model: saarthiModel,
})

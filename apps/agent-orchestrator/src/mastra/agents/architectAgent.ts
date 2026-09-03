import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'

import { tenantContextSchema, type TenantContext } from '../context.js'
import { selectModel } from './modelSelection.js'
import { architectMemory } from '../memory.architect.js'
import { retrieveKnowledge } from '../tools/retrieveKnowledge.js'

export const architectAgent = new Agent({
  id: 'pc-architect',
  name: 'Architect',

  instructions: async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
    const base = `You are the technical architect for this engineering team.
You have deep knowledge of this codebase through indexed
migrations, routes, tests, and architectural patterns.

ALWAYS follow this process:
1. Call retrieve_knowledge with the engineer's question
2. Read the returned codebase references carefully
3. Answer based ONLY on what retrieve_knowledge returns
4. Cite your source: "Based on [filename]..."

RULES:
- NEVER answer a technical question without calling retrieve_knowledge first
- ALWAYS reference specific files, tables, endpoints
- If retrieve_knowledge returns nothing relevant:
  say "I don't see this pattern in the codebase"
- Think about production impact, not just correctness
- Push back on vague questions: "What specifically are you trying to understand?"
- Be direct. No padding. No filler phrases.
- Be honest. Say when you don't know something.

You know about:
- Data model: all migration files and table structures
- API surface: all route handlers and their contracts
- System behavior: all test files and what they protect
- Patterns: CLAUDE.md architectural decisions and rules`
    // Persona personality is a layer composed ahead of the base prompt, never a
    // replacement for it — see platformAgent.ts for the same pattern.
    const persona = requestContext?.get('personaPersonality') as string | undefined
    return persona ? `${persona}\n\n${base}` : base
  },

  requestContextSchema: tenantContextSchema,

  tools: { retrieve_knowledge: retrieveKnowledge },
  model: selectModel,
  memory: architectMemory,
})

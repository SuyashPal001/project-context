import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'

import { tenantContextSchema, type TenantContext } from '../context.js'
import { selectModel } from './modelSelection.js'
import { architectMemory } from '../memory.architect.js'
import { retrieveKnowledge } from '../tools/retrieveKnowledge.js'

const ARCHITECT_DESCRIPTION = 'Technical architect with full knowledge of this codebase — answers system-design and codebase questions by retrieving indexed migrations, routes, tests, and architectural patterns before answering.'

const architectInstructions = async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
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
}

export const architectAgent = new Agent({
  id: 'pc-architect',
  name: 'Architect',
  description: ARCHITECT_DESCRIPTION,
  instructions: architectInstructions,
  requestContextSchema: tenantContextSchema,
  tools: { retrieve_knowledge: retrieveKnowledge },
  model: selectModel,
  memory: architectMemory,
})

// Used only as Olmo's delegate (see mastra/agents/olmoDelegates.ts). No `memory`
// key — this is the canonical explanation the other three delegate variants
// (pm/director/producer) point back to. Read it before changing any of them.
//
// A delegated sub-agent's resource id is derived by Mastra from a
// model-writable tool field (`inputData.resourceId`), not the tenant's real
// resource id — MASTRA_RESOURCE_ID_KEY is stripped from the delegated context
// copy. Declaring `memory: architectMemory` here would give this variant its
// own resource-scoped working memory (`filesDiscussed`/`patternsConfirmed`)
// keyed off that model-writable id, which is the worst case in the set.
// Omitting `memory:` removes that path.
//
// It does NOT make the delegated call memory-inert — an earlier revision of
// this comment and of the design doc claimed it did, and that was wrong.
// Verified against @mastra/core 1.64: because the supervisor (Olmo) has memory
// and this variant does not, Mastra lends Olmo's Memory instance to the
// delegate and scopes it by that same model-influenced resource id. A
// delegated turn therefore still WRITES into Olmo's shared store under a
// resource id an injected instruction can steer. What keeps that from being a
// cross-tenant READ is the thread-scoped recall/working-memory pinned in
// mastra/memory.ts (plus Mastra's random suffix on the delegated thread id) —
// see the load-bearing note in getMastraMemory(). Standalone architectAgent
// above is unaffected either way: it keeps architectMemory in full.
export const architectAgentDelegate = new Agent({
  id: 'pc-architect-delegate',
  name: 'Architect',
  description: ARCHITECT_DESCRIPTION,
  instructions: architectInstructions,
  requestContextSchema: tenantContextSchema,
  tools: { retrieve_knowledge: retrieveKnowledge },
  model: selectModel,
})

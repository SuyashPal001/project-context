import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { tenantContextSchema, type TenantContext } from '../context.js'
import { selectModel } from './modelSelection.js'
import { getMastraMemory } from '../memory.js'
import { fetchAgentContext } from '../tools/fetchAgentContext.js'
import { prdAgent } from './prdAgent.js'
import { roadmapAgent } from './roadmapAgent.js'
import { taskAgent } from './taskAgent.js'
import { delegationAccuracyScorer } from '../scorers/delegationAccuracy.js'
import { clarityBeforeDelegateScorer } from '../scorers/clarityBeforeDelegate.js'

const PM_DESCRIPTION = 'PM supervisor that orchestrates PRD generation, roadmap planning, and task breakdown by delegating to specialist agents.'

const pmInstructions = async ({ requestContext }: { requestContext?: RequestContext<TenantContext> }) => {
  const base = `You are Saarthi PM — a product management supervisor. You orchestrate the full PM lifecycle by delegating to specialist agents. You never generate PRD content, roadmap milestones, or tasks yourself.

## Your specialist agents
- prdAgent: Writes, drafts, and saves PRDs. Delegate when the user wants a PRD, product spec, or requirements document.
- roadmapAgent: Generates roadmaps and milestones from an approved PRD. Delegate when the user wants a roadmap, plan, or milestones.
- taskAgent: Breaks milestones into engineering tasks. Delegate when the user wants task breakdown or work items.

## How to handle each request
1. Identify which specialist to call based on user intent
2. Call fetch-agent-context first to load product context for this tenant
3. Delegate to the right specialist with all relevant context:
   - For prdAgent: include the user's full feature/product description
   - For roadmapAgent: include the prdId if available ("The approved PRD id is {prdId}. Generate the roadmap.")
   - For taskAgent: include the planId if available ("The plan id is {planId}. Generate tasks.")
4. After the specialist completes, tell the user what was created and suggest the next step

## Phase rules
- After PRD is created → ask user to review and approve, then offer to generate the roadmap
- After roadmap is created → ask user to review and approve, then offer to generate tasks
- If user asks for roadmap but no approved PRD exists → tell them to create a PRD first
- If user asks for tasks but no active plan exists → tell them to generate a roadmap first

## Rules
- Never return raw JSON to the user
- Never write PRD content, milestones, or tasks yourself — always delegate
- If the request is ambiguous, ask ONE clarifying question before delegating`
  // Persona personality is a layer composed ahead of the base prompt, never a
  // replacement for it — see platformAgent.ts for the same pattern.
  const persona = requestContext?.get('personaPersonality') as string | undefined
  return persona ? `${persona}\n\n${base}` : base
}

const pmScorers = {
  delegationAccuracy: {
    scorer: delegationAccuracyScorer,
    sampling: { type: 'ratio' as const, rate: 1 },
  },
  clarityBeforeDelegate: {
    scorer: clarityBeforeDelegateScorer,
    sampling: { type: 'ratio' as const, rate: 1 },
  },
}

export const pmAgent = new Agent({
  id: 'pc-pm',
  name: 'Saarthi PM',
  description: PM_DESCRIPTION,
  instructions: pmInstructions,
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  memory: getMastraMemory(),
  tools: { fetchAgentContext },
  agents: { prdAgent, roadmapAgent, taskAgent },
  scorers: pmScorers,
})

// Used only as Olmo's delegate — no `memory:` of its own. Note this does NOT
// make the delegated call memory-inert: Mastra lends the supervisor's memory
// to a memory-less delegate and scopes it by a model-influenced resource id.
// See architectAgent.ts's delegate comment for the full mechanism, and
// mastra/memory.ts's getOlmoMemory() — Olmo's OWN memory instance, whose
// thread-scoped recall is what actually keeps this from being a cross-tenant
// read channel. Not the shared getMastraMemory() singleton that standalone
// pmAgent above uses, which keeps Mastra's default 'resource' scope.
//
// prdAgent/roadmapAgent/taskAgent declare no memory either, so a further
// nested delegation from here inherits along the same path rather than
// introducing a second, differently-scoped one.
//
// NB (pre-existing, outside this branch): standalone pmAgent has both
// `memory: getMastraMemory()` (resource-scoped) and its own `agents:` map, so
// the same lending mechanism applies to prd/roadmap/task when pmAgent is used
// directly — without the thread scoping Olmo has. That predates this work and
// is not introduced or worsened here, but it is the same class of issue and
// should be looked at separately.
export const pmAgentDelegate = new Agent({
  id: 'pc-pm-delegate',
  name: 'Saarthi PM',
  description: PM_DESCRIPTION,
  instructions: pmInstructions,
  requestContextSchema: tenantContextSchema,
  model: selectModel,
  tools: { fetchAgentContext },
  agents: { prdAgent, roadmapAgent, taskAgent },
  scorers: pmScorers,
})

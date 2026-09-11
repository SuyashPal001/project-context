import { z } from 'zod'
import type { MCPClient } from '@mastra/mcp'

// Shared request context schema for all tenant-scoped agents
// Add new fields here as needed — import in every agent
export const tenantContextSchema = z.object({
  tenantId: z.string().optional().default(''),
  agentId:  z.string().optional().default(''),
  userId:   z.string().optional().default(''),
  // Set by fetchAgentName() at each call site — the conversation's bound
  // agent row name (e.g. "Olmo"), lowercased-compared to gate delegation so
  // it only activates for the Olmo row, not every row falling through to
  // platformAgent's fallback. See mastra/agents/olmoDelegates.ts.
  agentName: z.string().optional(),
  // Set by fetchAgentContext.ts after a retrieve call; read by selectModel to
  // force private-only routing for restricted (CASA/KYC) content.
  maxDataSensitivity: z.string().optional(),
  // Set by chatStream.ts from the chat UI's model picker; read by selectModel.
  selectedModel: z.string().optional(),
  // Set per-request to pick lite vs full model for conversational turns.
  thinkingBudget: z.number().optional(),
  // Persona layer composed ahead of the base prompt — see platformAgent.ts.
  personaPersonality: z.string().optional(),
  // Per-agent skill override for the base prompt — set by chatStream.ts.
  agentSystemPrompt: z.string().optional(),
  // Set by chatStream.ts for Test-in-chat conversations (see fetchConversationTestSkillInstallId);
  // read by platformAgent.ts's skills resolver to compose just that one skill.
  testSkillInstallId: z.string().optional(),
  // Install ids of every skill turned on in this conversation with "/",
  // already resolved against this tenant's active installs. Set by
  // chatStream.ts on Olmo's turns; read by platformAgent's skills resolver.
  invokedSkillInstallIds: z.array(z.string()).optional(),
  // Mastra skill names (toMastraSkillName) turned on by THIS message. Drives
  // the forced skill-tool steps and the instruction line naming them; empty
  // on every later turn of the conversation.
  skillsInvokedThisTurn: z.array(z.string()).optional(),
  // Live conversation id, carried for tool-call logging.
  sessionId: z.string().optional(),
  // How many delegation boundaries this run is below the user-facing agent.
  // Stamped by onDelegationStart (subagents/hooks.ts) onto the outgoing
  // context; read by resolveDelegates to return {} at the host's ceiling.
  // Defence in depth, not a live loop guard. Mastra copies the parent's
  // context into the sub-agent almost wholesale (agent-Dp3vcrIx.cjs:35119
  // excludes only four internal keys), so depth survives the boundary. Today
  // only platformAgent resolves its delegates dynamically (buildOlmoDelegates);
  // every delegate has a static or empty `agents:` map and never calls the
  // resolver, so none can loop back through Olmo's map. Depth is what caps
  // nesting on the day a delegate first declares its own dynamic `agents:`
  // resolver.
  delegationDepth: z.number().optional(),
  // The sub-agent ids this tenant may use. Filled upstream by an ownership
  // query today and by an install query when sharing ships — the resolver
  // does not change either way. Unset means "unconfigured": fail open.
  allowedSubAgents: z.array(z.string()).optional(),
  // The delegate's spec id, stamped by onDelegationStart (subagents/hooks.ts)
  // alongside the agentName rewrite. `agentId` deliberately keeps the HOST's
  // real UUID — see the comment in hooks.ts on why it is not overwritten —
  // so this is where a delegate-scoped skills resolver (none exists yet)
  // would read which delegate it's running as.
  subAgentId: z.string().optional(),
  // Not JSON-serializable — a live client reference carried through context so
  // platformAgent.ts's tools resolver reuses the same instance instead of
  // creating a second one. RequestContext.toJSON() silently skips it.
  __mcpClient: z.custom<MCPClient>().optional(),
})

export type TenantContext = z.infer<typeof tenantContextSchema>

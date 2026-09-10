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
  // Live conversation id, carried for tool-call logging.
  sessionId: z.string().optional(),
  // How many delegation boundaries this run is below the user-facing agent.
  // Stamped by onDelegationStart (subagents/hooks.ts) onto the outgoing
  // context; read by resolveDelegates to return {} at the host's ceiling.
  // Load-bearing, not advisory: Mastra copies the parent's context into the
  // sub-agent almost wholesale (agent-Dp3vcrIx.cjs:35119 excludes only four
  // internal keys), so a delegate inherits agentName='olmo' and would
  // otherwise resolve Olmo's own delegate map and re-delegate in a circle.
  delegationDepth: z.number().optional(),
  // The sub-agent ids this tenant may use. Filled upstream by an ownership
  // query today and by an install query when sharing ships — the resolver
  // does not change either way. Unset means "unconfigured": fail open.
  allowedSubAgents: z.array(z.string()).optional(),
  // Not JSON-serializable — a live client reference carried through context so
  // platformAgent.ts's tools resolver reuses the same instance instead of
  // creating a second one. RequestContext.toJSON() silently skips it.
  __mcpClient: z.custom<MCPClient>().optional(),
})

export type TenantContext = z.infer<typeof tenantContextSchema>

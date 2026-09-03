import { z } from 'zod'
import type { MCPClient } from '@mastra/mcp'

// Shared request context schema for all tenant-scoped agents
// Add new fields here as needed — import in every agent
export const tenantContextSchema = z.object({
  tenantId: z.string().optional().default(''),
  agentId:  z.string().optional().default(''),
  userId:   z.string().optional().default(''),
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
  // Live conversation id, carried for tool-call logging.
  sessionId: z.string().optional(),
  // Not JSON-serializable — a live client reference carried through context so
  // platformAgent.ts's tools resolver reuses the same instance instead of
  // creating a second one. RequestContext.toJSON() silently skips it.
  __mcpClient: z.custom<MCPClient>().optional(),
})

export type TenantContext = z.infer<typeof tenantContextSchema>

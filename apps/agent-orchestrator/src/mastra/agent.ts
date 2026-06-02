import type { Agent } from '@mastra/core/agent'
import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context'
import type { MCPClient } from '@mastra/mcp'
import { getMCPClientForTenant } from './tools.js'
import { platformAgent } from './index.js'

// TenantAgentConfig — unchanged signature for backward compatibility.
// Instructions are now resolved dynamically from agentTemplates (via platformAgent)
// rather than passed in. The field is kept so callers don't need to change.
export interface TenantAgentConfig {
  tenantId: string
  agentId: string
  agentSlug: string
  instructions: string // retained for interface compat — platformAgent resolves from DB
  connectedProviders: string[]
  maxTokens?: number | null
  // Tool names from agent_skills.tools — gates which server tools are active.
  // null/undefined = all server tools enabled (default-open for existing agents).
  enabledTools?: string[] | null
}

export interface TenantAgentWithClient {
  agent: Agent
  mcpClient: MCPClient
}

// Creates a per-request context wrapping the singleton platformAgent.
//
// Rather than constructing a new Agent() per task (old behaviour), this function:
//   1. Builds a RequestContext stamped with tenantId + MASTRA_RESOURCE_ID_KEY
//      so Mastra's memory layer isolates threads by tenant automatically.
//   2. Creates an MCPClient for this tenant (scoped via x-tenant-id header).
//      The client is stored in requestContext so platformAgent's tools resolver
//      reuses it — avoiding a second MCPClient for the same task.
//   3. Returns a Proxy around platformAgent that injects the requestContext into
//      every generate() call. workflow.ts is unchanged; requestContext flows
//      through transparently.
//   4. Returns the mcpClient for disconnect() in workflow.ts finally block.
//
// This pattern satisfies the "MCPClient disconnect ownership" risk from the ADR:
// the singleton agent cannot own per-request client lifecycle, so the Proxy wrapper
// carries the client reference for callers that need to disconnect after the task.

export async function createTenantAgent(
  config: TenantAgentConfig
): Promise<TenantAgentWithClient> {
  // Build per-request RequestContext
  const requestContext = new RequestContext()
  // MASTRA_RESOURCE_ID_KEY takes precedence over client-provided values —
  // prevents attackers from hijacking another tenant's memory thread.
  requestContext.set(MASTRA_RESOURCE_ID_KEY, config.tenantId)
  // Custom keys read by platformAgent's dynamic tools resolver
  requestContext.set('tenantId', config.tenantId)
  requestContext.set('agentId', config.agentId)
  requestContext.set('enabledTools', config.enabledTools ?? null)

  // Create per-tenant MCPClient — scoped to this tenant via x-tenant-id header.
  // Stored in requestContext so platformAgent's tools resolver reuses the same
  // instance rather than creating a second one. MCPClient is not JSON-serializable;
  // RequestContext.toJSON() silently skips non-serializable values (safe).
  const mcpClient = getMCPClientForTenant(config.tenantId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestContext.set('__mcpClient', mcpClient as any)

  // Proxy wraps platformAgent and injects requestContext into generate() calls.
  // workflow.ts calls agent.generate(prompt, { memory, structuredOutput, ... })
  // without requestContext — the proxy adds it transparently.
  // All other Agent methods (getMemory, listTools, id, name, …) delegate directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentProxy = new Proxy(platformAgent, {
    get(target, prop, receiver) {
      if (prop === 'generate') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (messages: any, options: any = {}) => {
          return target.generate(messages, { ...options, requestContext })
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as Agent

  return { agent: agentProxy, mcpClient }
}

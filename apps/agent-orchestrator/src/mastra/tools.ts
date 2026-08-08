import { MCPClient } from '@mastra/mcp'

// Persistent per-tenant/agent MCPClient cache.
// SSE connection is kept alive — avoids reconnect + listTools() overhead on every request.
// All three headers are required by mcp-server:
//   x-internal-service-key — authenticates this process as platform infrastructure
//   x-tenant-id            — scopes tool credentials to this tenant
//   x-agent-id             — identifies the agent so its policy (block list and
//                            human-approval gate) can be evaluated. The MCP
//                            policy guard fails closed without it, so it is not
//                            optional: omitting it denies every tool call rather
//                            than silently waiving the policy.
//
// Cache key includes the agent, because two agents in one tenant may have
// different policies and must not share a client carrying the wrong header.
const mcpClientCache = new Map<string, MCPClient>()

export function getMCPClientForTenant(tenantId: string, agentId?: string): MCPClient {
  const cacheKey = `${tenantId}::${agentId ?? ''}`
  const existing = mcpClientCache.get(cacheKey)
  if (existing) return existing

  const client = new MCPClient({
    servers: {
      pcTools: {
        url: new URL(
          process.env.MCP_SERVER_HTTP_URL ??
          'http://localhost:3002/sse'
        ),
        requestInit: {
          headers: {
            'x-internal-service-key':
              process.env.INTERNAL_SERVICE_KEY ?? '',
            'x-tenant-id': tenantId,
            ...(agentId ? { 'x-agent-id': agentId } : {}),
          },
        },
      },
    },
  })

  mcpClientCache.set(cacheKey, client)
  console.log(`[mcp] created persistent client for tenant ${tenantId} agent ${agentId ?? 'none'}`)
  return client
}

export async function getToolsForTenant(
  tenantId: string,
  agentId?: string
): Promise<Record<string, Record<string, unknown>>> {
  const client = getMCPClientForTenant(tenantId, agentId)
  // listToolsets() returns tools grouped by server name
  // mcp-server uses x-tenant-id header to scope
  // credentials to this tenant
  const toolsets = await client.listToolsets()
  return toolsets
}

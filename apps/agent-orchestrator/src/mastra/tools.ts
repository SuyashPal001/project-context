import { MCPClient } from '@mastra/mcp'

// Persistent per-tenant MCPClient cache.
// SSE connection is kept alive — avoids reconnect + listTools() overhead on every request.
// Both headers required:
//   x-internal-service-key — auth against mcp-server
//   x-tenant-id            — scopes tool credentials to this tenant
const mcpClientCache = new Map<string, MCPClient>()

export function getMCPClientForTenant(tenantId: string): MCPClient {
  const existing = mcpClientCache.get(tenantId)
  if (existing) return existing

  const client = new MCPClient({
    servers: {
      saarthiTools: {
        url: new URL(
          process.env.MCP_SERVER_HTTP_URL ??
          'http://localhost:3002/sse'
        ),
        requestInit: {
          headers: {
            'x-internal-service-key':
              process.env.INTERNAL_SERVICE_KEY ?? '',
            'x-tenant-id': tenantId,
          },
        },
      },
    },
  })

  mcpClientCache.set(tenantId, client)
  console.log(`[mcp] created persistent client for tenant ${tenantId}`)
  return client
}

export async function getToolsForTenant(
  tenantId: string
): Promise<Record<string, Record<string, unknown>>> {
  const client = getMCPClientForTenant(tenantId)
  // listToolsets() returns tools grouped by server name
  // mcp-server uses x-tenant-id header to scope
  // credentials to this tenant
  const toolsets = await client.listToolsets()
  return toolsets
}

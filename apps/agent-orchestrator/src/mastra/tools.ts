import { MCPClient } from '@mastra/mcp'

// Two caching regimes, selected by whether a sessionId is supplied:
//
// 1. No sessionId (scheduled workflow runs — no live chat session to route an
//    approval request to anyway): persistent per-tenant/agent singleton, never
//    disconnected. Unchanged from the original design — avoids reconnect +
//    listTools() overhead, and there is no per-request value to vary.
//
// 2. sessionId supplied (interactive chat): one client per chat session, with
//    an `x-session-id` header so mcp-server can route a tool-call approval
//    request back to the right SSE channel (POST /mcp/approval-request).
//    mcp-server is stateless per-request and the persistent client's headers
//    are static for its whole lifetime, so a value that must vary per chat
//    session cannot ride on the persistent client — see the design discussion
//    in the personas/9-state-animation approval-flow fix for why header
//    mutation on a shared client was rejected (race between concurrent tabs
//    on the same tenant+agent).
//
// Session-scoped entries are evicted on SSE close/cancel (routes/chat.ts) and,
// as a backstop for connections that never get a clean close (crash, dropped
// network), by the idle sweep below.

interface CachedClient {
  client: MCPClient
  lastUsedAt: number
  sessionScoped: boolean
}

const mcpClientCache = new Map<string, CachedClient>()

const SESSION_IDLE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of mcpClientCache) {
    if (entry.sessionScoped && now - entry.lastUsedAt > SESSION_IDLE_TTL_MS) {
      mcpClientCache.delete(key)
      entry.client.disconnect().catch(() => undefined)
      console.log(`[mcp] evicted idle session client key=${key}`)
    }
  }
}, SWEEP_INTERVAL_MS).unref()

function cacheKeyFor(tenantId: string, agentId: string | undefined, sessionId: string | undefined): string {
  return sessionId ? `session::${sessionId}` : `tenant::${tenantId}::${agentId ?? ''}`
}

export function getMCPClientForTenant(
  tenantId: string,
  agentId?: string,
  sessionId?: string,
): MCPClient {
  const cacheKey = cacheKeyFor(tenantId, agentId, sessionId)
  const existing = mcpClientCache.get(cacheKey)
  if (existing) {
    existing.lastUsedAt = Date.now()
    return existing.client
  }

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
            ...(sessionId ? { 'x-session-id': sessionId } : {}),
          },
        },
      },
    },
  })

  mcpClientCache.set(cacheKey, { client, lastUsedAt: Date.now(), sessionScoped: Boolean(sessionId) })
  console.log(
    sessionId
      ? `[mcp] created per-session client sessionId=${sessionId} tenant=${tenantId} agent=${agentId ?? 'none'}`
      : `[mcp] created persistent client for tenant ${tenantId} agent ${agentId ?? 'none'}`
  )
  return client
}

/** Call when a chat SSE session closes — evicts and disconnects its dedicated MCPClient, if one was created. */
export function releaseMCPClientForSession(sessionId: string): void {
  const cacheKey = `session::${sessionId}`
  const entry = mcpClientCache.get(cacheKey)
  if (!entry) return
  mcpClientCache.delete(cacheKey)
  entry.client.disconnect().catch(() => undefined)
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

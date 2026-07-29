import { VercelAIToolSet } from 'composio-core'

// VercelAIToolSet returns { [key: string]: CoreTool } which is identical to
// the tool map format Mastra agents accept — no adapter needed.

const CACHE_TTL_MS = 5 * 60_000 // 5 minutes, same as MCP tool cache

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const composioCache = new Map<string, { tools: Record<string, any>; expiresAt: number }>()

let _toolset: VercelAIToolSet | null = null

function getComposioToolSet(): VercelAIToolSet {
  if (!_toolset) {
    _toolset = new VercelAIToolSet({ apiKey: process.env.COMPOSIO_API_KEY })
  }
  return _toolset
}

export function isComposioEnabled(): boolean {
  return process.env.COMPOSIO_ENABLED === 'true' && !!process.env.COMPOSIO_API_KEY
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getComposioTools(tenantId: string): Promise<Record<string, any>> {
  const cached = composioCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.tools

  const toolset = getComposioToolSet()

  // filterByAvailableApps: true — only returns tools for apps this tenant has connected.
  // Prevents the agent seeing tool stubs for unconnected apps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = await toolset.getTools(
    { filterByAvailableApps: true },
    tenantId,
  )

  composioCache.set(tenantId, { tools, expiresAt: Date.now() + CACHE_TTL_MS })
  console.log(`[composio] fetched ${Object.keys(tools).length} tools for tenant ${tenantId}`)
  return tools
}

export function invalidateComposioCache(tenantId: string): void {
  composioCache.delete(tenantId)
}

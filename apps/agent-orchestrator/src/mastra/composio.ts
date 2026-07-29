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

// --- Action allowlist -------------------------------------------------------
//
// Composio apps expose far more actions than an agent can choose between well:
// GitHub alone is 100+, Jira ~50. Every action's JSON schema is injected into
// the prompt on every turn (~200-500 tokens each), so an unfiltered tool map
// costs both money and tool-selection accuracy — models start mispicking past
// roughly 30-50 tools.
//
// So we curate. Grouped by app for readability, flattened to a Set for lookup.
// Keys are Composio action slugs exactly as they appear in the returned tool
// map. Adding a connector to the Composio catalog does NOT expose it to the
// agent — it must be listed here too.

const ALLOWED_ACTIONS_BY_APP: Record<string, string[]> = {
  gmail: [
    'GMAIL_SEND_EMAIL',
    'GMAIL_CREATE_EMAIL_DRAFT',
    'GMAIL_FETCH_EMAILS',
    'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    'GMAIL_REPLY_TO_THREAD',
  ],
  googlecalendar: [
    'GOOGLECALENDAR_CREATE_EVENT',
    'GOOGLECALENDAR_UPDATE_EVENT',
    'GOOGLECALENDAR_DELETE_EVENT',
    'GOOGLECALENDAR_FIND_EVENT',
    'GOOGLECALENDAR_FIND_FREE_SLOTS',
  ],
  github: [
    'GITHUB_CREATE_AN_ISSUE',
    'GITHUB_LIST_REPOSITORY_ISSUES',
    'GITHUB_GET_AN_ISSUE',
    'GITHUB_CREATE_AN_ISSUE_COMMENT',
    'GITHUB_LIST_PULL_REQUESTS',
    'GITHUB_GET_A_PULL_REQUEST',
    'GITHUB_CREATE_A_PULL_REQUEST',
  ],
  jira: [
    'JIRA_CREATE_ISSUE',
    'JIRA_UPDATE_ISSUE',
    'JIRA_GET_ISSUE',
    'JIRA_SEARCH_FOR_ISSUES_USING_JQL',
    'JIRA_ADD_COMMENT',
  ],
  slack: [
    'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
    'SLACK_LIST_ALL_CHANNELS',
    'SLACK_FETCH_CONVERSATION_HISTORY',
  ],
  linear: [
    'LINEAR_CREATE_LINEAR_ISSUE',
    'LINEAR_UPDATE_ISSUE',
    'LINEAR_LIST_LINEAR_ISSUES',
    'LINEAR_GET_LINEAR_ISSUE',
  ],
  notion: [
    'NOTION_CREATE_NOTION_PAGE',
    'NOTION_ADD_PAGE_CONTENT',
    'NOTION_FETCH_DATA',
    'NOTION_QUERY_DATABASE',
  ],
}

const ALLOWED_ACTIONS = new Set(Object.values(ALLOWED_ACTIONS_BY_APP).flat())

// Escape hatch: bypass the allowlist to see everything a tenant's connections
// expose. Useful when adding a connector and you need the real action slugs.
// Do not enable in production — it reinstates the full token cost.
function isAllowlistBypassed(): boolean {
  return process.env.COMPOSIO_ALLOWLIST_DISABLED === 'true'
}

// Tracks allowlist entries that never matched a real tool, so typos in the
// slugs above surface loudly instead of silently dropping a tool. Logged once
// per process per unmatched slug.
const warnedMissing = new Set<string>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAllowlist(tools: Record<string, any>, tenantId: string): Record<string, any> {
  const available = new Set(Object.keys(tools))

  const allowed = Object.fromEntries(
    Object.entries(tools).filter(([key]) => ALLOWED_ACTIONS.has(key))
  )

  const dropped = available.size - Object.keys(allowed).length
  if (dropped > 0) {
    console.log(
      `[composio] allowlist dropped ${dropped} of ${available.size} tools for tenant ${tenantId}`
    )
  }

  // An allowlisted action that isn't in the fetched map is either a slug typo
  // or an app this tenant hasn't connected. Only warn when at least one action
  // from the same app IS present — that narrows it to a likely typo.
  for (const [app, actions] of Object.entries(ALLOWED_ACTIONS_BY_APP)) {
    const appIsConnected = actions.some((a) => available.has(a))
    if (!appIsConnected) continue
    for (const action of actions) {
      if (available.has(action) || warnedMissing.has(action)) continue
      warnedMissing.add(action)
      console.warn(
        `[composio] allowlisted action ${action} not found in ${app} tools — check the slug`
      )
    }
  }

  return allowed
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getComposioTools(tenantId: string): Promise<Record<string, any>> {
  const cached = composioCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.tools

  const toolset = getComposioToolSet()

  // filterByAvailableApps: true — only returns tools for apps this tenant has connected.
  // Prevents the agent seeing tool stubs for unconnected apps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetched: Record<string, any> = await toolset.getTools(
    { filterByAvailableApps: true },
    tenantId,
  )

  // Second gate: narrow the tenant's connected apps down to curated actions.
  // Filtering here rather than via getTools({ actions }) keeps the behaviour
  // independent of SDK filter precedence and lets us report what was dropped.
  const tools = isAllowlistBypassed() ? fetched : applyAllowlist(fetched, tenantId)

  composioCache.set(tenantId, { tools, expiresAt: Date.now() + CACHE_TTL_MS })
  console.log(`[composio] fetched ${Object.keys(tools).length} tools for tenant ${tenantId}`)
  return tools
}

export function invalidateComposioCache(tenantId: string): void {
  composioCache.delete(tenantId)
}

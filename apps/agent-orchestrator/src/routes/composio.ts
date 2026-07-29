import { Hono } from 'hono'
import { timingSafeEqual } from 'crypto'
import { Composio } from 'composio-core'
import { invalidateComposioCache } from '../mastra/composio.js'

// Curated list of Composio apps available for tenant connection.
// uniqueKey must match Composio's app registry (case-insensitive).
const COMPOSIO_CATALOGUE = [
  { appName: 'slack',      label: 'Slack',       description: 'Send messages and read channels',          scopes: ['Messages', 'Channels', 'Files'] },
  { appName: 'notion',     label: 'Notion',      description: 'Read and write pages and databases',       scopes: ['Pages', 'Databases', 'Blocks'] },
  { appName: 'linear',     label: 'Linear',      description: 'Manage issues, projects and cycles',       scopes: ['Issues', 'Projects', 'Teams'] },
  { appName: 'github',     label: 'GitHub',      description: 'Access repos, PRs and issues',             scopes: ['Repos', 'PRs', 'Issues'] },
  { appName: 'hubspot',    label: 'HubSpot',     description: 'Manage contacts, deals and companies',     scopes: ['Contacts', 'Deals', 'Companies'] },
  { appName: 'asana',      label: 'Asana',       description: 'Manage tasks, projects and teams',         scopes: ['Tasks', 'Projects', 'Teams'] },
  { appName: 'trello',     label: 'Trello',      description: 'Manage boards, lists and cards',           scopes: ['Boards', 'Lists', 'Cards'] },
  { appName: 'airtable',   label: 'Airtable',    description: 'Read and write tables and records',        scopes: ['Bases', 'Tables', 'Records'] },
  { appName: 'googledocs', label: 'Google Docs', description: 'Read and write Google Docs',               scopes: ['Read', 'Write', 'Share'] },
  { appName: 'discord',    label: 'Discord',     description: 'Read channels and send messages',          scopes: ['Messages', 'Channels', 'Guilds'] },
] as const

function isAuthorized(key: string | undefined): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY
  if (!expected || !key) return false
  try {
    return timingSafeEqual(Buffer.from(key), Buffer.from(expected))
  } catch {
    return false
  }
}

let _composio: Composio | null = null
function getComposio(): Composio {
  if (!_composio) {
    if (!process.env.COMPOSIO_API_KEY) throw new Error('COMPOSIO_API_KEY not set')
    _composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY })
  }
  return _composio
}

export const composioRouter = new Hono()

// GET /internal/composio/apps?tenantId=<id>
// Returns curated app list with connection status per tenant.
composioRouter.get('/internal/composio/apps', async (c) => {
  if (!isAuthorized(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  const tenantId = c.req.query('tenantId')
  if (!tenantId) return c.json({ error: 'tenantId required' }, 400)

  let connectedAppNames = new Set<string>()
  try {
    const res = await getComposio().connectedAccounts.list({ entityId: tenantId, status: 'ACTIVE' })
    const items: any[] = (res as any)?.items ?? []
    connectedAppNames = new Set(items.map((a: any) => (a.appUniqueId ?? a.appName ?? '').toLowerCase()))
  } catch (err) {
    console.warn('[composio] list connected accounts failed:', (err as Error).message)
  }

  const apps = COMPOSIO_CATALOGUE.map((app) => ({
    ...app,
    connected: connectedAppNames.has(app.appName.toLowerCase()),
  }))

  return c.json({ apps })
})

// POST /internal/composio/connect
// Body: { tenantId, appName, redirectUrl }
// Returns: { url } — OAuth redirect URL from Composio
composioRouter.post('/internal/composio/connect', async (c) => {
  if (!isAuthorized(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json() as { tenantId?: string; appName?: string; redirectUrl?: string }
  const { tenantId, appName, redirectUrl } = body
  if (!tenantId || !appName || !redirectUrl) return c.json({ error: 'tenantId, appName, redirectUrl required' }, 400)

  const catalogue = COMPOSIO_CATALOGUE.find((a) => a.appName === appName)
  if (!catalogue) return c.json({ error: `Unknown app: ${appName}` }, 400)

  const request = await getComposio().connectedAccounts.initiate({
    appName,
    entityId: tenantId,
    redirectUri: redirectUrl,
  })

  const url = (request as any).redirectUrl ?? (request as any).connectionUrl
  if (!url) return c.json({ error: 'Composio did not return a redirect URL' }, 502)

  return c.json({ url })
})

// DELETE /internal/composio/disconnect
// Body: { tenantId, appName }
composioRouter.delete('/internal/composio/disconnect', async (c) => {
  if (!isAuthorized(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json() as { tenantId?: string; appName?: string }
  const { tenantId, appName } = body
  if (!tenantId || !appName) return c.json({ error: 'tenantId, appName required' }, 400)

  let disconnected = false
  try {
    const res = await getComposio().connectedAccounts.list({ entityId: tenantId, appName })
    const items: any[] = (res as any)?.items ?? []
    for (const account of items) {
      const id = account.id ?? account.connectedAccountId
      if (id) {
        await getComposio().connectedAccounts.delete({ connectedAccountId: id })
        disconnected = true
      }
    }
  } catch (err) {
    console.error('[composio] disconnect failed:', (err as Error).message)
    return c.json({ error: 'Failed to disconnect' }, 502)
  }

  // Bust the tool cache so the next request picks up the removal immediately.
  invalidateComposioCache(tenantId)

  return c.json({ ok: true, disconnected })
})

import { Hono } from 'hono'
import { getThreadOMMetadata } from '@mastra/core/memory'
import { isInternalServiceKey } from '../service-key.js'
import { getMastraMemory } from '../mastra/memory.js'

// Read-only aggregation of the "tenant memory" Extractor's output
// (apps/agent-orchestrator/src/mastra/memory.ts, tenantMemoryExtractor) across
// every thread for a tenant. Aggregation is needed only because OM's own
// scope is currently 'thread' (proving phase — see project_om_rollout_plan
// memory note): each thread carries its own extracted values under
// thread.metadata.mastra.om.extracted['tenant-memory'] rather than one shared
// resource-level record. Once OM graduates to 'resource' scope, this becomes
// a single-thread read instead of a merge across all of a tenant's threads.
export const memoryInsightsRouter = new Hono()

const TENANT_MEMORY_EXTRACTOR_SLUG = 'tenant-memory'

type TenantMemoryExtraction = {
  topics?: string[]
  areas?: string[]
  projects?: string[]
}

memoryInsightsRouter.get('/memory/insights/:tenantId', async (c) => {
  const serviceKey = c.req.header('X-Service-Key')
  if (!isInternalServiceKey(serviceKey)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const tenantId = c.req.param('tenantId')
  if (!tenantId) return c.json({ error: 'tenantId required' }, 400)

  const { threads } = await getMastraMemory().listThreads({
    perPage: false,
    filter: { resourceId: tenantId },
  })

  const topics = new Set<string>()
  const areas = new Set<string>()
  const projects = new Set<string>()
  let lastUpdatedAt: Date | null = null

  for (const thread of threads) {
    const extracted = getThreadOMMetadata(thread.metadata)?.extracted?.[TENANT_MEMORY_EXTRACTOR_SLUG] as
      | TenantMemoryExtraction
      | undefined
    if (!extracted) continue

    for (const t of extracted.topics ?? []) topics.add(t)
    for (const a of extracted.areas ?? []) areas.add(a)
    for (const p of extracted.projects ?? []) projects.add(p)

    if (!lastUpdatedAt || thread.updatedAt > lastUpdatedAt) lastUpdatedAt = thread.updatedAt
  }

  return c.json({
    data: {
      topics: [...topics],
      areas: [...areas],
      projects: [...projects],
      threadCount: threads.length,
      updatedAt: lastUpdatedAt,
    },
  })
})

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { RequestContext, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context'
import { validateToken } from '../auth.js'
import { mastra } from '../mastra/index.js'
import { getAllowedOrigin } from '../types.js'

function corsHeaders(origin: string | undefined) {
  const allowed = getAllowedOrigin(origin)
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Id',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

async function auth(c: any): Promise<{ tenantId: string; userId: string; agentId: string } | null> {
  const token = (c.req.header('Authorization') ?? '').replace('Bearer ', '')
  if (!token) return null
  try {
    const payload = await validateToken(token)
    return {
      tenantId: (payload['custom:tenantId'] as string) ?? '',
      userId: (payload.sub as string) ?? '',
      agentId: c.req.header('X-Agent-Id') ?? '',
    }
  } catch {
    return null
  }
}

export const schedulesRouter = new Hono()

schedulesRouter.options('/schedules', (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.header('Origin')) }))
schedulesRouter.options('/schedules/:id', (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.header('Origin')) }))

// POST /schedules — create a scheduled pmWorkflow run
// Body: { agentId, templatePrompt, cron, timezone? }
// cron: standard 5-part cron expression e.g. "0 9 * * 1" (Monday 9am)
schedulesRouter.post('/schedules', async (c) => {
  const hdrs = corsHeaders(c.req.header('Origin'))
  const user = await auth(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { templatePrompt, cron, timezone } = await c.req.json() as {
    templatePrompt: string
    cron: string
    timezone?: string
  }

  if (!templatePrompt || !cron) {
    return c.json({ error: 'templatePrompt and cron are required' }, 400, hdrs)
  }

  const schedulesStore = (mastra.storage as any)?.stores?.schedules
  if (!schedulesStore) {
    return c.json({ error: 'Scheduler storage not available' }, 503, hdrs)
  }

  const requestContext = new RequestContext()
  requestContext.set(MASTRA_RESOURCE_ID_KEY, user.tenantId)
  requestContext.set('tenantId', user.tenantId)
  requestContext.set('userId', user.userId)
  requestContext.set('agentId', user.agentId)

  const scheduleId = `pm-${user.tenantId}-${randomUUID()}`

  try {
    const schedule = await schedulesStore.createSchedule({
      id: scheduleId,
      workflowId: 'pm-workflow',
      cron,
      timezone: timezone ?? 'UTC',
      nextFireAt: getNextFireAt(cron),
      inputData: { userPrompt: templatePrompt },
      requestContext: {
        tenantId: user.tenantId,
        userId: user.userId,
        agentId: user.agentId,
      },
      metadata: { agentId: user.agentId, tenantId: user.tenantId },
    })

    console.log(`[schedules] created scheduleId=${scheduleId} tenantId=${user.tenantId} cron=${cron}`)
    return c.json({ scheduleId: schedule.id, cron, nextFireAt: schedule.nextFireAt }, 201, hdrs)
  } catch (err) {
    console.error('[schedules] create error:', (err as Error).message)
    return c.json({ error: 'Failed to create schedule' }, 500, hdrs)
  }
})

// GET /schedules — list schedules for this agent/tenant
schedulesRouter.get('/schedules', async (c) => {
  const hdrs = corsHeaders(c.req.header('Origin'))
  const user = await auth(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const schedulesStore = (mastra.storage as any)?.stores?.schedules
  if (!schedulesStore) return c.json({ schedules: [] }, 200, hdrs)

  try {
    const all = await schedulesStore.listSchedules()
    // Filter by tenantId stored in metadata
    const tenantSchedules = (all as any[]).filter(
      (s) => s.metadata?.tenantId === user.tenantId
        && (!user.agentId || s.metadata?.agentId === user.agentId)
    )
    return c.json({ schedules: tenantSchedules }, 200, hdrs)
  } catch (err) {
    console.error('[schedules] list error:', (err as Error).message)
    return c.json({ error: 'Failed to list schedules' }, 500, hdrs)
  }
})

// DELETE /schedules/:id — remove a schedule
schedulesRouter.delete('/schedules/:id', async (c) => {
  const hdrs = corsHeaders(c.req.header('Origin'))
  const user = await auth(c)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const scheduleId = c.req.param('id')
  const schedulesStore = (mastra.storage as any)?.stores?.schedules
  if (!schedulesStore) return c.json({ error: 'Scheduler storage not available' }, 503, hdrs)

  try {
    const existing = await schedulesStore.getSchedule(scheduleId)
    if (!existing) return c.json({ error: 'Schedule not found' }, 404, hdrs)
    if (existing.metadata?.tenantId !== user.tenantId) return c.json({ error: 'Forbidden' }, 403, hdrs)

    await schedulesStore.deleteSchedule(scheduleId)
    console.log(`[schedules] deleted scheduleId=${scheduleId} tenantId=${user.tenantId}`)
    return c.json({ deleted: true }, 200, hdrs)
  } catch (err) {
    console.error('[schedules] delete error:', (err as Error).message)
    return c.json({ error: 'Failed to delete schedule' }, 500, hdrs)
  }
})

// ─── Utility: compute next fire time from cron expression ─────────────────────
// Lightweight implementation — avoids pulling in a full cron parser.
// For production accuracy, replace with croner or cron-parser.
function getNextFireAt(cron: string): number {
  // Default: 1 minute from now as a safe fallback
  // The Mastra scheduler will recompute nextFireAt after each fire
  return Date.now() + 60_000
}

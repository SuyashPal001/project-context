import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { getSummary, getWorkflowMetrics, getCostBreakdown, getAuditVolume, getAgentActivity } from '../services/observability'

const observabilityRoutes = new Hono<AppEnv>()

function getContext(c: any): { tenantId: string } | null {
  const tenantId = c.get('requestContext')?.tenant?.id
  if (!tenantId) return null
  return { tenantId }
}

observabilityRoutes.get('/summary', async (c) => {
  const ctx = getContext(c)
  if (!ctx) return c.json({ error: 'Forbidden' }, 403)
  return c.json(await getSummary(ctx.tenantId))
})

observabilityRoutes.get('/workflows', async (c) => {
  const ctx = getContext(c)
  if (!ctx) return c.json({ error: 'Forbidden' }, 403)
  const hours = Math.min(Number(c.req.query('hours') ?? 24), 168)
  return c.json({ points: await getWorkflowMetrics(ctx.tenantId, hours) })
})

observabilityRoutes.get('/costs', async (c) => {
  const ctx = getContext(c)
  if (!ctx) return c.json({ error: 'Forbidden' }, 403)
  const days = Math.min(Number(c.req.query('days') ?? 7), 90)
  return c.json(await getCostBreakdown(ctx.tenantId, days))
})

observabilityRoutes.get('/audit-volume', async (c) => {
  const ctx = getContext(c)
  if (!ctx) return c.json({ error: 'Forbidden' }, 403)
  const days = Math.min(Number(c.req.query('days') ?? 14), 90)
  return c.json({ points: await getAuditVolume(ctx.tenantId, days) })
})

observabilityRoutes.get('/agents', async (c) => {
  const ctx = getContext(c)
  if (!ctx) return c.json({ error: 'Forbidden' }, 403)
  const days = Math.min(Number(c.req.query('days') ?? 7), 90)
  return c.json({ agents: await getAgentActivity(ctx.tenantId, days) })
})

export { observabilityRoutes }

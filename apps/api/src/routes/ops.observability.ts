import { isPlatformAdmin } from './ops.guard'
import { getSummary, getWorkflowMetrics, getCostBreakdown, getAuditVolume, getAgentActivity } from '../services/observability'
import type { Context } from 'hono'
import type { AppEnv } from '../types'

function scope(c: Context<AppEnv>): string | null {
  const t = c.req.query('tenantId')
  return t && t.length > 0 ? t : null
}

export async function handleObsSummary(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden' }, 403)
  return c.json(await getSummary(scope(c)))
}

export async function handleObsWorkflows(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden' }, 403)
  const hours = Math.min(Number(c.req.query('hours') ?? 24), 168)
  return c.json({ points: await getWorkflowMetrics(scope(c), hours) })
}

export async function handleObsCosts(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden' }, 403)
  const days = Math.min(Number(c.req.query('days') ?? 7), 90)
  return c.json(await getCostBreakdown(scope(c), days))
}

export async function handleObsAuditVolume(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden' }, 403)
  const days = Math.min(Number(c.req.query('days') ?? 14), 90)
  return c.json({ points: await getAuditVolume(scope(c), days) })
}

export async function handleObsAgents(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden' }, 403)
  const days = Math.min(Number(c.req.query('days') ?? 7), 90)
  return c.json({ agents: await getAgentActivity(scope(c), days) })
}

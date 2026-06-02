import { isPlatformAdmin } from './ops.guard'
import { getSummary, getWorkflowMetrics, getCostBreakdown, getAuditVolume, getAgentActivity } from '@serverless-saas/agent-api/services/observability'
import type { Context } from 'hono'
import type { AppEnv } from '../types'

interface AdapterLatency { adapter: string; ttft_avg_ms: number; ttft_count: number }

function parseInferenceMetrics(text: string): AdapterLatency[] {
  const avgs = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.includes('metric="ttft"')) continue
    const adapter = line.match(/adapter="([^"]+)"/)?.[1]
    const value = parseFloat(line.match(/\}\s+([\d.]+)/)?.[1] ?? 'NaN')
    if (!adapter || isNaN(value)) continue
    if (line.includes('_avg_ms{')) avgs.set(adapter, value)
    else if (line.includes('_count{')) counts.set(adapter, value)
  }
  return Array.from(avgs.entries()).map(([adapter, ttft_avg_ms]) => ({
    adapter, ttft_avg_ms, ttft_count: counts.get(adapter) ?? 0,
  }))
}

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

export async function handleObsInferenceLatency(c: Context<AppEnv>) {
  if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden' }, 403)
  const gatewayUrl = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
  try {
    const res = await fetch(`${gatewayUrl}/metrics`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return c.json({ adapters: [] })
    return c.json({ adapters: parseInferenceMetrics(await res.text()) })
  } catch {
    return c.json({ adapters: [] })
  }
}

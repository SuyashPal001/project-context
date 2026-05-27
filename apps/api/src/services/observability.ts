import { sql, SQL } from 'drizzle-orm'
import { db } from '@serverless-saas/database'

// null = platform-wide (no tenant filter); string = scoped to that tenant
type TenantScope = string | null

function tenantFilter(col: string, tenantId: TenantScope): SQL {
  return tenantId
    ? sql`AND ${sql.raw(col)} = ${tenantId}::uuid`
    : sql``
}

export interface SummaryStats {
  totalRequests24h: number
  totalCostUsd24h: number
  activeWorkflows: number
  workflowSuccessRate24h: number
  auditEntries24h: number
  health: { api: 'ok' | 'degraded' | 'down'; relay: 'ok' | 'unknown'; lakehouse: 'ok' | 'unknown' }
}

export async function getSummary(tenantId: TenantScope): Promise<SummaryStats> {
  const [[requests], [costs], [audit], [workflows]] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(*)::int AS count FROM usage_records
      WHERE recorded_at > NOW() - INTERVAL '24 hours' AND metric = 'api_calls'
      ${tenantFilter('tenant_id', tenantId)}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::numeric AS total FROM token_costs
      WHERE created_at > NOW() - INTERVAL '24 hours'
      ${tenantFilter('tenant_id', tenantId)}
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS count FROM audit_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      ${tenantFilter('tenant_id', tenantId)}
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'running')::int AS active,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours')::int AS done24,
        COUNT(*) FILTER (WHERE status = 'failed'    AND completed_at > NOW() - INTERVAL '24 hours')::int AS failed24
      FROM agent_workflow_runs WHERE 1=1 ${tenantFilter('tenant_id', tenantId)}
    `),
  ])

  const done = Number((workflows as any).done24 ?? 0)
  const failed = Number((workflows as any).failed24 ?? 0)
  const total = done + failed

  const relayHealth = await probe(process.env.RELAY_INTERNAL_URL ?? 'http://localhost:3001')
  const lakehouseHealth = await probe(process.env.LAKEHOUSE_URL ?? 'http://localhost:8001')

  return {
    totalRequests24h: Number((requests as any).count ?? 0),
    totalCostUsd24h: Number((costs as any).total ?? 0),
    activeWorkflows: Number((workflows as any).active ?? 0),
    workflowSuccessRate24h: total === 0 ? 1 : done / total,
    auditEntries24h: Number((audit as any).count ?? 0),
    health: { api: 'ok', relay: relayHealth, lakehouse: lakehouseHealth },
  }
}

async function probe(url: string): Promise<'ok' | 'unknown'> {
  try {
    const res = await fetch(`${url.trim()}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok ? 'ok' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface WorkflowMetricPoint {
  hour: string
  succeeded: number
  failed: number
  running: number
  avgLatencyMs: number | null
}

export async function getWorkflowMetrics(tenantId: TenantScope, hours = 24): Promise<WorkflowMetricPoint[]> {
  const rows = await db.execute(sql`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc('hour', NOW()) - (${hours - 1} || ' hours')::interval,
        date_trunc('hour', NOW()), '1 hour') AS hour
    )
    SELECT
      to_char(b.hour, 'YYYY-MM-DD"T"HH24:00:00') AS hour,
      COUNT(r.*) FILTER (WHERE r.status = 'completed')::int AS succeeded,
      COUNT(r.*) FILTER (WHERE r.status = 'failed')::int    AS failed,
      COUNT(r.*) FILTER (WHERE r.status = 'running')::int   AS running,
      AVG(EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)::int AS avg_latency_ms
    FROM buckets b
    LEFT JOIN agent_workflow_runs r
      ON date_trunc('hour', r.started_at) = b.hour
      ${tenantId ? sql`AND r.tenant_id = ${tenantId}::uuid` : sql``}
    GROUP BY b.hour ORDER BY b.hour
  `)
  return (rows as any[]).map(r => ({
    hour: r.hour,
    succeeded: Number(r.succeeded ?? 0),
    failed: Number(r.failed ?? 0),
    running: Number(r.running ?? 0),
    avgLatencyMs: r.avg_latency_ms == null ? null : Number(r.avg_latency_ms),
  }))
}

export interface CostBreakdown {
  byModel: Array<{ model: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }>
  byWorkflow: Array<{ workflowId: string; costUsd: number; calls: number }>
  daily: Array<{ day: string; costUsd: number }>
}

export async function getCostBreakdown(tenantId: TenantScope, days = 7): Promise<CostBreakdown> {
  const tf = tenantFilter('tenant_id', tenantId)
  const [byModelRows, byWorkflowRows, dailyRows] = await Promise.all([
    db.execute(sql`
      SELECT model, SUM(cost_usd)::numeric AS cost_usd, COUNT(*)::int AS calls,
             SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens
      FROM token_costs WHERE created_at > NOW() - (${days} || ' days')::interval ${tf}
      GROUP BY model ORDER BY cost_usd DESC
    `),
    db.execute(sql`
      SELECT COALESCE(workflow_id, '(direct)') AS workflow_id,
             SUM(cost_usd)::numeric AS cost_usd, COUNT(*)::int AS calls
      FROM token_costs WHERE created_at > NOW() - (${days} || ' days')::interval ${tf}
      GROUP BY workflow_id ORDER BY cost_usd DESC
    `),
    db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', NOW()) - (${days - 1} || ' days')::interval,
          date_trunc('day', NOW()), '1 day') AS day
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(SUM(t.cost_usd), 0)::numeric AS cost_usd
      FROM days d
      LEFT JOIN token_costs t ON date_trunc('day', t.created_at) = d.day
        ${tenantId ? sql`AND t.tenant_id = ${tenantId}::uuid` : sql``}
      GROUP BY d.day ORDER BY d.day
    `),
  ])
  return {
    byModel: (byModelRows as any[]).map(r => ({ model: r.model, costUsd: Number(r.cost_usd ?? 0), calls: Number(r.calls ?? 0), inputTokens: Number(r.input_tokens ?? 0), outputTokens: Number(r.output_tokens ?? 0) })),
    byWorkflow: (byWorkflowRows as any[]).map(r => ({ workflowId: r.workflow_id, costUsd: Number(r.cost_usd ?? 0), calls: Number(r.calls ?? 0) })),
    daily: (dailyRows as any[]).map(r => ({ day: r.day, costUsd: Number(r.cost_usd ?? 0) })),
  }
}

export interface AuditVolumePoint {
  day: string
  total: number
  byActorType: { human: number; agent: number; system: number }
}

export async function getAuditVolume(tenantId: TenantScope, days = 14): Promise<AuditVolumePoint[]> {
  const rows = await db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', NOW()) - (${days - 1} || ' days')::interval,
        date_trunc('day', NOW()), '1 day') AS day
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COUNT(a.*)::int AS total,
           COUNT(a.*) FILTER (WHERE a.actor_type = 'human')::int  AS human,
           COUNT(a.*) FILTER (WHERE a.actor_type = 'agent')::int  AS agent,
           COUNT(a.*) FILTER (WHERE a.actor_type = 'system')::int AS system
    FROM days d
    LEFT JOIN audit_log a ON date_trunc('day', a.created_at) = d.day
      ${tenantId ? sql`AND a.tenant_id = ${tenantId}::uuid` : sql``}
    GROUP BY d.day ORDER BY d.day
  `)
  return (rows as any[]).map(r => ({
    day: r.day,
    total: Number(r.total ?? 0),
    byActorType: { human: Number(r.human ?? 0), agent: Number(r.agent ?? 0), system: Number(r.system ?? 0) },
  }))
}

export interface AgentActivity {
  agentId: string
  totalCalls: number
  totalCostUsd: number
  avgInputTokens: number
  avgOutputTokens: number
}

export async function getAgentActivity(tenantId: TenantScope, days = 7): Promise<AgentActivity[]> {
  const rows = await db.execute(sql`
    SELECT COALESCE(agent_id, '(unknown)') AS agent_id,
           COUNT(*)::int AS total_calls, SUM(cost_usd)::numeric AS total_cost_usd,
           AVG(input_tokens)::int AS avg_input_tokens, AVG(output_tokens)::int AS avg_output_tokens
    FROM token_costs
    WHERE created_at > NOW() - (${days} || ' days')::interval
    ${tenantFilter('tenant_id', tenantId)}
    GROUP BY agent_id ORDER BY total_calls DESC LIMIT 10
  `)
  return (rows as any[]).map(r => ({
    agentId: r.agent_id,
    totalCalls: Number(r.total_calls ?? 0),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    avgInputTokens: Number(r.avg_input_tokens ?? 0),
    avgOutputTokens: Number(r.avg_output_tokens ?? 0),
  }))
}

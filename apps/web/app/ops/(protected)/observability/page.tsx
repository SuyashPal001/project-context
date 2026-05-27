"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, DollarSign, Workflow, Shield } from "lucide-react"
import { StatTile } from "@/components/platform/observability/StatTile"
import { SystemHealthCard } from "@/components/platform/observability/SystemHealthCard"
import { WorkflowMetricsCard, type WorkflowPoint } from "@/components/platform/observability/WorkflowMetricsCard"
import { CostBreakdownCard, type CostData } from "@/components/platform/observability/CostBreakdownCard"
import { AuditVolumeCard, type AuditPoint } from "@/components/platform/observability/AuditVolumeCard"
import { AgentActivityCard, type AgentStat } from "@/components/platform/observability/AgentActivityCard"

interface Summary {
  totalRequests24h: number
  totalCostUsd24h: number
  activeWorkflows: number
  workflowSuccessRate24h: number
  auditEntries24h: number
  health: { api: 'ok'|'degraded'|'down'; relay: 'ok'|'unknown'; lakehouse: 'ok'|'unknown' }
}

function opsUrl(path: string, tenantId: string) {
  const q = tenantId ? `?tenantId=${tenantId}` : ''
  return `/api/proxy/api/v1/ops/observability/${path}${q}`
}

async function get<T>(url: string): Promise<T | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  return res.json()
}

function fmt(n: number) { return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}` }

export default function OpsObservabilityPage() {
  const [tenantId, setTenantId] = useState('')

  const opts = { refetchInterval: 30_000 }
  const { data: summary, isLoading: sl } = useQuery({ queryKey: ['ops-obs-summary', tenantId], queryFn: () => get<Summary>(opsUrl('summary', tenantId)), ...opts })
  const { data: workflowsData, isLoading: wl } = useQuery({ queryKey: ['ops-obs-workflows', tenantId], queryFn: () => get<{ points: WorkflowPoint[] }>(opsUrl('workflows', tenantId)), ...opts })
  const { data: costs, isLoading: cl } = useQuery({ queryKey: ['ops-obs-costs', tenantId], queryFn: () => get<CostData>(opsUrl('costs', tenantId)), refetchInterval: 60_000 })
  const { data: auditData, isLoading: al } = useQuery({ queryKey: ['ops-obs-audit', tenantId], queryFn: () => get<{ points: AuditPoint[] }>(opsUrl('audit-volume', tenantId)), refetchInterval: 60_000 })
  const { data: agentsData, isLoading: agl } = useQuery({ queryKey: ['ops-obs-agents', tenantId], queryFn: () => get<{ agents: AgentStat[] }>(opsUrl('agents', tenantId)), refetchInterval: 60_000 })

  const workflows = workflowsData?.points ?? []
  const audit = auditData?.points ?? []
  const agents = agentsData?.agents ?? []
  const successPct = summary ? Math.round(summary.workflowSuccessRate24h * 100) : 0

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Platform Observability</h1>
          <p className="text-muted-foreground text-sm mt-1">System health · workflow metrics · token costs · audit volume</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Filter by tenant ID…"
            value={tenantId}
            onChange={e => setTenantId(e.target.value)}
            className="h-8 w-72 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          />
          {tenantId && (
            <button onClick={() => setTenantId('')} className="text-xs text-zinc-500 hover:text-zinc-300">
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="API Requests (24h)" value={summary?.totalRequests24h.toLocaleString() ?? '—'} icon={Activity} tone="blue" loading={sl} />
        <StatTile label="Spend (24h)" value={summary ? fmt(summary.totalCostUsd24h) : '—'} icon={DollarSign} tone="green" loading={sl} />
        <StatTile label="Workflow Success" value={summary ? `${successPct}%` : '—'} sublabel={summary ? `${summary.activeWorkflows} active` : undefined} icon={Workflow} tone={successPct >= 95 ? 'green' : successPct >= 85 ? 'amber' : 'red'} loading={sl} />
        <StatTile label="Audit Entries (24h)" value={summary?.auditEntries24h.toLocaleString() ?? '—'} icon={Shield} tone="neutral" loading={sl} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SystemHealthCard health={summary?.health ?? { api: 'unknown' as any, relay: 'unknown', lakehouse: 'unknown' }} loading={sl} />
        <div className="lg:col-span-2">
          <WorkflowMetricsCard points={workflows} loading={wl} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CostBreakdownCard data={costs ?? null} loading={cl} />
        <AuditVolumeCard points={audit} loading={al} />
      </div>

      <AgentActivityCard agents={agents} loading={agl} />
    </div>
  )
}

"use client"

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts"

export interface WorkflowPoint {
  hour: string
  succeeded: number
  failed: number
  running: number
  avgLatencyMs: number | null
}

interface Props { points: WorkflowPoint[]; loading?: boolean }

export function WorkflowMetricsCard({ points, loading }: Props) {
  const data = points.map(p => ({
    ...p,
    label: new Date(p.hour).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  }))
  const total = points.reduce((a, p) => a + p.succeeded + p.failed, 0)
  const failed = points.reduce((a, p) => a + p.failed, 0)
  const errorRate = total === 0 ? 0 : failed / total

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Workflow Executions</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Last 24 hours</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Error rate</p>
          <p className={`text-lg font-bold ${errorRate > 0.05 ? 'text-red-400' : 'text-green-400'}`}>
            {(errorRate * 100).toFixed(1)}%
          </p>
        </div>
      </div>
      {loading ? (
        <div className="h-48 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
      ) : data.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-zinc-600 text-sm">No workflow runs yet</div>
      ) : (
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="label" stroke="#71717a" fontSize={10} interval="preserveStartEnd" />
              <YAxis stroke="#71717a" fontSize={10} allowDecimals={false} />
              <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #27272a', fontSize: 12 }} labelStyle={{ color: '#a1a1aa' }} />
              <Area type="monotone" dataKey="succeeded" stackId="1" stroke="#22c55e" fill="#22c55e" fillOpacity={0.4} />
              <Area type="monotone" dataKey="failed"    stackId="1" stroke="#ef4444" fill="#ef4444" fillOpacity={0.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

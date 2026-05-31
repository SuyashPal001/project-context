"use client"

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts"

export interface CostData {
  byModel: Array<{ model: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }>
  byWorkflow: Array<{ workflowId: string; costUsd: number; calls: number }>
  daily: Array<{ day: string; costUsd: number }>
}

interface Props { data: CostData | null; loading?: boolean }

const MODEL_COLORS = ['#3b82f6', '#a855f7', '#f59e0b', '#10b981', '#ec4899']

function fmt(n: number) {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1)   return `$${n.toFixed(2)}`
  return `$${n.toFixed(4)}`
}

export function CostBreakdownCard({ data, loading }: Props) {
  const total = data?.daily.reduce((a, d) => a + d.costUsd, 0) ?? 0
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Cost Breakdown</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Last 7 days</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Total</p>
          <p className="text-lg font-bold text-blue-400">{fmt(total)}</p>
        </div>
      </div>
      {loading ? (
        <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
      ) : !data || data.daily.every(d => d.costUsd === 0) ? (
        <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">No cost data yet</div>
      ) : (
        <>
          <div className="h-40 mb-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="day" stroke="#71717a" fontSize={10} tickFormatter={d => d.slice(5)} />
                <YAxis stroke="#71717a" fontSize={10} tickFormatter={fmt} />
                <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #27272a', fontSize: 12 }} formatter={(v: any) => fmt(Number(v))} />
                <Bar dataKey="costUsd" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-1.5 text-xs">
            <p className="text-zinc-500 uppercase tracking-wider mb-2">By model</p>
            {data.byModel.slice(0, 4).map((m, i) => (
              <div key={m.model} className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                  <span className="font-mono text-zinc-300 truncate">{m.model}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-zinc-400">
                  <span>{m.calls.toLocaleString()} calls</span>
                  <span className="font-mono text-zinc-200 w-16 text-right">{fmt(m.costUsd)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

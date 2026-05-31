"use client"

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts"

export interface AuditPoint {
  day: string
  total: number
  byActorType: { human: number; agent: number; system: number }
}

interface Props { points: AuditPoint[]; loading?: boolean }

export function AuditVolumeCard({ points, loading }: Props) {
  const data = points.map(p => ({ day: p.day.slice(5), human: p.byActorType.human, agent: p.byActorType.agent, system: p.byActorType.system }))
  const total14d = points.reduce((a, p) => a + p.total, 0)
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Audit Log Volume</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Last 14 days · by actor</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Total</p>
          <p className="text-lg font-bold text-zinc-200">{total14d.toLocaleString()}</p>
        </div>
      </div>
      {loading ? (
        <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
      ) : data.length === 0 ? (
        <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">No audit entries</div>
      ) : (
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="day" stroke="#71717a" fontSize={10} />
              <YAxis stroke="#71717a" fontSize={10} allowDecimals={false} />
              <Tooltip contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #27272a', fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="human"  stroke="#3b82f6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="agent"  stroke="#a855f7" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="system" stroke="#71717a" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

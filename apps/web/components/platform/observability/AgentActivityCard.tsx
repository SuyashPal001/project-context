"use client"

import { Bot } from "lucide-react"

export interface AgentStat {
  agentId: string
  totalCalls: number
  totalCostUsd: number
  avgInputTokens: number
  avgOutputTokens: number
}

interface Props { agents: AgentStat[]; loading?: boolean }

function fmt(n: number) { return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}` }

export function AgentActivityCard({ agents, loading }: Props) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Top Agents</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Last 7 days · by activity</p>
        </div>
      </div>
      {loading ? (
        <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
      ) : agents.length === 0 ? (
        <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">No agent calls yet</div>
      ) : (
        <div className="space-y-2">
          {agents.slice(0, 6).map(a => (
            <div key={a.agentId} className="flex items-center justify-between gap-3 py-1.5 border-b border-zinc-800/50 last:border-0">
              <div className="flex items-center gap-2 min-w-0">
                <Bot className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-sm font-mono text-zinc-300 truncate">{a.agentId}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0 text-xs text-zinc-400 font-mono">
                <span>{a.totalCalls.toLocaleString()}×</span>
                <span className="text-zinc-500">{a.avgInputTokens}↑ {a.avgOutputTokens}↓</span>
                <span className="text-blue-400 w-14 text-right">{fmt(a.totalCostUsd)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

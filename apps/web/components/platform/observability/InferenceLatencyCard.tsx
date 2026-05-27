"use client"

import { Zap } from "lucide-react"

export interface AdapterLatency {
  adapter: string
  ttft_avg_ms: number
  ttft_count: number
}

interface Props { adapters: AdapterLatency[]; loading?: boolean }

function ttftColor(ms: number): string {
  if (ms < 500)  return "text-green-400"
  if (ms < 1500) return "text-amber-400"
  return "text-red-400"
}

function ttftBadge(ms: number): string {
  if (ms < 500)  return "bg-green-500/10 text-green-400 border-green-500/20"
  if (ms < 1500) return "bg-amber-500/10 text-amber-400 border-amber-500/20"
  return "bg-red-500/10 text-red-400 border-red-500/20"
}

export function InferenceLatencyCard({ adapters, loading }: Props) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Inference Latency (TTFT)</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Time to first token · per adapter</p>
        </div>
        <Zap className="w-4 h-4 text-zinc-600" />
      </div>

      {loading ? (
        <div className="h-24 flex items-center justify-center text-zinc-600 text-sm">Loading…</div>
      ) : adapters.length === 0 ? (
        <div className="h-24 flex items-center justify-center text-zinc-600 text-sm text-center px-4">
          No streaming requests yet — TTFT will appear after the first inference call
        </div>
      ) : (
        <div className="space-y-3">
          {adapters.map(a => (
            <div key={a.adapter} className="flex items-center justify-between gap-3">
              <span className={`text-xs font-mono px-2 py-0.5 rounded border ${ttftBadge(a.ttft_avg_ms)}`}>
                {a.adapter}
              </span>
              <div className="flex items-baseline gap-2 ml-auto">
                <span className={`text-xl font-bold font-mono tabular-nums ${ttftColor(a.ttft_avg_ms)}`}>
                  {a.ttft_avg_ms.toFixed(0)}
                </span>
                <span className="text-xs text-zinc-500">ms avg</span>
                <span className="text-xs text-zinc-600 font-mono ml-1">{a.ttft_count}×</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

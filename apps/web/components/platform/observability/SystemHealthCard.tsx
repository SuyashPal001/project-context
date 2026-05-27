"use client"

import { Server, Bot, Database } from "lucide-react"
import { Badge } from "@/components/ui/badge"

type Status = 'ok' | 'degraded' | 'down' | 'unknown'

interface Props {
  health: { api: Status; relay: Status; lakehouse: Status }
  loading?: boolean
}

const STATUS: Record<Status, { dot: string; label: string; cls: string }> = {
  ok:       { dot: 'bg-green-500', label: 'Operational', cls: 'border-green-500/30 text-green-400 bg-green-500/10' },
  degraded: { dot: 'bg-amber-500', label: 'Degraded',    cls: 'border-amber-500/30 text-amber-400 bg-amber-500/10' },
  down:     { dot: 'bg-red-500',   label: 'Down',        cls: 'border-red-500/30 text-red-400 bg-red-500/10' },
  unknown:  { dot: 'bg-zinc-600',  label: 'Unknown',     cls: 'border-zinc-700 text-zinc-500 bg-zinc-900' },
}

const SERVICES = [
  { key: 'api'       as const, label: 'API Service',       icon: Server   },
  { key: 'relay'     as const, label: 'Agent Runtime',     icon: Bot      },
  { key: 'lakehouse' as const, label: 'Lakehouse Service', icon: Database },
]

export function SystemHealthCard({ health, loading }: Props) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-zinc-200">System Health</h3>
        <span className="text-xs text-zinc-500">Real-time</span>
      </div>
      <div className="space-y-3">
        {SERVICES.map(({ key, label, icon: Icon }) => {
          const s = STATUS[loading ? 'unknown' : health[key]]
          return (
            <div key={key} className="flex items-center justify-between gap-3 py-1">
              <div className="flex items-center gap-2.5 min-w-0">
                <Icon className="w-4 h-4 text-zinc-500 shrink-0" />
                <span className="text-sm text-zinc-300 truncate">{label}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                <Badge variant="outline" className={`text-xs ${s.cls}`}>{s.label}</Badge>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

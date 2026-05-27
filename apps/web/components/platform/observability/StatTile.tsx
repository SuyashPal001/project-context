"use client"

import { LucideIcon } from "lucide-react"

interface Props {
  label: string
  value: string | number
  sublabel?: string
  icon: LucideIcon
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue'
  loading?: boolean
}

const TONES: Record<NonNullable<Props['tone']>, { bg: string; text: string; ring: string }> = {
  neutral: { bg: 'bg-zinc-900',       text: 'text-zinc-200',  ring: 'border-zinc-800' },
  green:   { bg: 'bg-green-500/10',   text: 'text-green-400', ring: 'border-green-500/30' },
  amber:   { bg: 'bg-amber-500/10',   text: 'text-amber-400', ring: 'border-amber-500/30' },
  red:     { bg: 'bg-red-500/10',     text: 'text-red-400',   ring: 'border-red-500/30' },
  blue:    { bg: 'bg-blue-500/10',    text: 'text-blue-400',  ring: 'border-blue-500/30' },
}

export function StatTile({ label, value, sublabel, icon: Icon, tone = 'neutral', loading }: Props) {
  const s = TONES[tone]
  return (
    <div className={`rounded-lg border ${s.ring} bg-zinc-950 p-4 flex items-start gap-3`}>
      <div className={`h-9 w-9 rounded-md ${s.bg} flex items-center justify-center shrink-0`}>
        <Icon className={`w-4 h-4 ${s.text}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">{label}</p>
        <p className={`text-2xl font-bold ${s.text} mt-0.5 truncate`}>
          {loading ? <span className="text-zinc-700">—</span> : value}
        </p>
        {sublabel && <p className="text-xs text-zinc-500 mt-1">{sublabel}</p>}
      </div>
    </div>
  )
}

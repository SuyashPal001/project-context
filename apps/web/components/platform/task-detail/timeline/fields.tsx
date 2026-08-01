'use client'

import { useState } from 'react'
import type { TimelineTrackedField } from '@/types/task'

const FIELD_LABELS: Record<TimelineTrackedField, string> = {
    title: 'title',
    description: 'description',
    acceptanceCriteria: 'acceptance criteria',
    estimatedHours: 'estimate',
}

function asText(value: unknown): string {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'string') return value
    return JSON.stringify(value)
}

function InlineChange({ field, from, to }: { field: TimelineTrackedField; from: unknown; to: unknown }) {
    return (
        <span className="text-xs text-muted-foreground/60">
            {FIELD_LABELS[field]}:{' '}
            <span className="line-through opacity-50">{asText(from)}</span>
            {' → '}
            <span className="text-foreground/80">{asText(to)}</span>
        </span>
    )
}

function CriteriaChange({ from, to }: { from: unknown; to: unknown }) {
    type Criterion = { text: string; checked: boolean }
    const list = (v: unknown): Criterion[] =>
        Array.isArray(v)
            ? v.map((i) =>
                i && typeof i === 'object' && 'text' in i
                    ? { text: String((i as any).text), checked: Boolean((i as any).checked) }
                    : { text: String(i), checked: false },
            )
            : []

    const before = list(from)
    const after = list(to)
    const beforeTexts = before.map((c) => c.text)
    const afterTexts = after.map((c) => c.text)

    const added = after.filter((c) => !beforeTexts.includes(c.text))
    const removed = before.filter((c) => !afterTexts.includes(c.text))
    const toggled = after.filter((c) => {
        const prev = before.find((b) => b.text === c.text)
        return prev && prev.checked !== c.checked
    })

    return (
        <div className="text-xs text-muted-foreground/60">
            changed acceptance criteria
            <div className="mt-1 space-y-0.5">
                {added.map((c, i) => <div key={`+${c.text}-${i}`} className="text-emerald-500/70">+ {c.text}</div>)}
                {removed.map((c, i) => <div key={`-${c.text}-${i}`} className="text-red-500/70 line-through">− {c.text}</div>)}
                {toggled.map((c, i) => (
                    <div key={`~${c.text}-${i}`} className="text-foreground/70">
                        {c.checked ? '☑' : '☐'} {c.text}
                    </div>
                ))}
            </div>
        </div>
    )
}

function DescriptionChange({ from, to }: { from: unknown; to: unknown }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="text-xs text-muted-foreground/60">
            rewrote the description{' '}
            <button
                onClick={() => setOpen((o) => !o)}
                className="text-primary/70 hover:text-primary transition-colors"
            >
                {open ? 'hide diff' : 'show diff'}
            </button>
            {open && (
                <div className="mt-2 space-y-2">
                    <div>
                        <div className="text-[10px] uppercase tracking-wide opacity-40 mb-0.5">before</div>
                        <div className="rounded border border-[#1e1e1e] p-2 whitespace-pre-wrap opacity-60">{asText(from)}</div>
                    </div>
                    <div>
                        <div className="text-[10px] uppercase tracking-wide opacity-40 mb-0.5">after</div>
                        <div className="rounded border border-[#1e1e1e] p-2 whitespace-pre-wrap text-foreground/80">{asText(to)}</div>
                    </div>
                </div>
            )}
        </div>
    )
}

export function FieldChange({ field, from, to }: { field: TimelineTrackedField; from: unknown; to: unknown }) {
    if (field === 'description') return <DescriptionChange from={from} to={to} />
    if (field === 'acceptanceCriteria') return <CriteriaChange from={from} to={to} />
    return <InlineChange field={field} from={from} to={to} />
}

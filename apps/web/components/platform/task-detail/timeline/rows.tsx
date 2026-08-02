'use client'

import {
    Bot, User, Settings, MessageSquare, Check, CheckCircle, XCircle, RefreshCw, Quote, Pencil,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import type { TimelineRow } from '@/types/task'
import { formatRelativeTime } from '../_sidebarHelpers'
import { FieldChange } from './fields'

type IconComponent = ComponentType<{ className?: string }>

const ACTOR_ICONS: Record<'agent' | 'human' | 'system', IconComponent> = {
    agent: Bot,
    human: User,
    system: Settings,
}

const ACTOR_NAMES: Record<'agent' | 'human' | 'system', string> = {
    agent: 'Agent',
    human: 'You',
    system: 'System',
}

const EVENT_OVERRIDES: Record<string, { icon: IconComponent; label: (payload?: Record<string, any>) => string }> = {
    status_changed: { icon: RefreshCw, label: (p) => `Status → ${p?.to || 'unknown'}` },
    comment_added: { icon: MessageSquare, label: () => 'Added a comment' },
    plan_proposed: { icon: RefreshCw, label: () => 'Proposed an execution plan' },
    plan_approved: { icon: CheckCircle, label: () => 'Approved the execution plan' },
    plan_rejected: { icon: XCircle, label: () => 'Requested changes to the plan' },
    clarification_requested: { icon: MessageSquare, label: () => 'Requested clarification' },
    clarification_answered: { icon: Check, label: () => 'Provided clarification' },
}

function Shell({ icon: Icon, accent, children, at }: {
    icon: IconComponent
    accent: boolean
    children: React.ReactNode
    at?: string
}) {
    return (
        <div className="relative pl-9">
            <div className="absolute left-1 top-0.5 w-4 h-4 rounded-full bg-[#0f0f0f] border border-[#1e1e1e] flex items-center justify-center z-10">
                <Icon className={cn('w-2.5 h-2.5', accent ? 'text-primary' : 'text-muted-foreground')} />
            </div>
            <div className="flex items-start gap-2">
                {children}
                {at ? (
                    <span className="text-[11px] text-muted-foreground/30 ml-auto shrink-0">
                        {formatRelativeTime(at)}
                    </span>
                ) : null}
            </div>
        </div>
    )
}

export function TimelineRowItem({ row }: { row: TimelineRow }) {
    if (row.kind === 'origin') {
        return (
            <Shell icon={Quote} accent>
                <div>
                    <div className="text-[10px] uppercase tracking-wide text-primary/60 mb-0.5">Original ask</div>
                    <div className="text-xs text-foreground/80 whitespace-pre-wrap">{row.content}</div>
                </div>
            </Shell>
        )
    }

    if (row.kind === 'revision') {
        return (
            <Shell icon={Pencil} accent={row.actorType === 'agent'} at={row.at}>
                <span className="text-xs text-foreground/80 font-medium shrink-0">
                    {row.actorName || ACTOR_NAMES[row.actorType]}
                </span>
                <FieldChange field={row.field} from={row.originalContent} to={row.correctedContent} />
            </Shell>
        )
    }

    const override = EVENT_OVERRIDES[row.eventType]
    const Icon = override?.icon ?? ACTOR_ICONS[row.actorType]
    const label = override?.label(row.payload) ?? row.eventType.replace(/_/g, ' ')

    return (
        <Shell icon={Icon} accent={row.actorType === 'agent'} at={row.at}>
            <span className="text-xs text-foreground/80 font-medium shrink-0">
                {row.actorName || ACTOR_NAMES[row.actorType]}
            </span>
            <span className="text-xs text-muted-foreground/60">{label}</span>
        </Shell>
    )
}

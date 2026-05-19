'use client'

import {
    Bot, User, Settings, MessageSquare, Check, CheckCircle, XCircle, RefreshCw,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import type { TaskEvent } from '@/types/task'
import { formatRelativeTime } from './_sidebarHelpers'

type IconComponent = ComponentType<{ className?: string }>

const ACTOR_ICONS: Record<TaskEvent['actorType'], IconComponent> = {
    agent: Bot,
    human: User,
    system: Settings,
}

const ACTOR_NAMES: Record<TaskEvent['actorType'], string> = {
    agent: 'Agent',
    human: 'You',
    system: 'System',
}

const EVENT_OVERRIDES: Record<string, { icon: IconComponent; describe: (event: TaskEvent) => string }> = {
    status_changed: {
        icon: RefreshCw,
        describe: (e) => `Status → ${e.payload?.to || 'unknown'}`,
    },
    comment_added: { icon: MessageSquare, describe: () => 'Added a comment' },
    plan_approved: { icon: CheckCircle, describe: () => 'Approved the execution plan' },
    plan_rejected: { icon: XCircle, describe: () => 'Requested changes to the plan' },
    clarification_requested: { icon: MessageSquare, describe: () => 'Requested clarification' },
    clarification_answered: { icon: Check, describe: () => 'Provided clarification' },
}

export function TimelineTab({ events }: { events: TaskEvent[] }) {
    if (events.length === 0) {
        return <p className="text-sm text-muted-foreground/40 italic py-4">No events yet.</p>
    }

    return (
        <div className="space-y-4 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-[#1e1e1e] ml-1">
            {events.map(event => {
                const override = EVENT_OVERRIDES[event.eventType]
                const Icon = override?.icon ?? ACTOR_ICONS[event.actorType]
                const description = override?.describe(event) ?? event.eventType.replace(/_/g, ' ')
                const actorName = ACTOR_NAMES[event.actorType]

                return (
                    <div key={event.id} className="relative pl-9">
                        <div className="absolute left-1 top-0.5 w-4 h-4 rounded-full bg-[#0f0f0f] border border-[#1e1e1e] flex items-center justify-center z-10">
                            <Icon className={cn("w-2.5 h-2.5", event.actorType === 'agent' ? 'text-primary' : 'text-muted-foreground')} />
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-foreground/80 font-medium">{actorName}</span>
                            <span className="text-xs text-muted-foreground/60">{description}</span>
                            <span className="text-[11px] text-muted-foreground/30 ml-auto">
                                {formatRelativeTime(event.createdAt)}
                            </span>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

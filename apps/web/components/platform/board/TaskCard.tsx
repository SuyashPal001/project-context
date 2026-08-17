'use client'

import Link from 'next/link'
import { MoreHorizontal, Clock, LayoutList, Bot } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { STATUS_CONFIG, PRIORITY_CONFIG } from './types'
import type { Task, MembersResponse, AgentsResponse } from './types'

// ─── StatusIcon ───────────────────────────────────────────────────────────────

export const StatusIcon = ({ status }: { status: string }) => {
    const configs = {
        backlog: <circle cx="12" cy="12" r="9" stroke="#6B7280" strokeWidth="1.5" strokeDasharray="4 2" fill="none"/>,
        todo: <circle cx="12" cy="12" r="9" stroke="#3B82F6" strokeWidth="1.5" fill="none"/>,
        in_progress: <>
            <circle cx="12" cy="12" r="9" stroke="#8B5CF6" strokeWidth="1.5" fill="none"/>
            <circle cx="12" cy="12" r="4" fill="#8B5CF6"/>
        </>,
        awaiting_approval: <>
            <circle cx="12" cy="12" r="9" stroke="#F59E0B" strokeWidth="1.5" fill="none"/>
            <path d="M12 7v5l3 3" stroke="#F59E0B" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        </>,
        review: <circle cx="12" cy="12" r="9" stroke="#F59E0B" strokeWidth="1.5" fill="none"/>,
        blocked: <circle cx="12" cy="12" r="9" stroke="#EF4444" strokeWidth="1.5" fill="none"/>,
        done: <>
            <circle cx="12" cy="12" r="9" fill="#10B981"/>
            <path d="M8 12l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </>,
        cancelled: <circle cx="12" cy="12" r="9" stroke="#6B7280" strokeWidth="1.5" fill="none"/>,
    }
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            {configs[status as keyof typeof configs] ?? configs.backlog}
        </svg>
    )
}

// ─── TaskCard ─────────────────────────────────────────────────────────────────

export function TaskCard({
    task,
    tenantSlug,
    taskNumber,
    members,
    agents
}: {
    task: Task
    tenantSlug: string
    taskNumber: number
    members: MembersResponse['members']
    agents: AgentsResponse['data']
}) {
    const score = task.confidenceScore != null ? Number(task.confidenceScore) : null
    const dotColor = score === null ? '' : score >= 0.8 ? 'bg-green-500' : score >= 0.6 ? 'bg-yellow-500' : 'bg-red-500'
    const statusLabel = STATUS_CONFIG[task.status as keyof typeof STATUS_CONFIG]?.label ?? 'Unknown'

    let assigneeInfo: { name: string; type: 'member' | 'agent' } | null = null
    if (task.assigneeId) {
        const member = members.find(m => m.userId === task.assigneeId)
        if (member) assigneeInfo = { name: member.userName || member.userEmail, type: 'member' }
    } else if (task.agentId) {
        const agent = agents.find(a => a.id === task.agentId)
        if (agent) assigneeInfo = { name: agent.name, type: 'agent' }
    }

    const getInitials = (name: string) => name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)

    const card = (
        <div
            draggable={true}
            onDragStart={(e) => { e.dataTransfer.setData('taskId', task.id); e.currentTarget.style.opacity = '0.4' }}
            onDragEnd={(e) => { e.currentTarget.style.opacity = '1' }}
        >
            <Link href={`/${tenantSlug}/dashboard/board/${task.id}`} className="block" draggable={false}>
                <div className="group border border-border bg-card rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-foreground/20 transition-colors relative">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className={cn("w-1.5 h-1.5 rounded-full", task.priority === 'urgent' && "animate-pulse")} style={{ backgroundColor: PRIORITY_CONFIG[task.priority]?.color }} />
                            <span className="text-xs text-muted-foreground/60 font-medium uppercase tracking-tighter">TASK-{taskNumber}</span>
                        </div>
                        <button
                            type="button"
                            onPointerDown={e => e.stopPropagation()}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-secondary"
                        >
                            <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
                        </button>
                    </div>
                    <p className="text-sm font-medium text-foreground leading-snug line-clamp-2 mt-1">{task.title}</p>
                    <div className="flex items-center gap-1.5 flex-wrap mt-2">
                        <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-muted/50 text-muted-foreground">
                            <StatusIcon status={task.status} />
                            <span>{statusLabel}</span>
                        </div>
                        {task.estimatedHours && (
                            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-muted/50 text-muted-foreground">
                                <Clock className="w-3.5 h-3.5" />
                                <span>{task.estimatedHours}h</span>
                            </div>
                        )}
                        {score !== null && (
                            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-muted/50 text-muted-foreground">
                                <span className={cn('w-2 h-2 rounded-full shrink-0', dotColor)} />
                                <span>{Math.round(score * 100)}%</span>
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {task.totalSteps > 0 && (
                            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-muted/50 text-muted-foreground">
                                <LayoutList className="w-3.5 h-3.5" />
                                <span>{task.completedSteps}/{task.totalSteps} steps</span>
                            </div>
                        )}
                    </div>
                    {assigneeInfo && (
                        <div className="absolute bottom-3 right-3">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <div className={cn(
                                        "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium border border-border overflow-hidden bg-secondary text-muted-foreground"
                                    )}>
                                        {assigneeInfo.type === 'agent' ? <Bot className="w-3 h-3" /> : <span>{getInitials(assigneeInfo.name)}</span>}
                                    </div>
                                </TooltipTrigger>
                                <TooltipContent side="top"><p className="text-[11px] font-medium">{assigneeInfo.name}</p></TooltipContent>
                            </Tooltip>
                        </div>
                    )}
                </div>
            </Link>
        </div>
    )

    if (task.status === 'blocked' && task.blockedReason) {
        return (
            <Tooltip>
                <TooltipTrigger asChild><div>{card}</div></TooltipTrigger>
                <TooltipContent className="max-w-xs">{task.blockedReason}</TooltipContent>
            </Tooltip>
        )
    }
    return card
}

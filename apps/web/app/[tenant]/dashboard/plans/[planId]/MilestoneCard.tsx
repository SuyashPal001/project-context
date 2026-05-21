'use client'

import { useRouter } from 'next/navigation'
import { isPast, format } from 'date-fns'
import { CalendarDays } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { type Milestone, PRIORITY_CONFIG } from './_types'
import { MilestoneStatusBadge } from './MilestoneStatusBadge'

export function MilestoneCard({ milestone, planId, tenantSlug }: { milestone: Milestone; planId: string; tenantSlug: string }) {
    const router = useRouter()
    const isOverdue = milestone.targetDate && milestone.status !== 'completed' && isPast(new Date(milestone.targetDate))
    const pct = milestone.totalTasks > 0 ? Math.round((milestone.completedTasks / milestone.totalTasks) * 100) : 0
    const priorityCfg = PRIORITY_CONFIG[milestone.priority]

    return (
        <div
            onClick={() => router.push(`/${tenantSlug}/dashboard/plans/${planId}/milestones/${milestone.id}`)}
            className="bg-[#111111] border border-[#1e1e1e] rounded-xl p-4 cursor-pointer hover:border-[#2a2a2a] transition-colors flex flex-col gap-3"
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-muted-foreground/50 uppercase tracking-tighter">MST-{milestone.sequenceId}</span>
                    <MilestoneStatusBadge milestone={milestone} planId={planId} />
                    <span className="flex items-center gap-1 text-xs text-muted-foreground/60">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: priorityCfg.color }} />
                        {priorityCfg.label}
                    </span>
                </div>
                {milestone.targetDate && (
                    <span className={cn('text-xs shrink-0', isOverdue ? 'text-red-400' : 'text-muted-foreground/60')}>
                        <CalendarDays className="w-3 h-3 inline mr-1" />
                        {format(new Date(milestone.targetDate), 'MMM d')}
                    </span>
                )}
            </div>

            <h3 className="text-sm font-medium text-foreground">{milestone.title}</h3>

            {milestone.totalTasks > 0 && (
                <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
                        <span>{milestone.completedTasks}/{milestone.totalTasks} tasks</span>
                        <span>{pct}%</span>
                    </div>
                    <Progress value={pct} className="h-1" />
                </div>
            )}
        </div>
    )
}

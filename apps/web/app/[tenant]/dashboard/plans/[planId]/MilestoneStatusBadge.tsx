'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { pmKeys } from '@/lib/query-keys/pm'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    type Milestone, type MilestoneStatus,
    MILESTONE_STATUS_CONFIG, VALID_MILESTONE_TRANSITIONS,
} from './_types'

export function MilestoneStatusBadge({ milestone, planId }: { milestone: Milestone; planId: string }) {
    const queryClient = useQueryClient()
    const cfg = MILESTONE_STATUS_CONFIG[milestone.status]
    const next = VALID_MILESTONE_TRANSITIONS[milestone.status]

    const mutation = useMutation({
        mutationFn: (newStatus: MilestoneStatus) =>
            api.patch(`/api/v1/milestones/${milestone.id}`, { status: newStatus }),
        onMutate: async (newStatus) => {
            await queryClient.cancelQueries({ queryKey: pmKeys.milestones(planId) })
            queryClient.setQueryData<{ data: Milestone[] }>(pmKeys.milestones(planId), (old) =>
                old ? { ...old, data: old.data.map(m => m.id === milestone.id ? { ...m, status: newStatus } : m) } : old
            )
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.milestones(planId) })
            queryClient.invalidateQueries({ queryKey: pmKeys.planSummary(planId) })
        },
        onError: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.milestones(planId) })
            toast.error('Failed to update milestone status')
        },
    })

    if (next.length === 0) {
        return <span className={cn('text-xs px-2 py-0.5 rounded font-medium', cfg.bg, cfg.color)}>{cfg.label}</span>
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    onClick={e => e.stopPropagation()}
                    className={cn('flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium hover:opacity-80 transition-opacity', cfg.bg, cfg.color)}
                >
                    {cfg.label} <ChevronDown className="w-3 h-3" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]" align="start" onClick={e => e.stopPropagation()}>
                {next.map(s => (
                    <DropdownMenuItem key={s} className="text-xs" onSelect={() => mutation.mutate(s)}>
                        <span className={cn('font-medium', MILESTONE_STATUS_CONFIG[s].color)}>
                            {MILESTONE_STATUS_CONFIG[s].label}
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

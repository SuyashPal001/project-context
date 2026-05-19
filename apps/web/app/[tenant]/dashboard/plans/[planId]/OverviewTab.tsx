'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { pmKeys } from '@/lib/query-keys/pm'
import { Card, CardContent } from '@/components/ui/card'
import { type PlanSummary, type Milestone } from './_types'
import { MilestoneCard } from './MilestoneCard'

export function OverviewTab({ planId, tenantSlug }: { planId: string; tenantSlug: string }) {
    const { data: summaryData } = useQuery<{ data: PlanSummary }>({
        queryKey: pmKeys.planSummary(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}/summary`),
    })

    const { data: milestonesData } = useQuery<{ data: Milestone[] }>({
        queryKey: pmKeys.milestones(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}/milestones`),
    })

    const summary = summaryData?.data
    const upcoming = (milestonesData?.data ?? [])
        .filter(m => m.status !== 'completed' && m.status !== 'cancelled' && m.targetDate)
        .sort((a, b) => new Date(a.targetDate!).getTime() - new Date(b.targetDate!).getTime())
        .slice(0, 3)

    const stats = [
        { label: 'Total Tasks',      value: summary?.totalTasks ?? '—' },
        { label: 'Completed Tasks',  value: summary?.completedTasks ?? '—' },
        { label: 'Total Milestones', value: summary?.totalMilestones ?? '—' },
        { label: 'Done Milestones',  value: summary?.completedMilestones ?? '—' },
    ]

    return (
        <div className="space-y-6 pt-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {stats.map(s => (
                    <Card key={s.label} className="bg-[#111111] border-[#1e1e1e]">
                        <CardContent className="p-4">
                            <p className="text-2xl font-semibold text-foreground">{s.value}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {upcoming.length > 0 && (
                <div>
                    <h2 className="text-sm font-medium text-foreground mb-3">Upcoming Milestones</h2>
                    <div className="space-y-2">
                        {upcoming.map(m => (
                            <MilestoneCard key={m.id} milestone={m} planId={planId} tenantSlug={tenantSlug} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

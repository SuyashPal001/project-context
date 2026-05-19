'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { pmKeys } from '@/lib/query-keys/pm'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { type Milestone, type Member } from './_types'
import { MilestoneCard } from './MilestoneCard'
import { CreateMilestoneDialog } from './CreateMilestoneDialog'

export function MilestonesTab({ planId, tenantSlug, members }: { planId: string; tenantSlug: string; members: Member[] }) {
    const [createOpen, setCreateOpen] = useState(false)

    const { data, isLoading, isError, refetch } = useQuery<{ data: Milestone[] }>({
        queryKey: pmKeys.milestones(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}/milestones`),
    })

    const milestones = data?.data ?? []

    return (
        <div className="pt-4">
            <div className="flex items-center justify-between mb-4">
                <span className="text-sm text-muted-foreground">{milestones.length} milestone{milestones.length !== 1 ? 's' : ''}</span>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="w-4 h-4 mr-1.5" /> New Milestone
                </Button>
            </div>

            {isLoading && (
                <div className="space-y-3">
                    {[1, 2].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
                </div>
            )}

            {isError && (
                <div className="text-center py-16">
                    <p className="text-sm text-destructive">Failed to load milestones</p>
                    <Button size="sm" variant="ghost" className="mt-2" onClick={() => refetch()}>Retry</Button>
                </div>
            )}

            {!isLoading && !isError && milestones.length === 0 && (
                <div className="text-center py-16">
                    <p className="text-sm text-muted-foreground">No milestones yet</p>
                    <Button size="sm" className="mt-3" onClick={() => setCreateOpen(true)}>
                        <Plus className="w-4 h-4 mr-1.5" /> New Milestone
                    </Button>
                </div>
            )}

            {milestones.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {milestones.map(m => (
                        <MilestoneCard key={m.id} milestone={m} planId={planId} tenantSlug={tenantSlug} />
                    ))}
                </div>
            )}

            <CreateMilestoneDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                planId={planId}
                members={members}
            />
        </div>
    )
}

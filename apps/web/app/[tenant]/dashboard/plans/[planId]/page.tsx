'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format, isPast } from 'date-fns'
import { Trash2, ChevronRight, CalendarDays, CalendarRange, PackageCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { pmKeys } from '@/lib/query-keys/pm'
import { useTenant } from '@/app/[tenant]/tenant-provider'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import PagesListPage from './pages/page'
import { TimelineView } from '@/components/platform/timeline/TimelineView'
import { type Plan, type Milestone, type Member, PLAN_STATUS_CONFIG } from './_types'
import { OverviewTab } from './OverviewTab'
import { MilestonesTab } from './MilestonesTab'
import { TasksTab } from './TasksTab'

export default function PlanDetailPage() {
    const params = useParams()
    const tenantSlug = params.tenant as string
    const planId = params.planId as string
    const { tenantId } = useTenant()
    const queryClient = useQueryClient()
    const router = useRouter()

    const [editingTitle, setEditingTitle] = useState(false)
    const [editingDesc, setEditingDesc] = useState(false)
    const [draftTitle, setDraftTitle] = useState('')
    const [draftDesc, setDraftDesc] = useState('')
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

    const deletePlan = useMutation({
        mutationFn: () => api.del(`/api/v1/plans/${planId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.plans(tenantId) })
            toast.success('Plan deleted')
            router.push(`/${tenantSlug}/dashboard/plans`)
        },
        onError: () => toast.error('Failed to delete plan'),
    })

    const patchPlan = useMutation({
        mutationFn: (updates: { title?: string; description?: string | null }) =>
            api.patch(`/api/v1/plans/${planId}`, updates),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: pmKeys.plan(planId) }),
        onError: () => toast.error('Failed to save plan'),
    })

    const { data: planData, isLoading, isError } = useQuery<{ data: Plan }>({
        queryKey: pmKeys.plan(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}`),
    })

    const { data: milestonesData } = useQuery<{ data: Milestone[] }>({
        queryKey: pmKeys.milestones(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}/milestones`),
    })

    const { data: membersData } = useQuery<{ members: Member[] }>({
        queryKey: ['members'],
        queryFn: () => api.get('/api/v1/members'),
    })

    const plan = planData?.data
    const milestones = milestonesData?.data ?? []
    const members = membersData?.members ?? []

    if (isLoading) {
        return (
            <div className="space-y-4">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-7 w-64" />
                <Skeleton className="h-8 w-full rounded-lg" />
            </div>
        )
    }

    if (isError || !plan) {
        return <p className="text-sm text-destructive">Failed to load plan.</p>
    }

    const planCfg = PLAN_STATUS_CONFIG[plan.status]

    return (
        <div className="flex flex-col">
            <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
                <Link href={`/${tenantSlug}/dashboard/plans`} className="hover:text-foreground transition-colors">Plans</Link>
                <ChevronRight className="w-3 h-3" />
                <span className="text-foreground">{plan.title}</span>
            </nav>

            <div className="flex items-start justify-between gap-4 mb-1">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-muted-foreground/50 uppercase tracking-tighter">PLN-{plan.sequenceId}</span>
                        <span className={cn('text-xs px-2 py-0.5 rounded font-medium', planCfg.bg, planCfg.color)}>
                            {planCfg.label}
                        </span>
                    </div>
                    {editingTitle ? (
                        <input
                            autoFocus
                            value={draftTitle}
                            onChange={e => setDraftTitle(e.target.value)}
                            onBlur={() => { const t = draftTitle.trim(); if (t && t !== plan.title) patchPlan.mutate({ title: t }); setEditingTitle(false) }}
                            onKeyDown={e => { if (e.key === 'Enter') { const t = draftTitle.trim(); if (t && t !== plan.title) patchPlan.mutate({ title: t }); setEditingTitle(false) } if (e.key === 'Escape') setEditingTitle(false) }}
                            className="text-xl font-semibold bg-transparent outline-none border-b border-primary/50 pb-0.5 w-full text-foreground"
                        />
                    ) : (
                        <h1
                            className="text-xl font-semibold text-foreground cursor-text hover:opacity-80 transition-opacity"
                            onClick={() => { setDraftTitle(plan.title); setEditingTitle(true) }}
                        >
                            {plan.title}
                        </h1>
                    )}
                    {editingDesc ? (
                        <textarea
                            autoFocus
                            value={draftDesc}
                            onChange={e => setDraftDesc(e.target.value)}
                            onBlur={() => { const d = draftDesc.trim(); if (d !== (plan.description ?? '')) patchPlan.mutate({ description: d || null }); setEditingDesc(false) }}
                            onKeyDown={e => { if (e.key === 'Escape') setEditingDesc(false) }}
                            rows={2}
                            placeholder="Add description…"
                            className="w-full mt-1 text-sm bg-transparent outline-none border-b border-primary/50 text-muted-foreground/70 resize-none placeholder:text-muted-foreground/30"
                        />
                    ) : (
                        <p
                            className="text-sm text-muted-foreground/70 mt-1 cursor-text hover:opacity-80 transition-opacity"
                            onClick={() => { setDraftDesc(plan.description ?? ''); setEditingDesc(true) }}
                        >
                            {plan.description || <span className="italic text-muted-foreground/30">Add description…</span>}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {plan.targetDate && (
                        <span className={cn(
                            'text-xs flex items-center gap-1',
                            plan.status !== 'completed' && isPast(new Date(plan.targetDate)) ? 'text-red-400' : 'text-muted-foreground/60'
                        )}>
                            <CalendarDays className="w-3.5 h-3.5" />
                            {format(new Date(plan.targetDate), 'MMM d, yyyy')}
                        </span>
                    )}
                    <Link
                        href={`/${tenantSlug}/dashboard/plans/${planId}/handover`}
                        className="text-xs flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#1e1e1e] bg-[#111] text-muted-foreground hover:text-foreground hover:border-[#2a2a2a] transition-colors"
                    >
                        <PackageCheck className="w-3.5 h-3.5" />
                        Handover pack
                    </Link>
                    <button
                        onClick={() => setDeleteConfirmOpen(true)}
                        className="text-muted-foreground/40 hover:text-destructive transition-colors"
                        aria-label="Delete plan"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <Tabs defaultValue="overview" className="mt-5">
                <TabsList className="bg-[#111] border border-[#1e1e1e]">
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="milestones">Milestones</TabsTrigger>
                    <TabsTrigger value="tasks">Tasks</TabsTrigger>
                    <TabsTrigger value="pages">Pages</TabsTrigger>
                    <TabsTrigger value="timeline" className="gap-1.5">
                        <CalendarRange className="w-3.5 h-3.5" />
                        Timeline
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="overview">
                    <OverviewTab planId={planId} tenantSlug={tenantSlug} />
                </TabsContent>

                <TabsContent value="milestones">
                    <MilestonesTab planId={planId} tenantSlug={tenantSlug} members={members} />
                </TabsContent>

                <TabsContent value="tasks">
                    <TasksTab planId={planId} tenantSlug={tenantSlug} milestones={milestones} />
                </TabsContent>

                <TabsContent value="pages">
                    <PagesListPage planId={planId} tenantSlug={tenantSlug} />
                </TabsContent>

                <TabsContent value="timeline" className="mt-0">
                    <div className="h-[calc(100vh-280px)] min-h-[500px] pt-4">
                        <TimelineView planId={planId} />
                    </div>
                </TabsContent>
            </Tabs>

            <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                <AlertDialogContent className="bg-[#0f0f0f] border-[#1e1e1e]">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete plan?</AlertDialogTitle>
                        <AlertDialogDescription>
                            &ldquo;{plan.title}&rdquo; and all its milestones and tasks will be permanently deleted.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => deletePlan.mutate()}
                            disabled={deletePlan.isPending}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {deletePlan.isPending ? 'Deleting…' : 'Delete'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}

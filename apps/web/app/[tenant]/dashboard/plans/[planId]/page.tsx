'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format, isPast } from 'date-fns'
import {
    Plus, Loader2, Trash2, ChevronRight, CalendarDays, ChevronDown, Users, X, CalendarRange,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/platform/shared/ConfirmDialog'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { pmKeys } from '@/lib/query-keys/pm'
import { useTenant } from '@/app/[tenant]/tenant-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
    DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import PagesListPage from './pages/page'
import { TimelineView } from '@/components/platform/timeline/TimelineView'

// ─── Types ────────────────────────────────────────────────────────────────────

type PlanStatus = 'draft' | 'active' | 'completed' | 'archived'
type MilestoneStatus = 'backlog' | 'in_progress' | 'completed' | 'cancelled'
type Priority = 'low' | 'medium' | 'high' | 'urgent'

type Plan = {
    id: string
    sequenceId: number
    title: string
    description: string | null
    status: PlanStatus
    startDate: string | null
    targetDate: string | null
    createdAt: string
}

type PlanSummary = {
    totalMilestones: number
    completedMilestones: number
    totalTasks: number
    completedTasks: number
}

type Milestone = {
    id: string
    sequenceId: number
    title: string
    description: string | null
    status: MilestoneStatus
    targetDate: string | null
    assigneeId: string | null
    priority: Priority
    totalTasks: number
    completedTasks: number
    createdAt: string
}

type AcItem = { text: string; checked?: boolean }

type PlanTask = {
    id: string
    sequenceId: number | null
    title: string
    description: string | null
    status: string
    priority: Priority
    milestoneId: string | null
    assigneeId: string | null
    dueDate: string | null
    acceptanceCriteria?: AcItem[]
    estimatedHours?: string | null
}

type Member = { userId: string; userName: string | null; userEmail: string; roleName: string }

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAN_STATUS_CONFIG: Record<PlanStatus, { label: string; color: string; bg: string }> = {
    draft:     { label: 'Draft',     color: 'text-gray-400',    bg: 'bg-gray-500/10' },
    active:    { label: 'Active',    color: 'text-blue-400',    bg: 'bg-blue-500/10' },
    completed: { label: 'Completed', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    archived:  { label: 'Archived',  color: 'text-gray-500',    bg: 'bg-gray-500/10' },
}

const MILESTONE_STATUS_CONFIG: Record<MilestoneStatus, { label: string; color: string; bg: string }> = {
    backlog:     { label: 'Backlog',     color: 'text-gray-400',   bg: 'bg-gray-500/10' },
    in_progress: { label: 'In Progress', color: 'text-blue-400',   bg: 'bg-blue-500/10' },
    completed:   { label: 'Completed',   color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    cancelled:   { label: 'Cancelled',   color: 'text-red-400',    bg: 'bg-red-500/10' },
}

const VALID_MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
    backlog:     ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed:   [],
    cancelled:   [],
}

const PRIORITY_CONFIG: Record<Priority, { label: string; color: string }> = {
    low:    { label: 'Low',    color: '#6B7280' },
    medium: { label: 'Medium', color: '#3B82F6' },
    high:   { label: 'High',   color: '#F59E0B' },
    urgent: { label: 'Urgent', color: '#EF4444' },
}

const TASK_STATUS_COLORS: Record<string, string> = {
    backlog:           '#6B7280',
    todo:              '#3B82F6',
    in_progress:       '#8B5CF6',
    awaiting_approval: '#F59E0B',
    review:            '#F59E0B',
    blocked:           '#EF4444',
    done:              '#10B981',
    cancelled:         '#6B7280',
}

// ─── MilestoneStatusBadge ─────────────────────────────────────────────────────

function MilestoneStatusBadge({ milestone, planId }: { milestone: Milestone; planId: string }) {
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

// ─── MilestoneCard ────────────────────────────────────────────────────────────

function MilestoneCard({ milestone, planId, tenantSlug }: { milestone: Milestone; planId: string; tenantSlug: string }) {
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

// ─── CreateMilestoneDialog ────────────────────────────────────────────────────

const createMilestoneSchema = z.object({
    title:       z.string().min(1, 'Title is required').max(200),
    description: z.string().optional(),
    targetDate:  z.string().optional(),
    priority:    z.enum(['low', 'medium', 'high', 'urgent']).optional(),
})
type CreateMilestoneForm = z.infer<typeof createMilestoneSchema>

function CreateMilestoneDialog({
    open, onOpenChange, planId, members,
}: {
    open: boolean
    onOpenChange: (v: boolean) => void
    planId: string
    members: Member[]
}) {
    const queryClient = useQueryClient()
    const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null)
    const [selectedPriority, setSelectedPriority] = useState<Priority>('medium')
    const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateMilestoneForm>({
        resolver: zodResolver(createMilestoneSchema),
    })

    const mutation = useMutation({
        mutationFn: (data: CreateMilestoneForm) => api.post(`/api/v1/plans/${planId}/milestones`, {
            title:       data.title,
            description: data.description || undefined,
            targetDate:  data.targetDate ? new Date(data.targetDate).toISOString() : undefined,
            priority:    selectedPriority,
            assigneeId:  selectedAssigneeId || undefined,
        }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.milestones(planId) })
            queryClient.invalidateQueries({ queryKey: pmKeys.planSummary(planId) })
            toast.success('Milestone created')
            reset()
            setSelectedAssigneeId(null)
            setSelectedPriority('medium')
            onOpenChange(false)
        },
        onError: () => toast.error('Failed to create milestone'),
    })

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) { reset(); setSelectedAssigneeId(null); setSelectedPriority('medium') } onOpenChange(v) }}>
            <DialogContent className="bg-[#0f0f0f] border-[#1e1e1e]">
                <DialogHeader>
                    <DialogTitle>New Milestone</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4 pt-2">
                    <div className="space-y-1.5">
                        <Label>Title <span className="text-destructive">*</span></Label>
                        <Input {...register('title')} placeholder="Milestone title" className="bg-[#1a1a1a] border-[#2a2a2a]" autoFocus />
                        {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
                    </div>
                    <div className="space-y-1.5">
                        <Label>Description <span className="text-xs text-muted-foreground">(optional)</span></Label>
                        <Textarea {...register('description')} placeholder="What needs to be done?" rows={2} className="bg-[#1a1a1a] border-[#2a2a2a] resize-none" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label>Target Date</Label>
                            <Input {...register('targetDate')} type="date" className="bg-[#1a1a1a] border-[#2a2a2a]" />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Priority</Label>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button className="flex items-center gap-1.5 w-full px-3 py-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] text-sm text-foreground hover:bg-[#222] transition-colors">
                                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: PRIORITY_CONFIG[selectedPriority].color }} />
                                        {PRIORITY_CONFIG[selectedPriority].label}
                                        <ChevronDown className="w-3.5 h-3.5 ml-auto opacity-50" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                                    {(Object.entries(PRIORITY_CONFIG) as [Priority, typeof PRIORITY_CONFIG[Priority]][]).map(([k, cfg]) => (
                                        <DropdownMenuItem key={k} className="text-xs gap-2" onSelect={() => setSelectedPriority(k)}>
                                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: cfg.color }} />
                                            {cfg.label}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>
                    {members.length > 0 && (
                        <div className="space-y-1.5">
                            <Label>Assignee <span className="text-xs text-muted-foreground">(optional)</span></Label>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button className="flex items-center gap-1.5 w-full px-3 py-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] text-sm text-foreground hover:bg-[#222] transition-colors">
                                        <Users className="w-3.5 h-3.5 opacity-50" />
                                        {selectedAssigneeId
                                            ? (members.find(m => m.userId === selectedAssigneeId)?.userName ?? 'Unknown')
                                            : 'No assignee'}
                                        <ChevronDown className="w-3.5 h-3.5 ml-auto opacity-50" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                                    <DropdownMenuItem className="text-xs" onSelect={() => setSelectedAssigneeId(null)}>
                                        No assignee
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator className="bg-[#2a2a2a]" />
                                    {members.map(m => (
                                        <DropdownMenuItem key={m.userId} className="text-xs" onSelect={() => setSelectedAssigneeId(m.userId)}>
                                            {m.userName || m.userEmail}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => { reset(); setSelectedAssigneeId(null); setSelectedPriority('medium'); onOpenChange(false) }}>Cancel</Button>
                        <Button type="submit" disabled={mutation.isPending}>
                            {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating…</> : 'Create Milestone'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

// ─── OverviewTab ──────────────────────────────────────────────────────────────

function OverviewTab({ planId, tenantSlug }: { planId: string; tenantSlug: string }) {
    const router = useRouter()

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
            {/* Stats */}
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

            {/* Upcoming milestones */}
            {upcoming.length > 0 && (
                <div>
                    <h2 className="text-sm font-medium text-foreground mb-3">Upcoming Milestones</h2>
                    <div className="space-y-2">
                        {upcoming.map(m => (
                            <MilestoneCard
                                key={m.id}
                                milestone={m}
                                planId={planId}
                                tenantSlug={tenantSlug}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── MilestonesTab ────────────────────────────────────────────────────────────

function MilestonesTab({ planId, tenantSlug, members }: { planId: string; tenantSlug: string; members: Member[] }) {
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

// ─── TasksTab ─────────────────────────────────────────────────────────────────

function TasksTab({ planId, tenantSlug, milestones }: { planId: string; tenantSlug: string; milestones: Milestone[] }) {
    const router = useRouter()
    const queryClient = useQueryClient()
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

    const { data, isLoading, isError, refetch } = useQuery<{ data: PlanTask[] }>({
        queryKey: pmKeys.planTasks(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}/tasks`),
    })

    const deleteTask = useMutation({
        mutationFn: (taskId: string) => api.del(`/api/v1/tasks/${taskId}`),
        onError: () => toast.error('Failed to delete a task'),
    })

    const handleBulkDelete = async () => {
        for (const id of selected) {
            await deleteTask.mutateAsync(id)
        }
        queryClient.invalidateQueries({ queryKey: pmKeys.planTasks(planId) })
        toast.success(`${selected.size} task${selected.size !== 1 ? 's' : ''} deleted`)
        setSelected(new Set())
        setBulkDeleteOpen(false)
    }

    const toggleOne = (id: string) => setSelected(prev => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
    })

    const toggleAll = (ids: string[]) => setSelected(prev => {
        const allSelected = ids.every(id => prev.has(id))
        const next = new Set(prev)
        if (allSelected) ids.forEach(id => next.delete(id))
        else ids.forEach(id => next.add(id))
        return next
    })

    const tasks = data?.data ?? []

    // Group by milestoneId client-side
    const milestoneMap = new Map(milestones.map(m => [m.id, m]))
    const grouped = tasks.reduce<Record<string, PlanTask[]>>((acc, t) => {
        const key = t.milestoneId ?? '__unassigned'
        if (!acc[key]) acc[key] = []
        acc[key].push(t)
        return acc
    }, {})

    const milestoneGroups = milestones.filter(m => grouped[m.id]?.length)
    const unassigned = grouped['__unassigned'] ?? []

    return (
        <div className="pt-4 pb-20">
            {isLoading && (
                <div className="space-y-2">
                    {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
                </div>
            )}

            {isError && (
                <div className="py-8 text-center">
                    <p className="text-sm text-destructive">Failed to load tasks</p>
                    <Button size="sm" variant="ghost" className="mt-2" onClick={() => refetch()}>Retry</Button>
                </div>
            )}

            {!isLoading && !isError && tasks.length === 0 && (
                <p className="text-sm text-muted-foreground py-8 text-center">No tasks in this plan yet</p>
            )}

            {/* Milestone groups */}
            {milestoneGroups.map(m => (
                <div key={m.id} className="mb-5">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] text-muted-foreground/50 uppercase tracking-tighter">MST-{m.sequenceId}</span>
                        <h3 className="text-sm font-medium text-foreground">{m.title}</h3>
                        <span className="text-xs text-muted-foreground/50">({grouped[m.id].length})</span>
                    </div>
                    <TaskListGroup tasks={grouped[m.id]} tenantSlug={tenantSlug} selected={selected} onToggle={toggleOne} onToggleAll={toggleAll} />
                </div>
            ))}

            {/* Unassigned */}
            {unassigned.length > 0 && (
                <div className="mb-5">
                    <h3 className="text-sm font-medium text-muted-foreground/60 mb-2">Unassigned</h3>
                    <TaskListGroup tasks={unassigned} tenantSlug={tenantSlug} selected={selected} onToggle={toggleOne} onToggleAll={toggleAll} />
                </div>
            )}

            {/* Bulk action toolbar */}
            {selected.size > 0 && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-2.5 shadow-2xl">
                    <span className="text-sm text-foreground font-medium">{selected.size} selected</span>
                    <Button size="sm" variant="destructive" onClick={() => setBulkDeleteOpen(true)} disabled={deleteTask.isPending}>
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                        Delete
                    </Button>
                    <button onClick={() => setSelected(new Set())} className="text-muted-foreground hover:text-foreground transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            <ConfirmDialog
                open={bulkDeleteOpen}
                onOpenChange={setBulkDeleteOpen}
                title={`Delete ${selected.size} task${selected.size !== 1 ? 's' : ''}?`}
                description="Selected tasks will be permanently deleted. This cannot be undone."
                confirmLabel="Delete"
                onConfirm={handleBulkDelete}
                loading={deleteTask.isPending}
            />
        </div>
    )
}

function TaskListGroup({ tasks, tenantSlug, selected, onToggle, onToggleAll }: {
    tasks: PlanTask[]
    tenantSlug: string
    selected: Set<string>
    onToggle: (id: string) => void
    onToggleAll: (ids: string[]) => void
}) {
    const router = useRouter()
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const ids = tasks.map(t => t.id)
    const allSelected = ids.length > 0 && ids.every(id => selected.has(id))
    const someSelected = ids.some(id => selected.has(id))
    return (
        <div className="border border-[#1e1e1e] rounded-lg divide-y divide-[#1e1e1e]">
            {/* Select-all header row */}
            <div className="flex items-center gap-3 px-4 py-2 bg-[#0d0d0d] rounded-t-lg">
                <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={() => onToggleAll(ids)}
                    className="shrink-0"
                />
                <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Select all</span>
            </div>
            {tasks.map(t => {
                const dotColor = TASK_STATUS_COLORS[t.status] ?? '#6B7280'
                const isOpen = expandedId === t.id
                const isSelected = selected.has(t.id)
                return (
                    <div key={t.id} className={cn(isSelected && 'bg-primary/5')}>
                        <div className="flex items-center gap-3 w-full px-4 py-2.5 hover:bg-[#111] transition-colors group">
                            <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => onToggle(t.id)}
                                className="shrink-0 opacity-0 group-hover:opacity-100 data-[state=checked]:opacity-100 transition-opacity"
                            />
                            <button
                                onClick={() => setExpandedId(isOpen ? null : t.id)}
                                className="shrink-0 text-muted-foreground/30 hover:text-muted-foreground transition-colors"
                            >
                                <ChevronRight className={cn('w-3.5 h-3.5 transition-transform duration-150', isOpen && 'rotate-90')} />
                            </button>
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
                            {t.sequenceId && (
                                <span className="text-[10px] text-muted-foreground/50 font-medium uppercase tracking-tighter shrink-0">
                                    TASK-{t.sequenceId}
                                </span>
                            )}
                            <button
                                onClick={() => router.push(`/${tenantSlug}/dashboard/board/${t.id}`)}
                                className="text-sm text-foreground/80 flex-1 truncate text-left hover:text-foreground transition-colors"
                            >
                                {t.title}
                            </button>
                            <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: PRIORITY_CONFIG[t.priority]?.color ?? '#6B7280' }} />
                        </div>
                        {isOpen && (
                            <div className="px-10 pb-3 pt-2 bg-[#0a0a0a] border-t border-[#1e1e1e] space-y-3">
                                {t.description && (
                                    <p className="text-xs text-muted-foreground/60 leading-relaxed">{t.description}</p>
                                )}
                                <div>
                                    <p className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider mb-1.5">Acceptance Criteria</p>
                                    {(t.acceptanceCriteria ?? []).map(ac => typeof ac === 'string' ? { text: ac, checked: false } : ac).filter(ac => ac.text?.trim()).length === 0 ? (
                                        <p className="text-xs text-muted-foreground/30 italic">No criteria defined</p>
                                    ) : (
                                        <div className="space-y-1">
                                            {(t.acceptanceCriteria ?? []).map(ac => typeof ac === 'string' ? { text: ac, checked: false } : ac).filter(ac => ac.text?.trim()).map((ac, i) => (
                                                <div key={i} className="flex items-center gap-2">
                                                    <div className="w-3.5 h-3.5 rounded border border-[#2a2a2a] shrink-0" />
                                                    <span className="text-xs text-muted-foreground/60">{ac.text}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center gap-4 pt-0.5">
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground/50">
                                        <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: PRIORITY_CONFIG[t.priority]?.color ?? '#6B7280' }} />
                                        {PRIORITY_CONFIG[t.priority]?.label ?? t.priority}
                                    </span>
                                    <span className="text-xs text-muted-foreground/40">
                                        {t.estimatedHours && Number(t.estimatedHours) > 0 ? `${Number(t.estimatedHours)}h` : '—'}
                                    </span>
                                    <button
                                        onClick={() => router.push(`/${tenantSlug}/dashboard/board/${t.id}`)}
                                        className="text-xs text-blue-400/60 hover:text-blue-400 transition-colors ml-auto"
                                    >
                                        Open in Board →
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

// ─── PlanDetailPage ───────────────────────────────────────────────────────────

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
            {/* Breadcrumb */}
            <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
                <Link href={`/${tenantSlug}/dashboard/plans`} className="hover:text-foreground transition-colors">Plans</Link>
                <ChevronRight className="w-3 h-3" />
                <span className="text-foreground">{plan.title}</span>
            </nav>

            {/* Header */}
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
                    <button
                        onClick={() => setDeleteConfirmOpen(true)}
                        className="text-muted-foreground/40 hover:text-destructive transition-colors"
                        aria-label="Delete plan"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Tabs */}
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

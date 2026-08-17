'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format, isPast } from 'date-fns'
import { Plus, Loader2, Trash2, LayoutList, CalendarDays, ChevronDown } from 'lucide-react'
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
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// ─── Types ────────────────────────────────────────────────────────────────────

type PlanStatus = 'draft' | 'active' | 'completed' | 'archived'

type Plan = {
    id: string
    sequenceId: number
    title: string
    description: string | null
    status: PlanStatus
    startDate: string | null
    targetDate: string | null
    createdAt: string
    updatedAt: string
}

type PlanSummary = {
    totalMilestones: number
    completedMilestones: number
    totalTasks: number
    completedTasks: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<PlanStatus, { label: string; color: string; bg: string; hex: string }> = {
    draft:     { label: 'Draft',     color: 'text-gray-400',   bg: 'bg-gray-500/10',    hex: '#6B7280' },
    active:    { label: 'Active',    color: 'text-blue-400',   bg: 'bg-blue-500/10',    hex: '#3B82F6' },
    completed: { label: 'Completed', color: 'text-emerald-400', bg: 'bg-emerald-500/10', hex: '#10B981' },
    archived:  { label: 'Archived',  color: 'text-gray-500',   bg: 'bg-gray-500/10',    hex: '#6B7280' },
}

const VALID_PLAN_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
    draft:     ['active', 'archived'],
    active:    ['completed', 'archived'],
    completed: [],
    archived:  [],
}

function formatRelative(dateString: string) {
    const date = new Date(dateString)
    const diffMs = Date.now() - date.getTime()
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 30) return `${diffDays}d ago`
    return format(date, 'MMM d, yyyy')
}

// ─── PlanSummaryBar ───────────────────────────────────────────────────────────

function PlanSummaryBar({ planId }: { planId: string }) {
    const { data } = useQuery<{ data: PlanSummary }>({
        queryKey: pmKeys.planSummary(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}/summary`),
    })

    if (!data) return <div className="h-1.5 w-full rounded-full bg-secondary" />

    const { totalMilestones, completedMilestones } = data.data
    const pct = totalMilestones > 0 ? Math.round((completedMilestones / totalMilestones) * 100) : 0

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
                <span>{completedMilestones}/{totalMilestones} milestones</span>
                <span>{pct}%</span>
            </div>
            <Progress value={pct} className="h-1.5" />
        </div>
    )
}

// ─── StatusDropdown ───────────────────────────────────────────────────────────

function StatusDropdown({ plan, tenantId }: { plan: Plan; tenantId: string }) {
    const queryClient = useQueryClient()
    const cfg = STATUS_CONFIG[plan.status]
    const nextStatuses = VALID_PLAN_TRANSITIONS[plan.status]

    const mutation = useMutation({
        mutationFn: (newStatus: PlanStatus) =>
            api.patch(`/api/v1/plans/${plan.id}`, { status: newStatus }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.plans(tenantId) })
            queryClient.invalidateQueries({ queryKey: pmKeys.plan(plan.id) })
            toast.success('Plan status updated')
        },
        onError: () => toast.error('Failed to update status'),
    })

    if (nextStatuses.length === 0) {
        return (
            <span className={cn('text-xs px-2 py-0.5 rounded font-medium', cfg.bg, cfg.color)}>
                {cfg.label}
            </span>
        )
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    onClick={e => e.stopPropagation()}
                    className={cn(
                        'flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium transition-opacity hover:opacity-80',
                        cfg.bg, cfg.color
                    )}
                >
                    {cfg.label}
                    <ChevronDown className="w-3 h-3" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-secondary border-input" align="start" onClick={e => e.stopPropagation()}>
                {nextStatuses.map(s => (
                    <DropdownMenuItem
                        key={s}
                        className="text-xs"
                        onSelect={() => mutation.mutate(s)}
                    >
                        <span className={cn('text-xs font-medium', STATUS_CONFIG[s].color)}>
                            {STATUS_CONFIG[s].label}
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

// ─── PlanCard ─────────────────────────────────────────────────────────────────

function PlanCard({ plan, tenantId, tenantSlug }: { plan: Plan; tenantId: string; tenantSlug: string }) {
    const router = useRouter()
    const queryClient = useQueryClient()
    const isOverdue = plan.targetDate && plan.status !== 'completed' && isPast(new Date(plan.targetDate))
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

    const deletePlan = useMutation({
        mutationFn: () => api.del(`/api/v1/plans/${plan.id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.plans(tenantId) })
            toast.success('Plan deleted')
        },
        onError: () => toast.error('Failed to delete plan'),
    })

    return (
        <>
            <div
                onClick={() => router.push(`/${tenantSlug}/dashboard/plans/${plan.id}`)}
                className="border border-border bg-card rounded-xl p-5 cursor-pointer hover:border-foreground/20 transition-colors flex flex-col gap-3"
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-muted-foreground/50 font-medium uppercase tracking-tighter">
                            PLN-{plan.sequenceId}
                        </span>
                        <StatusDropdown plan={plan} tenantId={tenantId} />
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {plan.targetDate && (
                            <span className={cn('text-xs', isOverdue ? 'text-red-400' : 'text-muted-foreground/60')}>
                                <CalendarDays className="w-3 h-3 inline mr-1" />
                                {format(new Date(plan.targetDate), 'MMM d, yyyy')}
                            </span>
                        )}
                        <button
                            onClick={e => { e.stopPropagation(); setDeleteConfirmOpen(true) }}
                            className="text-muted-foreground/30 hover:text-destructive transition-colors"
                            aria-label="Delete plan"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>

                {/* Title */}
                <h3 className="text-sm font-semibold text-foreground leading-snug">
                    {plan.title}
                </h3>

                {/* Progress */}
                <PlanSummaryBar planId={plan.id} />

                {/* Footer */}
                <p className="text-[10px] text-muted-foreground/40">
                    Created {formatRelative(plan.createdAt)}
                </p>
            </div>

            <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                <AlertDialogContent className="bg-popover border-border">
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
        </>
    )
}

// ─── CreatePlanDialog ─────────────────────────────────────────────────────────

const createPlanSchema = z.object({
    title: z.string().min(1, 'Title is required').max(200),
    description: z.string().optional(),
    targetDate: z.string().optional(),
})
type CreatePlanForm = z.infer<typeof createPlanSchema>

function CreatePlanDialog({ open, onOpenChange, tenantId }: { open: boolean; onOpenChange: (v: boolean) => void; tenantId: string }) {
    const queryClient = useQueryClient()
    const { register, handleSubmit, reset, formState: { errors } } = useForm<CreatePlanForm>({
        resolver: zodResolver(createPlanSchema as any),
    })

    const mutation = useMutation({
        mutationFn: (data: CreatePlanForm) => api.post('/api/v1/plans', {
            title: data.title,
            description: data.description || undefined,
            targetDate: data.targetDate ? new Date(data.targetDate).toISOString() : undefined,
        }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.plans(tenantId) })
            toast.success('Plan created')
            reset()
            onOpenChange(false)
        },
        onError: () => toast.error('Failed to create plan'),
    })

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v) }}>
            <DialogContent className="bg-popover border-border">
                <DialogHeader>
                    <DialogTitle>New Plan</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit(data => mutation.mutate(data))} className="space-y-4 pt-2">
                    <div className="space-y-1.5">
                        <Label>Title <span className="text-destructive">*</span></Label>
                        <Input
                            {...register('title')}
                            placeholder="Plan title"
                            className="bg-secondary border-input"
                            autoFocus
                        />
                        {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
                    </div>
                    <div className="space-y-1.5">
                        <Label>Description <span className="text-xs text-muted-foreground">(optional)</span></Label>
                        <Textarea
                            {...register('description')}
                            placeholder="What is this plan about?"
                            rows={3}
                            className="bg-secondary border-input resize-none"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Target Date <span className="text-xs text-muted-foreground">(optional)</span></Label>
                        <Input
                            {...register('targetDate')}
                            type="date"
                            className="bg-secondary border-input"
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => { reset(); onOpenChange(false) }}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={mutation.isPending}>
                            {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating…</> : 'Create Plan'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

// ─── PlansView ────────────────────────────────────────────────────────────────

export default function PlansPage() {
    const params = useParams()
    const tenantSlug = params.tenant as string
    const { tenantId } = useTenant()
    const [createOpen, setCreateOpen] = useState(false)

    const { data, isLoading, isError } = useQuery<{ data: Plan[] }>({
        queryKey: pmKeys.plans(tenantId),
        queryFn: () => api.get('/api/v1/plans'),
    })

    const plans = data?.data ?? []

    return (
        <div className="flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Plans</h1>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="w-4 h-4 mr-1.5" />
                    New Plan
                </Button>
            </div>

            {/* Loading */}
            {isLoading && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="bg-card border border-border rounded-xl p-5 space-y-3">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-5 w-48" />
                            <Skeleton className="h-1.5 w-full rounded-full" />
                        </div>
                    ))}
                </div>
            )}

            {/* Error */}
            {isError && (
                <p className="text-sm text-destructive">Failed to load plans.</p>
            )}

            {/* Empty */}
            {!isLoading && !isError && plans.length === 0 && (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                    <LayoutList className="w-10 h-10 text-muted-foreground/30 mb-4" />
                    <p className="text-sm font-medium text-muted-foreground">No plans yet</p>
                    <p className="text-xs text-muted-foreground/50 mt-1 mb-4">Create a plan to organise milestones and tasks</p>
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                        <Plus className="w-4 h-4 mr-1.5" /> New Plan
                    </Button>
                </div>
            )}

            {/* Plan cards */}
            {!isLoading && plans.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {plans.map(plan => (
                        <PlanCard
                            key={plan.id}
                            plan={plan}
                            tenantId={tenantId}
                            tenantSlug={tenantSlug}
                        />
                    ))}
                </div>
            )}

            <CreatePlanDialog open={createOpen} onOpenChange={setCreateOpen} tenantId={tenantId} />
        </div>
    )
}

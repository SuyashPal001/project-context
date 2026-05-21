'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, X, ChevronRight } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/platform/shared/ConfirmDialog'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { pmKeys } from '@/lib/query-keys/pm'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { type Milestone, type PlanTask, TASK_STATUS_COLORS, PRIORITY_CONFIG } from './_types'

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

export function TasksTab({ planId, tenantSlug, milestones }: { planId: string; tenantSlug: string; milestones: Milestone[] }) {
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

            {unassigned.length > 0 && (
                <div className="mb-5">
                    <h3 className="text-sm font-medium text-muted-foreground/60 mb-2">Unassigned</h3>
                    <TaskListGroup tasks={unassigned} tenantSlug={tenantSlug} selected={selected} onToggle={toggleOne} onToggleAll={toggleAll} />
                </div>
            )}

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

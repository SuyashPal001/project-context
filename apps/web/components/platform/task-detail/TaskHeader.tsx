'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, ArrowDown, ChevronRight, Pencil, MoreHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/platform/shared/ConfirmDialog'
import { api } from '@/lib/api'
import { pmKeys } from '@/lib/query-keys/pm'
import { useTenant } from '@/app/[tenant]/tenant-provider'
import type { Task, TaskDetailResponse } from '@/types/task'

interface TaskHeaderProps {
    task: Task
    editState: {
        isEditing: boolean
        onEdit: () => void
        onCancel: () => void
        onSave: () => void
    }
    taskOperations: {
        vote: (direction: 'up' | 'down') => Promise<void>
        deleteTask: () => Promise<void>
    }
}

function Sep() {
    return <ChevronRight className="w-3 h-3 text-muted-foreground/40 mx-0.5 shrink-0" />
}

function seqLabel(sequenceId: number | null | undefined, id: string) {
    return sequenceId != null ? `TASK-${sequenceId}` : `TASK-${id.slice(0, 6).toUpperCase()}`
}

export function TaskHeader({ task, editState, taskOperations }: TaskHeaderProps) {
    const params = useParams()
    const tenantSlug = params.tenant as string
    const base = `/${tenantSlug}/dashboard`
    const [deleteOpen, setDeleteOpen] = useState(false)

    // Ownership/permission gate: owner/admin (with agent_tasks:delete) can modify any task.
    // Members can edit tasks they created or that are assigned to them; delete is creator-only.
    const { userId, permissions } = useTenant()
    const canManageAny = !!permissions?.includes('agent_tasks:delete')
    const isCreator = !!task.createdBy && task.createdBy === userId
    const isAssignee = !!task.assigneeId && task.assigneeId === userId
    const canEdit = canManageAny || isCreator || isAssignee
    const canDelete = canManageAny || isCreator

    // ── Plan + milestone (only when task belongs to a plan) ───────────────────
    const { data: planData } = useQuery<{ data: { id: string; title: string } }>({
        queryKey: pmKeys.plan(task.planId!),
        queryFn: () => api.get(`/api/v1/plans/${task.planId}`),
        enabled: !!task.planId,
    })

    const { data: milestonesData } = useQuery<{ data: Array<{ id: string; title: string }> }>({
        queryKey: pmKeys.milestones(task.planId!),
        queryFn: () => api.get(`/api/v1/plans/${task.planId}/milestones`),
        enabled: !!task.planId && !!task.milestoneId,
    })

    // ── Parent task (only for subtasks) ───────────────────────────────────────
    const { data: parentData } = useQuery<TaskDetailResponse>({
        queryKey: ['task', task.parentTaskId!],
        queryFn: () => api.get<TaskDetailResponse>(`/api/v1/tasks/${task.parentTaskId}`),
        enabled: !!task.parentTaskId,
    })

    const plan = planData?.data
    const milestone = milestonesData?.data?.find(m => m.id === task.milestoneId)
    const parentTask = parentData?.data?.task
    const label = seqLabel(task.sequenceId, task.id)

    // ── Breadcrumb ────────────────────────────────────────────────────────────
    let breadcrumb: React.ReactNode

    if (task.planId) {
        const planSegment = plan
            ? <Link href={`${base}/plans/${task.planId}`} className="hover:text-foreground truncate max-w-[140px]">{plan.title}</Link>
            : <span className="text-muted-foreground/30">…</span>

        const milestoneSegment = milestone
            ? <Link href={`${base}/plans/${task.planId}/milestones/${task.milestoneId}`} className="hover:text-foreground truncate max-w-[140px]">{milestone.title}</Link>
            : <span className="text-muted-foreground/30">…</span>

        if (task.parentTaskId) {
            // Subtask inside a milestone
            const parentLabel = parentTask
                ? seqLabel(parentTask.sequenceId, parentTask.id)
                : '…'
            breadcrumb = (
                <>
                    <Link href={`${base}/plans`} className="hover:text-foreground shrink-0">Plans</Link>
                    <Sep />
                    {planSegment}
                    <Sep />
                    {milestoneSegment}
                    <Sep />
                    <Link
                        href={`${base}/board/${task.parentTaskId}`}
                        className="hover:text-foreground flex items-center gap-1 shrink-0"
                    >
                        <span>{parentLabel}</span>
                        {parentTask?.title && (
                            <span className="truncate max-w-[160px] text-muted-foreground/60">{parentTask.title}</span>
                        )}
                    </Link>
                    <Sep />
                    <span className="text-foreground shrink-0">{label}</span>
                </>
            )
        } else {
            // Task inside a milestone, no parent
            breadcrumb = (
                <>
                    <Link href={`${base}/plans`} className="hover:text-foreground shrink-0">Plans</Link>
                    <Sep />
                    {planSegment}
                    <Sep />
                    {milestoneSegment}
                    <Sep />
                    <span className="text-foreground shrink-0">{label}</span>
                </>
            )
        }
    } else if (task.parentTaskId) {
        // Floating subtask (no plan)
        const parentLabel = parentTask
            ? seqLabel(parentTask.sequenceId, parentTask.id)
            : '…'
        breadcrumb = (
            <>
                <Link href={`${base}/board`} className="hover:text-foreground shrink-0">Board</Link>
                <Sep />
                <Link href={`${base}/board/${task.parentTaskId}`} className="hover:text-foreground shrink-0">{parentLabel}</Link>
                <Sep />
                <span className="text-foreground shrink-0">{label}</span>
            </>
        )
    } else {
        // Floating task (no plan, no parent)
        breadcrumb = (
            <>
                <Link href={`${base}/board`} className="hover:text-foreground shrink-0">Board</Link>
                <Sep />
                <span className="text-foreground shrink-0">{label}</span>
            </>
        )
    }

    return (
        <div className="flex items-center justify-between px-8 py-3 border-b border-[#1e1e1e] flex-shrink-0">
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-xs text-muted-foreground/60 min-w-0 overflow-hidden">
                {breadcrumb}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0 ml-4">
                {/* Vote buttons */}
                <button
                    onClick={() => taskOperations.vote('up')}
                    className="rounded-md bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-1 text-xs flex items-center gap-1 text-muted-foreground hover:bg-[#222] transition-colors"
                >
                    <ArrowUp className="w-3 h-3" /> {task.upvotes || 0}
                </button>
                <button
                    onClick={() => taskOperations.vote('down')}
                    className="rounded-md bg-[#1a1a1a] border border-[#2a2a2a] px-2 py-1 text-xs flex items-center gap-1 text-muted-foreground hover:bg-[#222] transition-colors"
                >
                    <ArrowDown className="w-3 h-3" /> {task.downvotes || 0}
                </button>

                {/* Edit / Cancel / Save — only when user can modify the task */}
                {canEdit && (editState.isEditing ? (
                    <>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs px-2 text-muted-foreground"
                            onClick={editState.onCancel}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            className="h-7 text-xs px-3 bg-primary text-primary-foreground hover:bg-primary/90"
                            onClick={editState.onSave}
                        >
                            Save
                        </Button>
                    </>
                ) : (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs px-2 gap-1.5 text-muted-foreground hover:text-foreground"
                        onClick={editState.onEdit}
                    >
                        <Pencil className="w-3 h-3" /> Edit
                    </Button>
                ))}

                {/* Delete dropdown — only when user can delete the task */}
                {canDelete && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="w-7 h-7 text-muted-foreground">
                                <MoreHorizontal className="w-4 h-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onClick={() => setDeleteOpen(true)}
                                className="text-red-500 focus:text-red-400 focus:bg-red-500/10 cursor-pointer"
                            >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete task"
                description="This task will be permanently deleted. This cannot be undone."
                confirmLabel="Delete"
                onConfirm={taskOperations.deleteTask}
            />
        </div>
    )
}

'use client'

import { useState } from 'react'
import { Play, XCircle } from 'lucide-react'
import { ConfirmDialog } from '@/components/platform/shared/ConfirmDialog'

interface SidebarActionsProps {
    status: string
    onStartTask: () => void
    onDeleteTask: () => Promise<void>
}

// Plan approval intentionally has no button here: it's gated behind a cost
// preview (TaskExecutionCost, rendered by PlanReviewPhase in the main
// content column) because approving is the human action that commits the
// tenant's credits. A second, ungated "Approve Plan" button here would let a
// user bypass that gate one click away on the same screen — see task-15 fix
// round 2.
export function SidebarActions({ status, onStartTask, onDeleteTask }: SidebarActionsProps) {
    const [deleteOpen, setDeleteOpen] = useState(false)

    return (
        <>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Actions</div>

            <div className="space-y-1.5">
                {status === 'ready' && (
                    <button onClick={onStartTask} className="flex items-center gap-2 w-full px-2 py-2 rounded-lg text-xs text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground transition-colors text-left">
                        <Play className="w-4 h-4 text-primary" />
                        <span className="text-primary/90 font-medium">Approve</span>
                    </button>
                )}
                {status !== 'done' && status !== 'cancelled' && (
                    <button onClick={() => setDeleteOpen(true)} className="flex items-center gap-2 w-full px-2 py-2 rounded-lg text-xs text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground transition-colors text-left">
                        <XCircle className="w-4 h-4 text-red-500" />
                        <span className="text-red-500/90 font-medium">Delete Task</span>
                    </button>
                )}
            </div>

            <ConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete task"
                description="This task will be permanently deleted. This cannot be undone."
                confirmLabel="Delete"
                onConfirm={onDeleteTask}
            />
        </>
    )
}

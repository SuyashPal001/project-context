'use client'

import { useState } from 'react'
import { CheckCircle, Play, XCircle } from 'lucide-react'
import { ConfirmDialog } from '@/components/platform/shared/ConfirmDialog'

interface SidebarActionsProps {
    status: string
    onApprovePlan: () => void
    onStartTask: () => void
    onDeleteTask: () => Promise<void>
}

export function SidebarActions({ status, onApprovePlan, onStartTask, onDeleteTask }: SidebarActionsProps) {
    const [deleteOpen, setDeleteOpen] = useState(false)

    return (
        <>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Actions</div>

            <div className="space-y-1.5">
                {status === 'awaiting_approval' && (
                    <button onClick={onApprovePlan} className="flex items-center gap-2 w-full px-2 py-2 rounded-lg text-xs text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground transition-colors text-left">
                        <CheckCircle className="w-4 h-4 text-emerald-500" />
                        <span className="text-emerald-500/90 font-medium">Approve Plan</span>
                    </button>
                )}
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

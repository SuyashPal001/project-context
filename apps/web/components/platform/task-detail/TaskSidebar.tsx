'use client'

import { ChevronDown, Clock, Target, LayoutList, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Task, Step } from '@/types/task'
import { formatRelativeTime } from './_sidebarHelpers'
import { SidebarEditableRows } from './SidebarEditableRows'
import { SidebarLinks } from './SidebarLinks'
import { SidebarAttachments } from './SidebarAttachments'
import { SidebarReference } from './SidebarReference'
import { SidebarActions } from './SidebarActions'

interface TaskSidebarProps {
    task: Task
    steps: Step[]
    editState: {
        isEditing: boolean
        draftStatus: string
        draftPriority: string
        draftAssigneeKey: string
        setDraftStatus: (v: string) => void
        setDraftPriority: (v: string) => void
        setDraftAssigneeKey: (v: string) => void
    }
    assigneeOptions: Array<{ type: 'agent' | 'member'; id: string; name: string }>
    selectedAssignee: { type: 'agent' | 'member'; id: string; name: string } | null
    isUploadingAttachment: boolean
    attachFileInputRef: React.RefObject<HTMLInputElement | null>
    newLinkInputRef: React.RefObject<HTMLInputElement | null>
    referenceTextRef: React.RefObject<HTMLTextAreaElement | null>
    taskOperations: {
        deleteTask: () => Promise<void>
        removeLink: (url: string) => void
        addLink: (url: string) => void
        removeAttachment: (fileId: string) => void
        startTask: () => void
        saveReferenceText: (text: string | null) => void
    }
}

export function TaskSidebar({
    task, steps, editState, assigneeOptions, selectedAssignee,
    isUploadingAttachment, attachFileInputRef, newLinkInputRef,
    referenceTextRef, taskOperations,
}: TaskSidebarProps) {
    const completedSteps = steps.filter(s => s.status === 'done').length

    return (
        <div className="w-[300px] border-l border-[#1e1e1e] flex-shrink-0 flex flex-col overflow-y-auto px-5 py-6">
            <div className="flex items-center justify-between mb-5">
                <h3 className="text-sm font-semibold text-foreground">Properties</h3>
                <p className="text-[11px] text-muted-foreground/50">Updated {formatRelativeTime(task.updatedAt)} ago</p>
            </div>

            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 cursor-default">
                Details
                <ChevronDown className="w-3.5 h-3.5" />
            </div>

            <div className="flex flex-col">
                <SidebarEditableRows
                    task={task}
                    isEditing={editState.isEditing}
                    draftStatus={editState.draftStatus}
                    draftPriority={editState.draftPriority}
                    draftAssigneeKey={editState.draftAssigneeKey}
                    setDraftStatus={editState.setDraftStatus}
                    setDraftPriority={editState.setDraftPriority}
                    setDraftAssigneeKey={editState.setDraftAssigneeKey}
                    assigneeOptions={assigneeOptions}
                    selectedAssignee={selectedAssignee}
                />

                {/* Est. Hours */}
                <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                    <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                        <Clock className="w-3.5 h-3.5 opacity-50" />
                        <span className="text-xs">Est. Hours</span>
                    </div>
                    <div className="text-xs text-foreground flex items-center gap-1.5">
                        {task.estimatedHours ? `${task.estimatedHours}h` : '—'}
                    </div>
                </div>

                {/* Confidence */}
                <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                    <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                        <Target className="w-3.5 h-3.5 opacity-50" />
                        <span className="text-xs">Confidence</span>
                    </div>
                    <div className="text-xs text-foreground flex items-center gap-1.5">
                        {task.confidenceScore ? (
                            <>
                                <div className={cn(
                                    'w-1.5 h-1.5 rounded-full',
                                    Number(task.confidenceScore) >= 0.8 ? 'bg-green-500'
                                        : Number(task.confidenceScore) >= 0.6 ? 'bg-amber-500'
                                        : 'bg-red-500',
                                )} />
                                {Math.round(Number(task.confidenceScore) * 100)}%
                            </>
                        ) : '—'}
                    </div>
                </div>

                {/* Steps */}
                <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                    <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                        <LayoutList className="w-3.5 h-3.5 opacity-50" />
                        <span className="text-xs">Steps</span>
                    </div>
                    <div className="text-xs text-foreground flex items-center gap-1.5">
                        {steps.length > 0 ? `${completedSteps} / ${steps.length} complete` : 'No steps yet'}
                    </div>
                </div>

                {/* Created */}
                <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                    <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                        <Calendar className="w-3.5 h-3.5 opacity-50" />
                        <span className="text-xs">Created</span>
                    </div>
                    <div className="text-xs text-foreground flex items-center gap-1.5">
                        {new Date(task.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                </div>

                {/* Updated */}
                <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                    <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                        <Clock className="w-3.5 h-3.5 opacity-50" />
                        <span className="text-xs">Updated</span>
                    </div>
                    <div className="text-xs text-foreground flex items-center gap-1.5">
                        {formatRelativeTime(task.updatedAt)} ago
                    </div>
                </div>

                <SidebarLinks
                    links={task.links}
                    isEditing={editState.isEditing}
                    newLinkInputRef={newLinkInputRef}
                    onAddLink={taskOperations.addLink}
                    onRemoveLink={taskOperations.removeLink}
                />

                <SidebarAttachments
                    attachmentFileIds={task.attachmentFileIds}
                    isUploading={isUploadingAttachment}
                    attachFileInputRef={attachFileInputRef}
                    onRemoveAttachment={taskOperations.removeAttachment}
                />

                <SidebarReference
                    referenceText={task.referenceText}
                    isEditing={editState.isEditing}
                    referenceTextRef={referenceTextRef}
                    onSave={taskOperations.saveReferenceText}
                />
            </div>

            <div className="my-5 border-t border-[#1e1e1e]" />

            <SidebarActions
                status={task.status}
                onStartTask={taskOperations.startTask}
                onDeleteTask={taskOperations.deleteTask}
            />
        </div>
    )
}

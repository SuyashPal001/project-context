'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2, Paperclip, FileText, CheckSquare, Square, Plus, Loader2, GitBranch, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { ExecutionConsole } from './ExecutionConsole'
import { ActivityFeed } from './ActivityFeed'
import { DescriptionEditor } from '@/components/editor/DescriptionEditor'
import type { Task, Step, TaskEvent, AcceptanceCriterion } from '@/types/task'
import { pmKeys } from '@/lib/query-keys/pm'

// ─── SubtaskRow ───────────────────────────────────────────────────────────────

const SUBTASK_STATUS_COLORS: Record<string, string> = {
    backlog:          '#6B7280',
    todo:             '#3B82F6',
    in_progress:      '#8B5CF6',
    awaiting_approval:'#F59E0B',
    review:           '#F59E0B',
    blocked:          '#EF4444',
    done:             '#10B981',
    cancelled:        '#6B7280',
}

type SubtaskItem = {
    id: string
    sequenceId: number | null
    title: string
    status: string
    assigneeId: string | null
}

function SubtaskRow({ subtask, tenantSlug, onClick }: { subtask: SubtaskItem; tenantSlug: string; onClick: () => void }) {
    const dotColor = SUBTASK_STATUS_COLORS[subtask.status] ?? '#6B7280'
    return (
        <button
            onClick={onClick}
            className="flex items-center gap-2.5 w-full text-left px-2 py-1.5 rounded hover:bg-[#1a1a1a] transition-colors group"
        >
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
            {subtask.sequenceId && (
                <span className="text-[10px] text-muted-foreground/50 font-medium uppercase tracking-tighter shrink-0">
                    TASK-{subtask.sequenceId}
                </span>
            )}
            <span className="text-sm text-foreground/80 truncate flex-1">{subtask.title}</span>
        </button>
    )
}

interface TaskMainContentProps {
    task: Task
    steps: Step[]
    events: TaskEvent[]
    taskId: string
    taskOperations: {
        approvePlan: (opts?: { approved: boolean; generalInstruction?: string }) => Promise<void>
        rejectPlan: () => Promise<void>
        generatePlan: () => Promise<void>
        sendClarification: (answer: string) => Promise<void>
        markDone: () => Promise<void>
        startTask: () => void
        updateTitle: (title: string) => Promise<void>
        updateDescription: (desc: string) => Promise<void>
        updateCriteria: (criteria: AcceptanceCriterion[]) => void | Promise<void>
        addLink: (url: string, label?: string) => void | Promise<void>
        removeLink: (url: string) => void | Promise<void>
        removeAttachment: (fileId: string) => void | Promise<void>
        focusLinkInput: () => void
        focusReferenceInput: () => void
        triggerAttachFile: () => void
    }
    editState: {
        isEditing: boolean
    }
}

export function TaskMainContent({ task, steps, events, taskId, taskOperations, editState }: TaskMainContentProps) {
    const { isEditing } = editState
    const [editingTitle, setEditingTitle] = useState(task.title)
    const params = useParams()
    const router = useRouter()
    const queryClient = useQueryClient()
    const tenantSlug = params.tenant as string

    // Subtask state
    const [addingSubtask, setAddingSubtask] = useState(false)
    const [subtaskTitle, setSubtaskTitle] = useState('')
    const subtaskInputRef = useRef<HTMLInputElement>(null)

    const { data: subtasksData } = useQuery<{ data: SubtaskItem[] }>({
        queryKey: pmKeys.subtasks(taskId),
        queryFn: () => api.get(`/api/v1/tasks?parentTaskId=${taskId}`),
    })
    const subtasks = subtasksData?.data ?? []

    const { data: parentTaskData } = useQuery<{ data: { task: { id: string; sequenceId?: number | null; title: string } } }>({
        queryKey: ['task', task.parentTaskId],
        queryFn: () => api.get(`/api/v1/tasks/${task.parentTaskId}`),
        enabled: !!task.parentTaskId,
        staleTime: 60_000,
    })
    const parentTask = parentTaskData?.data?.task

    const createSubtask = useMutation({
        mutationFn: (title: string) => api.post('/api/v1/tasks', { title, parentTaskId: taskId }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.subtasks(taskId) })
            setSubtaskTitle('')
            setAddingSubtask(false)
            toast.success('Subtask created')
        },
        onError: () => toast.error('Failed to create subtask'),
    })

    const handleSubtaskSubmit = () => {
        const title = subtaskTitle.trim()
        if (!title) { setAddingSubtask(false); return }
        createSubtask.mutate(title)
    }

    // Reset local edit inputs when navigating to a different task
    useEffect(() => {
        setEditingTitle(task.title)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task.id])

    const criteria: AcceptanceCriterion[] = (task.acceptanceCriteria ?? []).map(
        ac => typeof ac === 'string' ? { text: ac, checked: false } : ac
    )

    const handleCriterionToggle = (index: number) => {
        const updated = criteria.map((c, i) =>
            i === index ? { ...c, checked: !c.checked } : c
        )
        taskOperations.updateCriteria(updated)
    }

    return (
        <div className="flex-1 flex flex-col overflow-y-auto px-8 py-6">
            {/* Title */}
            <div className="mb-4">
                {isEditing ? (
                    <input
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={() => {
                            const trimmed = editingTitle.trim()
                            if (trimmed && trimmed !== task.title) taskOperations.updateTitle(trimmed)
                        }}
                        className="w-full bg-transparent text-xl font-semibold text-foreground outline-none border-b border-[#2a2a2a] focus:border-primary/50 pb-1 transition-colors"
                    />
                ) : (
                    <h1 className="text-xl font-semibold text-foreground">{task.title}</h1>
                )}
            </div>

            {/* Description */}
            <div className="mb-5">
                <DescriptionEditor
                    taskId={task.id}
                    initialContent={task.descriptionHtml ?? task.description}
                />
            </div>

            {/* Link / Attach / Reference buttons */}
            <div className="flex items-center gap-2 mb-6">
                <button
                    onClick={taskOperations.focusLinkInput}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-[#1a1a1a] border border-[#1e1e1e] px-2.5 py-1 rounded-md transition-colors"
                >
                    <Link2 className="w-3.5 h-3.5" /> Add Link
                </button>
                <button
                    onClick={taskOperations.triggerAttachFile}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-[#1a1a1a] border border-[#1e1e1e] px-2.5 py-1 rounded-md transition-colors"
                >
                    <Paperclip className="w-3.5 h-3.5" /> Attach File
                </button>
                <button
                    onClick={taskOperations.focusReferenceInput}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-[#1a1a1a] border border-[#1e1e1e] px-2.5 py-1 rounded-md transition-colors"
                >
                    <FileText className="w-3.5 h-3.5" /> Reference
                </button>
            </div>

            {/* Acceptance Criteria */}
            {criteria.length > 0 && (
                <div className="mb-6 border border-[#1e1e1e] rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <h2 className="text-sm font-medium text-foreground">Acceptance Criteria</h2>
                        <span className="text-[10px] text-muted-foreground/60 bg-[#1a1a1a] px-1.5 py-0.5 rounded border border-[#1e1e1e]">
                            {criteria.filter(c => c.checked).length}/{criteria.length}
                        </span>
                    </div>
                    <div className="space-y-2">
                        {criteria.map((criterion, i) => (
                            <button
                                key={i}
                                onClick={() => handleCriterionToggle(i)}
                                className="flex items-start gap-2.5 w-full text-left group"
                            >
                                {criterion.checked
                                    ? <CheckSquare className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                                    : <Square className="w-4 h-4 text-muted-foreground/40 mt-0.5 flex-shrink-0 group-hover:text-muted-foreground transition-colors" />
                                }
                                <span className={cn(
                                    'text-sm leading-relaxed',
                                    criterion.checked
                                        ? 'text-muted-foreground/50 line-through'
                                        : 'text-foreground/80',
                                )}>
                                    {criterion.text}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Parent link — shown when this task is a subtask */}
            {task.parentTaskId && (
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-2">
                        <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                        <h2 className="text-sm font-medium text-foreground">Parent Task</h2>
                    </div>
                    {parentTask ? (
                        <button
                            onClick={() => router.push(`/${tenantSlug}/dashboard/board/${parentTask.id}`)}
                            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#1a1a1a] transition-colors group w-full text-left"
                        >
                            {parentTask.sequenceId && (
                                <span className="text-[10px] text-muted-foreground/50 font-medium uppercase tracking-tighter shrink-0">
                                    TASK-{parentTask.sequenceId}
                                </span>
                            )}
                            <span className="text-sm text-foreground/80 truncate flex-1 group-hover:text-foreground transition-colors">{parentTask.title}</span>
                            <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/30 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity" />
                        </button>
                    ) : (
                        <p className="text-xs text-muted-foreground/30 px-2">Loading…</p>
                    )}
                </div>
            )}

            {/* Subtasks — hidden when this task is itself a subtask (no nesting beyond depth 1) */}
            {!task.parentTaskId && <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                    <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                    <h2 className="text-sm font-medium text-foreground">Subtasks</h2>
                    {subtasks.length > 0 && (
                        <span className="text-[10px] text-muted-foreground/60 bg-[#1a1a1a] px-1.5 py-0.5 rounded border border-[#1e1e1e]">
                            {subtasks.length}
                        </span>
                    )}
                </div>
                <div className="space-y-0.5">
                    {subtasks.map(subtask => (
                        <SubtaskRow
                            key={subtask.id}
                            subtask={subtask}
                            tenantSlug={tenantSlug}
                            onClick={() => router.push(`/${tenantSlug}/dashboard/board/${subtask.id}`)}
                        />
                    ))}
                </div>
                {addingSubtask ? (
                    <div className="flex items-center gap-2 mt-1.5 px-2">
                        <div className="w-2 h-2 rounded-full bg-[#3a3a3a] shrink-0" />
                        <input
                            ref={subtaskInputRef}
                            autoFocus
                            value={subtaskTitle}
                            onChange={e => setSubtaskTitle(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleSubtaskSubmit()
                                if (e.key === 'Escape') { setAddingSubtask(false); setSubtaskTitle('') }
                            }}
                            onBlur={handleSubtaskSubmit}
                            placeholder="Subtask title…"
                            className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground/30"
                            disabled={createSubtask.isPending}
                        />
                        {createSubtask.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
                    </div>
                ) : (
                    <button
                        onClick={() => setAddingSubtask(true)}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground mt-1.5 px-2 transition-colors"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Add subtask
                    </button>
                )}
            </div>}

            {/* ExecutionConsole */}
            <ExecutionConsole
                task={task}
                steps={steps}
                events={events}
                taskOperations={{
                    approvePlan: taskOperations.approvePlan,
                    rejectPlan: taskOperations.rejectPlan,
                    generatePlan: taskOperations.generatePlan,
                    sendClarification: taskOperations.sendClarification,
                    markDone: taskOperations.markDone,
                    startTask: taskOperations.startTask,
                }}
            />
            <ActivityFeed taskId={taskId} />
        </div>
    )
}

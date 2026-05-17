'use client'

import { useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTaskStream } from '@/hooks/useTaskStream'
import { useTaskMutations } from '@/hooks/useTaskMutations'
import { useTaskPolling } from '@/hooks/useTaskPolling'
import { useTaskDraft } from '@/hooks/useTaskDraft'
import { AlertCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { TaskHeader } from './task-detail/TaskHeader'
import { TaskSidebar } from './task-detail/TaskSidebar'
import { TaskMainContent } from './task-detail/TaskMainContent'
import type {
    Step, TaskEvent, AgentsResponse, MembersResponse, Assignee, TaskDetailResponse,
} from '@/types/task'
import { ATTACHMENT_ACCEPT } from '@/lib/attachmentValidation'

const normalizeUrl = (url: string): string => {
    const trimmed = url.trim()
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export function TaskDetailView() {
    const params = useParams()
    const taskId = params.taskId as string
    const tenantSlug = params.tenant as string

    useTaskStream(taskId)

    // ── Refs ──────────────────────────────────────────────────────────────────
    const attachFileInputRef = useRef<HTMLInputElement>(null)
    const newLinkInputRef = useRef<HTMLInputElement>(null)
    const referenceTextRef = useRef<HTMLTextAreaElement>(null)
    const previousStepsRef = useRef<Record<string, {
        liveActivity?: any[]
        liveText?: string
        agentThinking?: boolean
    }>>({})

    // ── Live-field merge selector ─────────────────────────────────────────────
    // Runs on every cache read — including window-focus refetches and mutation
    // invalidations — and restores WS-written fields that the server doesn't return.
    // Order: prefer the value from cache (set by WS handlers) over the ref backup.
    // The ref backup only kicks in when the field is undefined (i.e. after a server fetch wiped it).
    const selectWithLiveFields = useCallback((raw: TaskDetailResponse) => {
        if (!raw?.data?.steps) return raw
        return {
            ...raw,
            data: {
                ...raw.data,
                steps: raw.data.steps.map((step: any) => {
                    const prev = previousStepsRef.current[step.id]
                    if (!prev) return step
                    return {
                        ...step,
                        liveActivity: step.liveActivity ?? prev.liveActivity,
                        liveText: step.liveText ?? prev.liveText,
                        agentThinking: step.agentThinking ?? prev.agentThinking,
                    }
                }),
            },
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // ── Queries ───────────────────────────────────────────────────────────────
    const { data: agentsData } = useQuery<AgentsResponse>({
        queryKey: ['agents'],
        queryFn: () => api.get<AgentsResponse>('/api/v1/agents'),
    })
    const { data: membersData } = useQuery<MembersResponse>({
        queryKey: ['members'],
        queryFn: () => api.get<MembersResponse>('/api/v1/members'),
    })

    const activeAgents = agentsData?.data?.filter(a => a.status === 'active') ?? []
    const members = membersData?.members ?? []
    const assigneeOptions: Assignee[] = [
        ...members.map(m => ({ type: 'member' as const, id: m.userId, name: m.userName || m.userEmail })),
        ...activeAgents.map(a => ({ type: 'agent' as const, id: a.id, name: a.name })),
    ]

    const { data, isLoading, isError, error } = useQuery<TaskDetailResponse>({
        queryKey: ['task', taskId],
        queryFn: () => api.get<TaskDetailResponse>(`/api/v1/tasks/${taskId}`),
        select: selectWithLiveFields,
        refetchOnWindowFocus: false,
    })

    const task = data?.data?.task
    const steps: Step[] = data?.data?.steps ?? []
    const events: TaskEvent[] = data?.data?.events ?? []
    const agent = data?.data?.agent
    const assignee = data?.data?.assignee

    // ── Polling ───────────────────────────────────────────────────────────────
    useTaskPolling(taskId, task)

    // ── Live fields ref sync — preserve WS-written fields across server refetches ─
    useEffect(() => {
        if (!steps) return
        steps.forEach((step: any) => {
            if (['done', 'failed', 'skipped'].includes(step.status)) {
                delete previousStepsRef.current[step.id]
            } else if (step.liveActivity || step.liveText || step.agentThinking) {
                previousStepsRef.current[step.id] = {
                    liveActivity: step.liveActivity,
                    liveText: step.liveText,
                    agentThinking: step.agentThinking,
                }
            }
        })
    }, [steps])

    // ── Derived assignee ──────────────────────────────────────────────────────
    const selectedAssignee = useMemo((): Assignee | null => {
        if (!task) return null
        if (task.assigneeId) {
            return assigneeOptions.find(o => o.type === 'member' && o.id === task.assigneeId)
                ?? (assignee ? { type: 'member', id: task.assigneeId, name: assignee.name } : null)
        }
        if (task.agentId) {
            return assigneeOptions.find(o => o.type === 'agent' && o.id === task.agentId)
                ?? (agent ? { type: 'agent', id: task.agentId, name: agent.name } : null)
        }
        return null
    }, [task?.assigneeId, task?.agentId, assigneeOptions, assignee, agent])

    // ── Mutations + edit drafts ───────────────────────────────────────────────
    const {
        patchTask,
        voteMutation,
        deleteTaskMutation,
        approvePlanMutation,
        clarifyMutation,
        generatePlanMutation,
        handleAttachmentUpload,
        isUploadingAttachment,
    } = useTaskMutations(taskId, tenantSlug, task)

    const editState = useTaskDraft(task, selectedAssignee, patchTask)

    // ── Task operations ───────────────────────────────────────────────────────
    const taskOperations = useMemo(() => ({
        approvePlan: async (opts?: { approved: boolean; feedback?: Record<string, string>; generalInstruction?: string }) => { await approvePlanMutation.mutateAsync(opts ?? { approved: true }) },
        rejectPlan: async (feedback?: string) => { await approvePlanMutation.mutateAsync({ approved: false, generalInstruction: feedback?.trim() || undefined }) },
        generatePlan: async () => { await generatePlanMutation.mutateAsync() },
        sendClarification: async (answer: string) => { await clarifyMutation.mutateAsync(answer) },
        markDone: async () => { await patchTask.mutateAsync({ status: 'done' }) },
        updateTitle: async (title: string) => { await patchTask.mutateAsync({ title }) },
        updateDescription: async (desc: string) => { await patchTask.mutateAsync({ description: desc || null }) },
        deleteTask: async () => { await deleteTaskMutation.mutateAsync() },
        vote: async (direction: 'up' | 'down') => { await voteMutation.mutateAsync(direction) },
        addLink: (url: string) => patchTask.mutate({ links: [...(task?.links ?? []), normalizeUrl(url)] }),
        removeLink: (url: string) => patchTask.mutate({ links: (task?.links ?? []).filter(l => l !== url) }),
        addAttachment: handleAttachmentUpload,
        removeAttachment: (fileId: string) =>
            patchTask.mutate({ attachmentFileIds: (task?.attachmentFileIds ?? []).filter(id => id !== fileId) }),
        saveReferenceText: (text: string | null) => patchTask.mutate({ referenceText: text }),
        startTask: () => patchTask.mutate({ status: 'in_progress', startedAt: new Date().toISOString() }),
        updateCriteria: (criteria: { text: string; checked: boolean }[]) =>
            patchTask.mutate({ acceptanceCriteria: criteria }),
        focusLinkInput: () => {
            document.getElementById('links-section')?.scrollIntoView({ behavior: 'smooth' })
            setTimeout(() => newLinkInputRef.current?.focus(), 300)
        },
        focusReferenceInput: () => {
            document.getElementById('reference-section')?.scrollIntoView({ behavior: 'smooth' })
            setTimeout(() => referenceTextRef.current?.focus(), 300)
        },
        triggerAttachFile: () => attachFileInputRef.current?.click(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [taskId, patchTask, voteMutation, task?.links, task?.attachmentFileIds])

    // ── Loading / error ───────────────────────────────────────────────────────
    if (isLoading) return <div className="p-8"><Skeleton className="h-[calc(100vh-120px)] w-full" /></div>
    if (isError || !task || !steps || !events) {
        return (
            <div className="p-8">
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof Error ? error.message : 'Failed to load task.'}</AlertDescription>
                </Alert>
            </div>
        )
    }

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col h-full overflow-hidden bg-background">
            <input
                type="file"
                ref={attachFileInputRef}
                className="hidden"
                accept={ATTACHMENT_ACCEPT}
                onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleAttachmentUpload(file)
                }}
            />
            <TaskHeader task={task} editState={editState} taskOperations={taskOperations} />
            <div className="flex flex-1 min-h-0 overflow-hidden">
                <TaskMainContent
                    task={task}
                    steps={steps}
                    events={events}
                    taskId={taskId}
                    taskOperations={taskOperations}
                    editState={editState}
                />
                <TaskSidebar
                    task={task}
                    steps={steps}
                    editState={editState}
                    taskOperations={taskOperations}
                    assigneeOptions={assigneeOptions}
                    selectedAssignee={selectedAssignee}
                    isUploadingAttachment={isUploadingAttachment}
                    attachFileInputRef={attachFileInputRef}
                    newLinkInputRef={newLinkInputRef}
                    referenceTextRef={referenceTextRef}
                />
            </div>
        </div>
    )
}

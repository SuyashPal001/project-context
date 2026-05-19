'use client'

import { useState, useEffect } from 'react'
import type { UseMutationResult } from '@tanstack/react-query'
import type { Task, Assignee } from '@/types/task'
import type { TaskPatch } from './useTaskMutations'

function assigneeKeyFromTask(task: Task): string {
    if (task.assigneeId) return `member:${task.assigneeId}`
    if (task.agentId) return `agent:${task.agentId}`
    return 'unassigned'
}

function toDateInput(value: string | null | undefined): string {
    return value ? new Date(value).toISOString().split('T')[0] : ''
}

export interface EditState {
    isEditing: boolean
    isSaving: boolean
    draftStatus: Task['status']
    draftPriority: Task['priority']
    draftAssigneeKey: string
    setDraftStatus: (v: string) => void
    setDraftPriority: (v: string) => void
    setDraftAssigneeKey: (v: string) => void
    onEdit: () => void
    onCancel: () => void
    onSave: () => Promise<void>
}

export function useTaskDraft(
    task: Task | undefined,
    selectedAssignee: Assignee | null,
    patchTask: UseMutationResult<unknown, Error, TaskPatch>,
): EditState {
    const [isEditing, setIsEditing] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [draftTitle, setDraftTitle] = useState('')
    const [draftDescription, setDraftDescription] = useState('')
    const [draftStatus, setDraftStatus] = useState<Task['status']>('backlog')
    const [draftPriority, setDraftPriority] = useState<Task['priority']>('medium')
    const [draftAssigneeKey, setDraftAssigneeKey] = useState('unassigned')
    const [draftStartedAt, setDraftStartedAt] = useState('')
    const [draftDueDate, setDraftDueDate] = useState('')
    const [draftEstimatedHours, setDraftEstimatedHours] = useState('')

    // Initialise all editable fields when the task loads (keyed by task id only —
    // we don't want to overwrite drafts every time the task object changes).
    useEffect(() => {
        if (!task) return
        setDraftTitle(task.title)
        setDraftDescription(task.description || '')
        setDraftStatus(task.status)
        setDraftPriority(task.priority)
        setDraftAssigneeKey(assigneeKeyFromTask(task))
        setDraftStartedAt(toDateInput(task.startedAt))
        setDraftDueDate(toDateInput(task.dueDate))
        setDraftEstimatedHours(task.estimatedHours != null ? String(task.estimatedHours) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task?.id])

    const saveEdits = async () => {
        if (!task) return
        const updates: TaskPatch = {}

        if (draftTitle.trim() && draftTitle.trim() !== task.title) updates.title = draftTitle.trim()
        if (draftDescription !== (task.description || '')) updates.description = draftDescription || null
        if (draftStatus !== task.status) updates.status = draftStatus
        if (draftPriority !== task.priority) updates.priority = draftPriority

        const origKey = selectedAssignee ? `${selectedAssignee.type}:${selectedAssignee.id}` : 'unassigned'
        if (draftAssigneeKey !== origKey) {
            if (draftAssigneeKey === 'unassigned') {
                updates.assigneeId = null
                updates.agentId = null
            } else {
                const colonIdx = draftAssigneeKey.indexOf(':')
                const type = draftAssigneeKey.slice(0, colonIdx)
                const id = draftAssigneeKey.slice(colonIdx + 1)
                if (type === 'member') {
                    updates.assigneeId = id
                    updates.agentId = null
                } else {
                    updates.agentId = id
                    updates.assigneeId = null
                }
            }
        }

        const origStart = toDateInput(task.startedAt)
        const origDue = toDateInput(task.dueDate)
        if (draftStartedAt !== origStart) updates.startedAt = draftStartedAt ? new Date(draftStartedAt).toISOString() : null
        if (draftDueDate !== origDue) updates.dueDate = draftDueDate ? new Date(draftDueDate).toISOString() : null

        const origHours = task.estimatedHours != null ? String(task.estimatedHours) : ''
        if (draftEstimatedHours !== origHours) {
            const h = parseFloat(draftEstimatedHours)
            updates.estimatedHours = draftEstimatedHours && !isNaN(h) ? h : null
        }

        if (Object.keys(updates).length > 0) {
            await patchTask.mutateAsync(updates)
        }
    }

    return {
        isEditing,
        isSaving,
        draftStatus,
        draftPriority,
        draftAssigneeKey,
        setDraftStatus: (v: string) => setDraftStatus(v as Task['status']),
        setDraftPriority: (v: string) => setDraftPriority(v as Task['priority']),
        setDraftAssigneeKey,
        onEdit: () => setIsEditing(true),
        onCancel: () => {
            setIsEditing(false)
            if (task) {
                setDraftStatus(task.status)
                setDraftPriority(task.priority)
                setDraftAssigneeKey(assigneeKeyFromTask(task))
            }
        },
        onSave: async () => {
            setIsSaving(true)
            try {
                await saveEdits()
            } finally {
                setIsSaving(false)
            }
            setIsEditing(false)
        },
    }
}

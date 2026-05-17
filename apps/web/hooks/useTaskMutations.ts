'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { validateAttachment } from '@/lib/attachmentValidation'
import type { Task } from '@/types/task'

export type TaskPatch = Partial<{
    title: string
    description: string | null
    status: string
    priority: string
    estimatedHours: number | null
    acceptanceCriteria: { text: string; checked: boolean }[]
    dueDate: string | null
    startedAt: string | null
    links: string[]
    attachmentFileIds: string[]
    assigneeId: string | null
    agentId: string | null
    referenceText: string | null
}>

export function useTaskMutations(taskId: string, tenantSlug: string, task: Task | undefined) {
    const queryClient = useQueryClient()
    const router = useRouter()
    const [isUploadingAttachment, setIsUploadingAttachment] = useState(false)

    const patchTask = useMutation({
        mutationFn: (updates: TaskPatch) => api.patch(`/api/v1/tasks/${taskId}`, updates),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['task', taskId] }),
        onError: (err: any) => toast.error(err.message || 'Failed to save change'),
    })

    const voteMutation = useMutation({
        mutationFn: (type: 'up' | 'down') => api.post(`/api/v1/tasks/${taskId}/vote`, { type }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['task', taskId] }),
        onError: (err: any) => toast.error(err.message || 'Failed to vote'),
    })

    const deleteTaskMutation = useMutation({
        mutationFn: () => api.del(`/api/v1/tasks/${taskId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] })
            toast.success('Task deleted')
            router.push(`/${tenantSlug}/dashboard/board`)
        },
        onError: (err: Error) => toast.error(err.message || 'Failed to delete task'),
    })

    const approvePlanMutation = useMutation({
        mutationFn: (payload: { approved: boolean; feedback?: Record<string, string>; generalInstruction?: string }) => {
            const stepFeedback = payload.feedback
                ? Object.entries(payload.feedback).filter(([, text]) => text.trim()).map(([stepId, feedback]) => ({ stepId, feedback }))
                : undefined
            const extraContext = payload.generalInstruction?.trim() || undefined
            return api.put(`/api/v1/tasks/${taskId}/plan/approve`, { approved: payload.approved, stepFeedback, extraContext })
        },
        onSuccess: (_, variables) => {
            if (!variables.approved) {
                queryClient.setQueryData(['task', taskId], (old: any) => {
                    if (!old?.data) return old
                    return {
                        ...old,
                        data: { ...old.data, steps: [], task: { ...old.data.task, status: 'planning' } },
                    }
                })
                // No invalidateQueries — WS events will stream new steps as they arrive
            } else {
                queryClient.invalidateQueries({ queryKey: ['task', taskId] })
            }
            toast.success(variables.approved ? 'Plan approved' : 'Feedback sent, agent is replanning.')
        },
        onError: (err: Error) => toast.error(err.message || 'Failed to send feedback'),
    })

    const clarifyMutation = useMutation({
        mutationFn: (answer: string) => api.post(`/api/v1/tasks/${taskId}/clarify`, { answer }),
        onSuccess: () => {
            // Clear steps immediately — the backend has not yet deleted old steps when this
            // fires, so invalidateQueries would refetch stale steps and undo the WS-driven
            // status=planning clear. New steps arrive via task.step.created WS events.
            queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data) return old
                return {
                    ...old,
                    data: { ...old.data, steps: [], task: { ...old.data.task, status: 'planning' } },
                }
            })
            toast.success('Answer sent — agent is planning')
        },
        onError: (err: Error) => toast.error(err.message || 'Failed to send answer'),
    })

    const generatePlanMutation = useMutation({
        mutationFn: () => api.post(`/api/v1/tasks/${taskId}/plan`),
        onSuccess: () => {
            queryClient.setQueryData(['task', taskId], (old: any) => {
                if (!old?.data) return old
                return {
                    ...old,
                    data: {
                        ...old.data,
                        steps: [],
                        task: { ...old.data.task, status: 'planning' },
                    },
                }
            })
        },
        onError: (err: any) => toast.error(err?.data?.error || 'Failed to generate plan'),
    })

    const handleAttachmentUpload = async (file: File) => {
        const validation = validateAttachment(file)
        if (!validation.valid) {
            toast.error(validation.error)
            return
        }

        setIsUploadingAttachment(true)
        try {
            const { data: fileData } = await api.post<{ data: { fileId: string; uploadUrl: string } }>(
                '/api/v1/files/upload',
                { filename: file.name, contentType: file.type || 'application/octet-stream' }
            )
            await fetch(fileData.uploadUrl, {
                method: 'PUT',
                body: file,
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
            })
            await api.post(`/api/v1/files/${fileData.fileId}/confirm`, { size: file.size })
            patchTask.mutate({ attachmentFileIds: [...(task?.attachmentFileIds ?? []), fileData.fileId] })
            toast.success('File attached')
        } catch (err: any) {
            toast.error(err.message || 'Failed to upload attachment')
        } finally {
            setIsUploadingAttachment(false)
        }
    }

    return {
        patchTask,
        voteMutation,
        deleteTaskMutation,
        approvePlanMutation,
        clarifyMutation,
        generatePlanMutation,
        handleAttachmentUpload,
        isUploadingAttachment,
    }
}

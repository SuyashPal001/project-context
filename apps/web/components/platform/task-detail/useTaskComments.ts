'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { TaskComment } from '@/types/task'

export function useTaskComments(taskId: string) {
    const queryClient = useQueryClient()
    const queryKey = ['task-comments', taskId]

    const commentsQuery = useQuery<{ data: TaskComment[] }>({
        queryKey,
        queryFn: () => api.get<{ data: TaskComment[] }>(`/api/v1/tasks/${taskId}/comments`),
    })

    const addComment = useMutation({
        mutationFn: (html: string) =>
            api.post(`/api/v1/tasks/${taskId}/comments`, {
                content: html,
                contentHtml: html,
            }),
        onMutate: async (html) => {
            await queryClient.cancelQueries({ queryKey })
            const prev = queryClient.getQueryData<{ data: TaskComment[] }>(queryKey)
            const optimistic: TaskComment = {
                id: `optimistic-${Date.now()}`,
                taskId,
                authorId: 'me',
                authorType: 'member',
                authorName: 'You',
                content: html,
                contentHtml: html,
                parentId: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            queryClient.setQueryData<{ data: TaskComment[] }>(queryKey, (old) => ({
                data: [...(old?.data ?? []), optimistic],
            }))
            return { prev }
        },
        onError: (err, _vars, context) => {
            if (context?.prev) queryClient.setQueryData(queryKey, context.prev)
            const msg = err instanceof Error ? err.message : 'Failed to post comment'
            toast.error(msg)
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey })
        },
    })

    return {
        comments: commentsQuery.data?.data ?? [],
        addComment,
    }
}

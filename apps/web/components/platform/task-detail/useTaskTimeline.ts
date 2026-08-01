'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { TimelineResponse } from '@/types/task'

export function useTaskTimeline(taskId: string) {
    const query = useQuery<TimelineResponse>({
        queryKey: ['task-timeline', taskId],
        queryFn: () => api.get<TimelineResponse>(`/api/v1/tasks/${taskId}/timeline`),
    })

    return {
        rows: query.data?.data ?? [],
        isLoading: query.isLoading,
        isError: query.isError,
    }
}

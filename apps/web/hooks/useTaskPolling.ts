'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Task, TaskDetailResponse } from '@/types/task'

const STOP_POLLING_STATUSES = ['review', 'done', 'blocked', 'cancelled', 'awaiting_approval']
const TERMINAL_STATUSES = ['done', 'cancelled', 'review']

export function useTaskPolling(taskId: string, task: Task | undefined) {
    const queryClient = useQueryClient()
    const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

    useEffect(() => {
        if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current)
            pollingIntervalRef.current = null
        }

        if (task?.status && STOP_POLLING_STATUSES.includes(task.status)) {
            if (TERMINAL_STATUSES.includes(task.status)) {
                queryClient.invalidateQueries({ queryKey: ['task', taskId] })
            }
            return
        }

        if (!task?.id) return
        if (task.status !== 'in_progress' && task.status !== 'ready' && task.status !== 'planning') return

        pollingIntervalRef.current = setInterval(async () => {
            try {
                const fresh = await api.get<TaskDetailResponse>(`/api/v1/tasks/${taskId}`)
                const newStatus = fresh?.data?.task?.status
                // During planning, WS events own the step cache. Do NOT call setQueryData
                // with DB data here — the backend may not have cleared old steps yet (e.g.
                // after clarification answered), so writing fresh would restore stale steps.
                // Once status changes away from 'planning', write the fresh response but
                // preserve WS-streamed steps if DB hasn't committed them yet (freshSteps
                // empty while cache already has steps from task.step.created events).
                if (newStatus !== 'planning') {
                    const current = queryClient.getQueryData<TaskDetailResponse>(['task', taskId])
                    const cachedSteps = current?.data?.steps ?? []
                    const freshSteps = fresh.data?.steps ?? []
                    const mergedSteps = freshSteps.length > 0 ? freshSteps : cachedSteps
                    queryClient.setQueryData(['task', taskId], {
                        ...fresh,
                        data: { ...fresh.data, steps: mergedSteps },
                    })
                }
                if (newStatus && STOP_POLLING_STATUSES.includes(newStatus)) {
                    if (pollingIntervalRef.current) {
                        clearInterval(pollingIntervalRef.current)
                        pollingIntervalRef.current = null
                    }
                }
            } catch {
                // ignore transient fetch errors — will retry on next tick
            }
        }, 5000)

        return () => {
            if (pollingIntervalRef.current) {
                clearInterval(pollingIntervalRef.current)
                pollingIntervalRef.current = null
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task?.status, task?.id, taskId])
}

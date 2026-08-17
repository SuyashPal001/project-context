'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { Plus, Search, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TooltipProvider } from '@/components/ui/tooltip'
import { COLUMNS, STATUS_CONFIG } from './board/types'
import { KanbanColumn } from './board/KanbanColumn'
import { CreateTaskDialog } from './board/CreateTaskDialog'
import type { Task, TasksResponse, AgentsResponse, MembersResponse } from './board/types'

export { CreateTaskDialog } from './board/CreateTaskDialog'

export function BoardView({
    defaultMilestoneId,
    defaultPlanId,
}: {
    defaultMilestoneId?: string
    defaultPlanId?: string
} = {}) {
    const params = useParams()
    const tenantSlug = params.tenant as string
    const queryClient = useQueryClient()
    const [createOpen, setCreateOpen] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<Task['status'] | 'all'>('all')
    const [assigneeFilter, setAssigneeFilter] = useState<string>('all')

    const tasksUrl = defaultMilestoneId ? `/api/v1/milestones/${defaultMilestoneId}/tasks` : '/api/v1/tasks'
    const tasksQueryKey = defaultMilestoneId ? ['milestoneTasks', defaultMilestoneId] : ['tasks']

    const { data, isLoading, isError, error } = useQuery<TasksResponse>({
        queryKey: tasksQueryKey,
        queryFn: () => api.get<TasksResponse>(tasksUrl),
    })
    const { data: agentsData } = useQuery<AgentsResponse>({
        queryKey: ['agents'],
        queryFn: () => api.get<AgentsResponse>('/api/v1/agents'),
    })
    const { data: membersData } = useQuery<MembersResponse>({
        queryKey: ['members'],
        queryFn: () => api.get<MembersResponse>('/api/v1/members'),
    })

    const updateTaskStatus = useMutation({
        mutationFn: ({ taskId, status, sortOrder }: { taskId: string; status: Task['status']; sortOrder?: number }) =>
            api.patch(`/api/v1/tasks/${taskId}`, { status, sortOrder }),
        onMutate: async ({ taskId, status, sortOrder }) => {
            await queryClient.cancelQueries({ queryKey: tasksQueryKey })
            const previousTasks = queryClient.getQueryData<TasksResponse>(tasksQueryKey)
            if (previousTasks) {
                queryClient.setQueryData<TasksResponse>(tasksQueryKey, {
                    ...previousTasks,
                    data: previousTasks.data.map((t: Task) =>
                        t.id === taskId ? { ...t, status, sortOrder: sortOrder ?? t.sortOrder } : t
                    ),
                })
            }
            return { previousTasks }
        },
        onError: (err, __, context) => {
            if (context?.previousTasks) queryClient.setQueryData(tasksQueryKey, context.previousTasks)
            toast.error('Failed to move task')
        },
        onSettled: (_, __, variables) => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] })
            queryClient.invalidateQueries({ queryKey: ['task', variables.taskId] })
            if (defaultMilestoneId) queryClient.invalidateQueries({ queryKey: ['milestoneTasks', defaultMilestoneId] })
        },
    })

    const onDropTask = (taskId: string, newStatus: Task['status'], targetTaskId?: string, position?: 'before' | 'after') => {
        const tasks = queryClient.getQueryData<TasksResponse>(tasksQueryKey)?.data ?? []
        const taskToMove = tasks.find(t => t.id === taskId)
        if (!taskToMove) return

        const targetColumnTasks = tasks.filter(t => t.status === newStatus && t.id !== taskId).sort((a, b) => a.sortOrder - b.sortOrder)
        let newSortOrder = 0

        if (targetTaskId) {
            const targetIdx = targetColumnTasks.findIndex(t => t.id === targetTaskId)
            if (position === 'before') {
                const prev = targetColumnTasks[targetIdx - 1]
                newSortOrder = prev ? Math.floor((prev.sortOrder + targetColumnTasks[targetIdx].sortOrder) / 2) : targetColumnTasks[targetIdx].sortOrder - 1000
            } else {
                const next = targetColumnTasks[targetIdx + 1]
                newSortOrder = next ? Math.floor((targetColumnTasks[targetIdx].sortOrder + next.sortOrder) / 2) : targetColumnTasks[targetIdx].sortOrder + 1000
            }
        } else {
            const last = targetColumnTasks[targetColumnTasks.length - 1]
            newSortOrder = last ? last.sortOrder + 1000 : 0
        }

        if (taskToMove.status === newStatus && taskToMove.sortOrder === newSortOrder) return
        updateTaskStatus.mutate({ taskId, status: newStatus, sortOrder: newSortOrder })
    }

    const tasks = data?.data ?? []
    const agents = agentsData?.data ?? []
    const members = membersData?.members ?? []
    const assignableMembers = members.filter(m => m.status === 'active' && m.userId)

    const tasksByCreatedAt = [...tasks].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    const fallbackIndexMap = new Map(tasksByCreatedAt.map((t, i) => [t.id, i + 1]))
    const taskNumberMap = new Map(tasks.map(t => [t.id, t.sequenceId ?? fallbackIndexMap.get(t.id) ?? 1]))

    const filteredTasks = tasks
        .filter(task => {
            if (searchQuery && !task.title.toLowerCase().includes(searchQuery.toLowerCase())) return false
            if (statusFilter !== 'all' && task.status !== statusFilter) return false
            if (assigneeFilter !== 'all' && task.agentId !== assigneeFilter && task.assigneeId !== assigneeFilter) return false
            return true
        })
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))

    if (isError) {
        return (
            <div className="flex flex-col h-full">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-lg font-semibold text-foreground">Board</h1>
                    <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-4 w-4" />New Task</Button>
                </div>
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof Error ? error.message : 'Failed to load tasks. Please try again.'}</AlertDescription>
                </Alert>
            </div>
        )
    }

    if (isLoading) {
        return (
            <div className="flex flex-col h-[calc(100vh-180px)]">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-lg font-semibold text-foreground">Board</h1>
                    <Button size="sm" disabled><Plus className="mr-1.5 h-4 w-4" />New Task</Button>
                </div>
                <div className="flex items-center gap-2 mb-4"><Skeleton className="h-8 w-52" /><Skeleton className="h-8 w-40" /><Skeleton className="h-8 w-44" /></div>
                <div className="flex flex-row gap-3 overflow-x-auto pb-6">
                    {COLUMNS.map(status => (
                        <div key={status} className="w-[300px] min-w-[300px] flex-shrink-0 flex flex-col rounded-xl p-3 min-h-[500px] bg-[#111111] border border-[#222222]">
                            <div className="flex items-center gap-2 px-2 py-3 mb-2">
                                <Skeleton className="w-4 h-4 rounded-full" /><Skeleton className="h-5 w-24" />
                            </div>
                            <div className="flex-1 space-y-2"><Skeleton className="h-[120px] w-full rounded-lg" /><Skeleton className="h-[120px] w-full rounded-lg" /></div>
                        </div>
                    ))}
                </div>
            </div>
        )
    }

    return (
        <TooltipProvider>
            <div className="flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-lg font-semibold text-foreground">Board</h1>
                    <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-4 w-4" />New Task</Button>
                </div>
                <div className="flex flex-wrap items-center gap-4 bg-muted/20 p-4 rounded-lg mb-4">
                    <div className="relative flex-1 max-w-xs">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        <Input placeholder="Search tasks..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="pl-8 h-8 text-sm" />
                    </div>
                    <Select value={statusFilter} onValueChange={v => setStatusFilter(v as Task['status'] | 'all')}>
                        <SelectTrigger className="h-8 w-[160px] text-sm"><SelectValue placeholder="Status" /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Statuses</SelectItem>
                            {COLUMNS.map(status => <SelectItem key={status} value={status}>{STATUS_CONFIG[status].label}</SelectItem>)}
                        </SelectContent>
                    </Select>
                    <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
                        <SelectTrigger className="h-8 w-[160px] text-sm"><SelectValue placeholder="All Assignees" /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Assignees</SelectItem>
                            {assignableMembers.length > 0 && (
                                <SelectGroup>
                                    <SelectLabel>Members</SelectLabel>
                                    {assignableMembers.map(m => <SelectItem key={m.userId} value={m.userId}>{m.userName || m.userEmail}</SelectItem>)}
                                </SelectGroup>
                            )}
                            {agents.filter(a => a.status === 'active').length > 0 && (
                                <SelectGroup>
                                    <SelectLabel>Employees</SelectLabel>
                                    {agents.filter(a => a.status === 'active').map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                                </SelectGroup>
                            )}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex flex-row gap-3 overflow-x-auto pb-6">
                    {COLUMNS.map(status => (
                        <KanbanColumn
                            key={status}
                            status={status}
                            tasks={filteredTasks.filter(t => t.status === status)}
                            tenantSlug={tenantSlug}
                            taskNumberMap={taskNumberMap}
                            members={members}
                            agents={agents}
                            onAddTask={() => setCreateOpen(true)}
                            onDropTask={onDropTask}
                        />
                    ))}
                </div>
            </div>
            <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} defaultMilestoneId={defaultMilestoneId} defaultPlanId={defaultPlanId} />
        </TooltipProvider>
    )
}

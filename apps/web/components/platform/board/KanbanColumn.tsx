'use client'

import { useState } from 'react'
import { Plus, Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { STATUS_CONFIG } from './types'
import { StatusIcon, TaskCard } from './TaskCard'
import type { Task, MembersResponse, AgentsResponse } from './types'

export function KanbanColumn({
    status,
    tasks,
    tenantSlug,
    taskNumberMap,
    members,
    agents,
    onAddTask,
    onDropTask,
}: {
    status: Task['status']
    tasks: Task[]
    tenantSlug: string
    taskNumberMap: Map<string, number>
    members: MembersResponse['members']
    agents: AgentsResponse['data']
    onAddTask: () => void
    onDropTask: (taskId: string, status: Task['status'], targetTaskId?: string, position?: 'before' | 'after') => void
}) {
    const cfg = STATUS_CONFIG[status]
    const [isOver, setIsOver] = useState(false)
    const [dropIndicator, setDropIndicator] = useState<{ taskId: string; position: 'before' | 'after' } | null>(null)

    const handleDragOver = (e: React.DragEvent, targetTaskId?: string) => {
        e.preventDefault()
        e.stopPropagation()
        setIsOver(true)
        if (targetTaskId) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
            setDropIndicator({ taskId: targetTaskId, position: pos })
        } else {
            setDropIndicator(null)
        }
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsOver(false)
        const taskId = e.dataTransfer.getData('taskId')
        if (taskId) onDropTask(taskId, status, dropIndicator?.taskId, dropIndicator?.position)
        setDropIndicator(null)
    }

    return (
        <div
            className={cn(
                "w-[300px] min-w-[300px] flex-shrink-0 flex flex-col rounded-xl p-3 min-h-[500px] border bg-card transition-colors",
                isOver ? "border-primary/50" : "border-border"
            )}
            onDragOver={(e) => handleDragOver(e)}
            onDragLeave={() => { setIsOver(false); setDropIndicator(null) }}
            onDrop={handleDrop}
        >
            <div className="flex items-center gap-2 px-2 py-3 mb-2">
                <StatusIcon status={status} />
                <span className="text-sm font-medium text-foreground">{cfg.label}</span>
                <span className="text-sm text-muted-foreground ml-1">{tasks.length}</span>
                <Maximize2 className="w-4 h-4 text-muted-foreground cursor-default ml-auto" />
            </div>
            <div className="flex-1 overflow-y-auto bg-transparent">
                <div className="flex flex-col gap-2">
                    {tasks.length === 0 && (
                        <div className="h-24 border-2 border-dashed border-border rounded-lg flex items-center justify-center text-xs text-muted-foreground/30">Empty</div>
                    )}
                    {tasks.map(task => (
                        <div key={task.id} onDragOver={(e) => handleDragOver(e, task.id)} className="relative">
                            {dropIndicator?.taskId === task.id && dropIndicator.position === 'before' && (
                                <div className="h-1 bg-primary/60 rounded-full mb-1 animate-pulse" />
                            )}
                            <TaskCard task={task} tenantSlug={tenantSlug} taskNumber={taskNumberMap.get(task.id) || 1} members={members} agents={agents} />
                            {dropIndicator?.taskId === task.id && dropIndicator.position === 'after' && (
                                <div className="h-1 bg-primary/60 rounded-full mt-1 animate-pulse" />
                            )}
                        </div>
                    ))}
                    {status === 'backlog' && (
                        <Button variant="ghost" size="sm" className="mt-2 w-full text-xs text-muted-foreground h-8 hover:text-foreground justify-start px-2" onClick={onAddTask}>
                            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Task
                        </Button>
                    )}
                </div>
            </div>
        </div>
    )
}

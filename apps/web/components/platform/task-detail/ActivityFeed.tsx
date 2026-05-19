'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { TaskEvent } from '@/types/task'

import { useTaskComments } from './useTaskComments'
import { ThreadTab } from './ThreadTab'
import { TimelineTab } from './TimelineTab'

interface ActivityFeedProps {
    taskId: string
    events: TaskEvent[]
}

export function ActivityFeed({ taskId, events }: ActivityFeedProps) {
    const [activeTab, setActiveTab] = useState<'Thread' | 'Timeline'>('Thread')
    const { comments, addComment } = useTaskComments(taskId)

    return (
        <div className="mt-8 border-t border-[#1e1e1e] pt-4">
            <div className="flex items-center gap-6 mb-6">
                <button
                    onClick={() => setActiveTab('Thread')}
                    className={cn(
                        "text-sm pb-2 transition-colors",
                        activeTab === 'Thread'
                            ? 'text-foreground border-b-2 border-white font-medium'
                            : 'text-muted-foreground hover:text-foreground/80',
                    )}
                >
                    Thread
                </button>
                <button
                    onClick={() => setActiveTab('Timeline')}
                    className={cn(
                        "text-sm pb-2 transition-colors",
                        activeTab === 'Timeline'
                            ? 'text-foreground border-b-2 border-white font-medium'
                            : 'text-muted-foreground hover:text-foreground/80',
                    )}
                >
                    Timeline
                </button>
            </div>

            {activeTab === 'Thread' && (
                <ThreadTab
                    taskId={taskId}
                    comments={comments}
                    isPosting={addComment.isPending}
                    onSubmit={(html) => addComment.mutate(html)}
                />
            )}

            {activeTab === 'Timeline' && <TimelineTab events={events} />}
        </div>
    )
}

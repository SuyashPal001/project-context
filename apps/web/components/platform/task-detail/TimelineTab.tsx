'use client'

import { useTaskTimeline } from './useTaskTimeline'
import { TimelineRowItem } from './timeline/rows'

export function TimelineTab({ taskId }: { taskId: string }) {
    const { rows, isLoading } = useTaskTimeline(taskId)

    if (isLoading) {
        return <p className="text-sm text-muted-foreground/40 italic py-4">Loading timeline…</p>
    }
    if (rows.length === 0) {
        return <p className="text-sm text-muted-foreground/40 italic py-4">No events yet.</p>
    }

    return (
        <div className="space-y-4 relative before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-[#1e1e1e] ml-1">
            {rows.map(row => (
                <TimelineRowItem key={row.kind === 'origin' ? 'origin' : row.id} row={row} />
            ))}
        </div>
    )
}

'use client'

import { useParams } from 'next/navigation'
import { TimelineView } from '@/components/platform/timeline/TimelineView'

export default function TimelinePage() {
    const params = useParams()
    const planId = params.planId as string

    return (
        <div className="h-[calc(100vh-120px)] min-h-[500px]">
            <TimelineView planId={planId} />
        </div>
    )
}

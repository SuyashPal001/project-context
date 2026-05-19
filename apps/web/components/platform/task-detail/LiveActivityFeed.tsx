'use client'

import { useRef, useEffect } from 'react'
import type { Step } from '@/types/task'

interface LiveActivityFeedProps {
    activity: NonNullable<Step['liveActivity']>
    thinking: boolean
    liveText?: string
}

export function LiveActivityFeed({ activity, thinking, liveText }: LiveActivityFeedProps) {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
    }, [activity, thinking, liveText])

    return (
        <div
            ref={ref}
            className="mt-3 ml-9 max-h-48 overflow-y-auto rounded-lg bg-black/70 border border-[#2a2a2a] p-3 font-mono text-xs space-y-2 leading-relaxed"
        >
            {activity.map((item, i) => (
                <div key={i} className="space-y-0.5">
                    {item.completed ? (
                        <>
                            <div className="text-emerald-400/80">
                                {'✓ '}{item.toolName} completed{item.durationMs !== undefined ? ` (${(item.durationMs / 1000).toFixed(1)}s)` : ''}
                            </div>
                            {item.resultSummary && item.resultSummary !== 'Completed' && (
                                <div className="pl-4 text-muted-foreground/50 truncate">{item.resultSummary}</div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className="text-amber-400/80">{'⚡ Calling '}{item.toolName}</div>
                            {item.toolInput && (
                                <div className="pl-4 text-muted-foreground/50 truncate">{item.toolInput}</div>
                            )}
                        </>
                    )}
                </div>
            ))}
            {thinking && !liveText && (
                <div className="text-primary/60">{'✍️ Agent is writing...'}</div>
            )}
            {liveText && (
                <div className="text-emerald-300/70 whitespace-pre-wrap">{liveText}</div>
            )}
        </div>
    )
}

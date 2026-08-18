'use client'

import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Task, Step, TaskEvent } from '@/types/task'
import { StepCard } from '../StepCard'

// Minimum number of slots to always show (prevents layout jump on first step)
const MIN_SLOTS = 4

interface PlanningPhaseProps {
    task: Task
    steps: Step[]
    events: TaskEvent[]
}

function PlanningStepSkeleton({ fast }: { fast?: boolean }) {
    return (
        <div className="border border-border bg-card rounded-xl p-4 mb-3">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className={cn(
                        'w-10 h-10 rounded-full flex-shrink-0 mt-0.5 bg-muted/60 animate-pulse',
                        fast && '[animation-duration:0.6s]',
                    )} />
                    <div className="flex-1 min-w-0 space-y-2">
                        <div className={cn('h-3 rounded bg-muted/60 animate-pulse w-3/4', fast && '[animation-duration:0.6s]')} />
                        <div className={cn('h-3 rounded bg-muted/60 animate-pulse w-full', fast && '[animation-duration:0.6s]')} />
                        <div className={cn('h-3 rounded bg-muted/60 animate-pulse w-1/2', fast && '[animation-duration:0.6s]')} />
                    </div>
                </div>
                <div className={cn('h-3 w-12 bg-muted/60 animate-pulse rounded flex-shrink-0', fast && '[animation-duration:0.6s]')} />
            </div>
        </div>
    )
}

export function PlanningPhase({ task: _task, steps, events }: PlanningPhaseProps) {
    const isRevising = events.some(
        e => e.eventType === 'plan_rejected' || e.eventType === 'clarification_answered',
    )

    // Fast-pulse the trailing skeleton for 500 ms after each new step arrives
    const prevLenRef = useRef(steps.length)
    const [fastPulse, setFastPulse] = useState(false)
    useEffect(() => {
        if (steps.length > prevLenRef.current) {
            prevLenRef.current = steps.length
            setFastPulse(true)
            const t = setTimeout(() => setFastPulse(false), 500)
            return () => clearTimeout(t)
        }
    }, [steps.length])

    // Slot count: at least MIN_SLOTS, grows if agent sends more steps than expected
    const slotCount = Math.max(MIN_SLOTS, steps.length + 1)

    const statusText = steps.length === 0
        ? 'Saarthi Workflow is planning...'
        : `Saarthi Workflow is planning · ${steps.length} step${steps.length !== 1 ? 's' : ''} so far`

    return (
        <div>
            {isRevising ? (
                <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/15 text-xs text-amber-400/70">
                    <RefreshCw className="w-3 h-3 shrink-0" />
                    Revising based on your feedback...
                </div>
            ) : (
                <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-[#111] border border-[#1e1e1e]">
                    <span className="text-sm text-muted-foreground/60 transition-all duration-300">{statusText}</span>
                </div>
            )}

            {/* Fixed slots: real card fills in-place as steps arrive, rest stay as skeletons */}
            {Array.from({ length: slotCount }).map((_, i) => {
                const step = steps[i]
                if (step) {
                    return (
                        <div key={step.id} className="animate-in fade-in duration-500">
                            <StepCard step={step} index={i} />
                        </div>
                    )
                }
                // Only the immediately trailing skeleton gets fast pulse
                const isTrailing = i === steps.length
                return (
                    <PlanningStepSkeleton key={`skeleton-${i}`} fast={isTrailing && fastPulse} />
                )
            })}
        </div>
    )
}

'use client'

import { useState } from 'react'
import { ThumbsDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StepCard } from '../StepCard'
import { TaskExecutionCost } from '@/components/platform/credits/TaskExecutionCost'
import type { Task, Step } from '@/types/task'

interface PlanReviewPhaseProps {
    task: Task
    steps: Step[]
    onApprovePlan: () => void
    onRejectPlan: (feedback?: string) => Promise<void>
}

export function PlanReviewPhase({ task, steps, onApprovePlan, onRejectPlan }: PlanReviewPhaseProps) {
    const [rejecting, setRejecting] = useState(false)
    const [feedback, setFeedback] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)

    return (
        <div>
            {steps.map((step, i) => (
                <div key={step.id} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <StepCard step={step} index={i} />
                </div>
            ))}

            {task.status === 'awaiting_approval' && (
                <div className="mt-4 rounded-xl border border-[#1e1e1e] bg-[#0f0f0f] overflow-hidden">
                    <div className="p-3 flex items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">
                            Review the {steps.length}-step plan above and approve or request changes.
                        </p>
                        <div className="flex items-center gap-2 flex-shrink-0">
                            <Button
                                variant="outline"
                                size="sm"
                                className="text-xs h-8 gap-1.5 border-[#2a2a2a] hover:border-red-500/40 hover:text-red-400"
                                onClick={() => setRejecting(true)}
                            >
                                <ThumbsDown className="w-3.5 h-3.5" /> Request Changes
                            </Button>
                        </div>
                    </div>

                    {/* Approving here is what actually enqueues execution — this is
                        the moment credits are committed, so the cost preview and the
                        Approve control both live inside TaskExecutionCost. */}
                    <div className="border-t border-[#1e1e1e]">
                        <TaskExecutionCost agentId={task.agentId} stepCount={steps.length} onApprove={onApprovePlan} />
                    </div>

                    {rejecting && (
                        <div className="px-3 pb-3 border-t border-[#1e1e1e] pt-3 space-y-2">
                            <textarea
                                placeholder="What should be changed? (optional)"
                                value={feedback}
                                onChange={e => setFeedback(e.target.value)}
                                className="w-full text-sm bg-background border border-border rounded-lg p-3 resize-none focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground"
                                rows={3}
                                autoFocus
                            />
                            {submitError && (
                                <p className="text-xs text-red-400">{submitError}</p>
                            )}
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs h-8"
                                    disabled={isSubmitting}
                                    onClick={() => { setRejecting(false); setFeedback('') }}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    size="sm"
                                    className="text-xs h-8 bg-red-600 hover:bg-red-700 text-white"
                                    disabled={isSubmitting}
                                    onClick={async () => {
                                        setIsSubmitting(true)
                                        setSubmitError(null)
                                        try {
                                            await onRejectPlan(feedback)
                                            setRejecting(false)
                                            setFeedback('')
                                        } catch {
                                            setSubmitError('Failed to send feedback. Please try again.')
                                        } finally {
                                            setIsSubmitting(false)
                                        }
                                    }}
                                >
                                    {isSubmitting ? 'Sending...' : 'Send Feedback \u0026 Replan'}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

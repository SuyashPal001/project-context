'use client'

import { useState } from 'react'
import { Loader2, Clock, Zap, MessageSquare, Check, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import type { Step } from '@/types/task'
import { parseAgentOutput } from './outputHelpers'
import { StepInsightsModal } from './StepInsightsModal'
import { LiveActivityFeed } from './LiveActivityFeed'
import { StepResults } from './StepResults'

export function StepCard({ step, index }: { step: Step; index: number }) {
    const [insightsOpen, setInsightsOpen] = useState(false)
    const parsedOutput = parseAgentOutput(step.agentOutput ?? null)
    const score = step.confidenceScore != null ? Number(step.confidenceScore) : null
    const scoreColor = score === null ? '' : score >= 0.8 ? 'bg-emerald-500' : score >= 0.6 ? 'bg-amber-500' : 'bg-red-500'
    const isRunning = step.status === 'running'

    return (
        <div className={cn(
            'border rounded-xl p-4 mb-3 transition-all group',
            isRunning ? 'bg-[#0d1117] border-primary/40 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]' : 'bg-[#111] border-[#1e1e1e]',
        )}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className={cn(
                        'w-6 h-6 rounded-full text-xs flex items-center justify-center flex-shrink-0 mt-0.5 border font-medium',
                        step.status === 'done' ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400' :
                        isRunning ? 'bg-primary/10 border-primary/40 text-primary' :
                        step.status === 'failed' ? 'bg-red-500/10 border-red-500/40 text-red-400' :
                        step.status === 'skipped' ? 'bg-[#1e1e1e] border-[#2a2a2a] text-muted-foreground/30' :
                        'bg-[#1e1e1e] border-[#2a2a2a] text-muted-foreground',
                    )}>
                        {step.status === 'done' ? <Check className="w-3 h-3" /> :
                         isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> :
                         step.status === 'failed' ? <XCircle className="w-3 h-3" /> :
                         index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className={cn('text-sm font-medium leading-snug', step.status === 'skipped' ? 'line-through text-muted-foreground/40' : 'text-foreground')}>
                            {step.title}
                        </p>
                        {step.description && (
                            <p className="mt-1 text-xs text-muted-foreground/60 leading-relaxed">{step.description}</p>
                        )}
                        <div className="mt-3 flex items-center gap-3 flex-wrap">
                            {step.toolName && (
                                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono text-primary/80 bg-primary/5 border border-primary/10">
                                    <Zap className="w-2.5 h-2.5" />
                                    {step.toolName}
                                </div>
                            )}
                            {step.estimatedHours != null && (
                                <div className="flex items-center gap-1 text-[11px] text-muted-foreground/50">
                                    <Clock className="w-2.5 h-2.5" />
                                    {step.estimatedHours}h
                                </div>
                            )}
                            {score !== null && (
                                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50">
                                    <div className="w-12 h-0.5 bg-[#2a2a2a] rounded-full overflow-hidden">
                                        <div
                                            className={cn('h-full rounded-full transition-all duration-500')}
                                            style={{ width: `${score * 100}%`, backgroundColor: scoreColor.split('-')[1] }}
                                        />
                                    </div>
                                    <span>{Math.round(score * 100)}%</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <Badge variant="outline" className={cn(
                        'capitalize text-[10px] px-1.5 py-0 h-4 min-w-[50px] justify-center',
                        step.status === 'done' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        isRunning ? 'bg-primary/10 text-primary border-primary/20' :
                        step.status === 'failed' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                        step.status === 'skipped' ? 'bg-muted/10 text-muted-foreground/30 border-transparent line-through' :
                        'bg-muted/10 text-muted-foreground/50 border-transparent',
                    )}>
                        {isRunning ? 'running' : step.status}
                    </Badge>
                    <button
                        onClick={() => setInsightsOpen(true)}
                        className="text-[10px] font-medium text-muted-foreground/40 hover:text-primary transition-colors flex items-center gap-1"
                    >
                        <MessageSquare className="w-2.5 h-2.5" />
                        Why this?
                    </button>
                </div>
            </div>

            {isRunning && (step.liveActivity?.length || step.agentThinking || step.liveText) ? (
                <LiveActivityFeed
                    activity={step.liveActivity ?? []}
                    thinking={step.agentThinking ?? false}
                    liveText={step.liveText}
                />
            ) : null}

            {(step.humanFeedback || step.agentOutput) && (
                <div className="mt-3 ml-9 space-y-2">
                    {step.humanFeedback && (
                        <div className="p-2 bg-amber-500/5 border border-amber-500/10 rounded-lg text-xs text-amber-300/60 leading-relaxed italic">
                            <span className="font-bold text-amber-500/50 mr-1 not-italic tracking-tighter uppercase text-[9px]">Feedback:</span> {step.humanFeedback}
                        </div>
                    )}
                    <StepResults step={step} parsedOutput={parsedOutput} />
                </div>
            )}

            <StepInsightsModal open={insightsOpen} onOpenChange={setInsightsOpen} step={step} parsedOutput={parsedOutput} />
        </div>
    )
}

'use client'

import { Wrench, Clock, Zap, MessageSquare, Check, Target } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import type { Step } from '@/types/task'
import type { ParsedOutput } from './outputHelpers'

interface StepInsightsModalProps {
    open: boolean
    onOpenChange: (v: boolean) => void
    step: Step
    parsedOutput: ParsedOutput | null
}

export function StepInsightsModal({ open, onOpenChange, step, parsedOutput }: StepInsightsModalProps) {
    if (!step) return null

    const reasoning = parsedOutput?.reasoning || step.reasoning || null
    const toolRationale = parsedOutput?.toolRationale || null
    const summary = parsedOutput?.summary || null
    const results = parsedOutput?.results && parsedOutput.results.length > 0 ? parsedOutput.results : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl bg-[#0f0f0f] border border-[#1e1e1e] shadow-2xl p-0 overflow-hidden">
                <DialogHeader className="p-6 border-b border-[#1e1e1e] bg-[#141414]">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-xs font-bold">
                            {step.stepNumber}
                        </div>
                        <DialogTitle className="text-lg font-bold">{step.title}</DialogTitle>
                    </div>
                </DialogHeader>
                <div className="p-6 space-y-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
                    <section>
                        <h4 className="text-[11px] font-bold text-muted-foreground/40 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <Target className="w-3 h-3 text-primary" /> Reasoning & Strategic Context
                        </h4>
                        <div className="bg-[#161616] p-4 rounded-xl border border-[#1e1e1e] text-sm text-foreground/80 leading-relaxed italic">
                            &ldquo;{reasoning || 'No detailed reasoning provided for this specific step yet.'}&rdquo;
                        </div>
                    </section>
                    {step.toolName && (
                        <section>
                            <h4 className="text-[11px] font-bold text-muted-foreground/40 uppercase tracking-widest mb-3 flex items-center gap-2">
                                <Zap className="w-3 h-3 text-primary" /> Tool Selection
                            </h4>
                            <div className="flex items-center gap-3 p-3 bg-primary/5 border border-primary/10 rounded-xl">
                                <div className="p-2 bg-primary/10 rounded-lg">
                                    <Wrench className="w-4 h-4 text-primary" />
                                </div>
                                <div className="flex-1">
                                    <p className="text-sm font-mono text-primary font-medium">{step.toolName}</p>
                                    <p className="text-[11px] text-muted-foreground mt-0.5">
                                        {toolRationale || 'This tool was chosen to maximize execution precision based on your specific requirements.'}
                                    </p>
                                </div>
                            </div>
                        </section>
                    )}
                    {summary && (
                        <section>
                            <h4 className="text-[11px] font-bold text-muted-foreground/40 uppercase tracking-widest mb-3 flex items-center gap-2">
                                <MessageSquare className="w-3 h-3 text-primary" /> Summary
                            </h4>
                            <div className="bg-[#161616] p-4 rounded-xl border border-[#1e1e1e] text-sm text-foreground/80 leading-relaxed">
                                {summary}
                            </div>
                        </section>
                    )}
                    {results && (
                        <section>
                            <h4 className="text-[11px] font-bold text-muted-foreground/40 uppercase tracking-widest mb-3 flex items-center gap-2">
                                <Check className="w-3 h-3 text-primary" /> Results
                            </h4>
                            <div className="space-y-2">
                                {results.map((r, i) => (
                                    <div key={i} className="rounded-lg border border-[#1e1e1e] bg-[#161616] px-3 py-2.5 text-xs space-y-1">
                                        {r.title && <p className="text-foreground font-medium">{r.title}</p>}
                                        {r.url && (
                                            <a
                                                href={r.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="block text-primary hover:underline truncate"
                                            >
                                                {r.url}
                                            </a>
                                        )}
                                        {r.description && <p className="text-muted-foreground/70 leading-relaxed">{r.description}</p>}
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                    <section>
                        <div className="flex items-center justify-between mb-4">
                            <h4 className="text-[11px] font-bold text-muted-foreground/40 uppercase tracking-widest flex items-center gap-2">
                                <Clock className="w-3 h-3 text-primary" /> Strategy Changelog
                            </h4>
                            {step.feedbackHistory && (
                                <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded border border-primary/20">
                                    {step.feedbackHistory.length} revisions
                                </span>
                            )}
                        </div>
                        {step.feedbackHistory && step.feedbackHistory.length > 0 ? (
                            <div className="space-y-4 relative before:absolute before:left-2 before:top-2 before:bottom-2 before:w-[1px] before:bg-[#1e1e1e]">
                                {step.feedbackHistory.map((h, i) => (
                                    <div key={i} className="relative pl-7">
                                        <div className="absolute left-0 top-1 w-4 h-4 rounded-full bg-[#111] border border-[#1e1e1e] flex items-center justify-center">
                                            <div className="w-1.5 h-1.5 rounded-full bg-primary/40" />
                                        </div>
                                        <div className="text-[11px] text-muted-foreground mb-1">{h.date} (User Feedback)</div>
                                        <div className="bg-[#111] p-3 rounded-lg border border-[#1e1e1e] text-xs text-foreground/70 leading-relaxed">{h.content}</div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-xs text-muted-foreground/30 italic py-6 text-center bg-[#111] rounded-xl border border-dashed border-[#1e1e1e]">
                                No feedback history yet. This step is original.
                            </div>
                        )}
                    </section>
                </div>
                <DialogFooter className="p-4 bg-[#141414] border-t border-[#1e1e1e]">
                    <Button onClick={() => onOpenChange(false)} variant="ghost" className="text-xs h-8 text-muted-foreground hover:text-foreground">
                        Close Insight
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

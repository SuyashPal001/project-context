'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { Step } from '@/types/task'
import { extractDomain, renderInlineMarkdown, ParsedOutput } from './outputHelpers'
import { AgentOutputRenderer } from './AgentOutputRenderer'

interface StepResultsProps {
    step: Step
    parsedOutput: ParsedOutput | null
}

export function StepResults({ step, parsedOutput }: StepResultsProps) {
    const [resultsExpanded, setResultsExpanded] = useState(false)

    if (!step.summary && !step.agentOutput) return null

    return (
        <div className="p-3 bg-emerald-500/5 border border-emerald-500/10 rounded-lg">
            <span className="block font-bold text-emerald-500/50 tracking-tighter uppercase text-[9px] mb-1.5">Result</span>
            {/* Case 1: JSON output with structured results */}
            {!step.summary && parsedOutput?.summary ? (
                <div className="space-y-3">
                    <p className="text-sm text-foreground/90 leading-relaxed">
                        {renderInlineMarkdown(parsedOutput.summary)}
                    </p>
                    {parsedOutput.results && parsedOutput.results.length > 0 && (
                        <div>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    setResultsExpanded(v => !v)
                                }}
                                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {resultsExpanded
                                    ? <ChevronUp className="w-3 h-3" />
                                    : <ChevronDown className="w-3 h-3" />
                                }
                                {parsedOutput.results.length} sources
                            </button>
                            {resultsExpanded && (
                                <div className="mt-2 space-y-3">
                                    {parsedOutput.results.map((r, i) => (
                                        <div
                                            key={i}
                                            className="border-b border-border/30 pb-3 last:border-0 last:pb-0"
                                        >
                                            {r.title && (
                                                <p className="text-sm font-semibold text-foreground leading-snug">
                                                    {r.title}
                                                </p>
                                            )}
                                            {r.url && (
                                                <a
                                                    href={r.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-xs font-mono text-primary/70 hover:text-primary transition-colors truncate block mt-0.5"
                                                >
                                                    {extractDomain(r.url)}
                                                </a>
                                            )}
                                            {r.description && (
                                                <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                                                    {renderInlineMarkdown(r.description)}
                                                </p>
                                            )}
                                            {r.company && (
                                                <p className="text-xs text-muted-foreground/50 italic mt-0.5">
                                                    {r.company}
                                                </p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ) : (
                /* Case 2: step.summary exists or agentOutput is plain text */
                <AgentOutputRenderer content={step.summary || step.agentOutput!} />
            )}
        </div>
    )
}

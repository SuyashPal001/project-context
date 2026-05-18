'use client'

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ChevronRight, Sparkles, ExternalLink } from 'lucide-react'
import { parseAgentOutput, renderInlineMarkdown } from './outputHelpers'

function cleanAgentComment(content: string): string {
    return content
        .split('\n')
        .map(line => {
            // Strip ```json ... ``` fenced blocks within a line
            let cleaned = line.replace(/```json[\s\S]*?```/g, '').trim()
            // Strip inline JSON objects { ... } from end of line.
            // Keep the part before the first { if that part is
            // non-empty human text (ends with ":" or is a numbered item).
            const jsonStart = cleaned.indexOf('{')
            if (jsonStart > 0) {
                const before = cleaned.slice(0, jsonStart).trim()
                if (before.match(/:\s*$/) || before.match(/^\d+\./)) {
                    cleaned = before.replace(/:\s*$/, '').trim()
                }
            }
            return cleaned
        })
        .filter(line => line.length > 0)
        .join('\n')
}

interface StructuredOutputProps {
    parsed: NonNullable<ReturnType<typeof parseAgentOutput>>
    preText?: string
    thinkingOpen: boolean
    onToggleThinking: () => void
}

function StructuredOutput({ parsed, preText, thinkingOpen, onToggleThinking }: StructuredOutputProps) {
    const hasThinking = !!(parsed.reasoning || parsed.toolRationale)
    return (
        <div className="space-y-2.5">
            {preText && (
                <p className="text-sm text-foreground/85 leading-relaxed">{preText}</p>
            )}
            {hasThinking && (
                <button
                    onClick={onToggleThinking}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors group"
                >
                    {thinkingOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    <Sparkles className="w-3 h-3" />
                    <span>Thinking</span>
                </button>
            )}
            {hasThinking && thinkingOpen && (
                <div className="text-[12px] text-muted-foreground/50 italic leading-relaxed border-l border-primary/20 pl-3">
                    {parsed.reasoning || parsed.toolRationale}
                </div>
            )}
            {parsed.summary && (
                <p className="text-sm text-foreground/85 leading-relaxed">
                    {renderInlineMarkdown(parsed.summary)}
                </p>
            )}
            {parsed.results && parsed.results.length > 0 && (
                <div className="mt-1 space-y-1.5">
                    {parsed.results.map((r, i) => (
                        <div key={i} className="flex items-start gap-2 py-1.5 px-2 rounded bg-[#0f0f0f] border border-[#1e1e1e]">
                            <span className="text-[11px] text-muted-foreground/40 mt-0.5 w-4 shrink-0 text-right">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                                <span className="text-xs font-medium text-foreground/80 leading-snug">{r.title}</span>
                                {r.company && (
                                    <span className="ml-2 text-[11px] text-muted-foreground/50">{r.company}</span>
                                )}
                                {r.description && (
                                    <p className="text-[11px] text-muted-foreground/50 mt-0.5 line-clamp-2 leading-snug">{r.description}</p>
                                )}
                            </div>
                            {r.url && (
                                <a
                                    href={r.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="shrink-0 text-primary/50 hover:text-primary transition-colors"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                </a>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {!preText && !parsed.summary && (!parsed.results || parsed.results.length === 0) && (
                <p className="text-sm text-muted-foreground/60 italic">Agent completed the task.</p>
            )}
        </div>
    )
}

export function AgentCommentBody({ content }: { content: string }) {
    const [thinkingOpen, setThinkingOpen] = useState(false)
    const toggleThinking = () => setThinkingOpen(v => !v)

    // Case 1: entire content is JSON (or fenced JSON)
    const parsed = parseAgentOutput(content)
    if (parsed) {
        return (
            <StructuredOutput
                parsed={parsed}
                thinkingOpen={thinkingOpen}
                onToggleThinking={toggleThinking}
            />
        )
    }

    // Case 2: text prefix + embedded ```json ... ``` block
    // e.g. "✅ All steps completed. Here's what I did:\n```json\n{...}\n```"
    const fencedMatch = content.match(/^([\s\S]*?)```(?:json)?\s*([\s\S]+?)```([\s\S]*)$/)
    if (fencedMatch) {
        const preText = fencedMatch[1].trim()
        const parsedFromFence = parseAgentOutput(fencedMatch[2].trim())
        if (parsedFromFence) {
            return (
                <StructuredOutput
                    parsed={parsedFromFence}
                    preText={preText || undefined}
                    thinkingOpen={thinkingOpen}
                    onToggleThinking={toggleThinking}
                />
            )
        }
    }

    // Case 3: plain text / markdown fallback
    return (
        <div className="prose prose-invert prose-sm max-w-none prose-p:my-0.5 prose-ul:my-0.5 prose-ol:my-0.5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {cleanAgentComment(content)}
            </ReactMarkdown>
        </div>
    )
}

"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentOrb } from "./AgentOrb";
import { ToolCall, CompletedToolCall } from "./types";
import { ToolCallCard } from "./ToolCallCard";

// Live extended-thinking trace, streamed via the 'reasoning' SSE event (see
// useChatStream's onReasoning). Collapsed by default — same disclosure pattern
// as TraceSummary's post-completion "Worked for Ns" row.
//
// `completed` distinguishes the historical (TraceSummary) usage from the live
// (ThinkingIndicator) usage: live still reads "Thinking it through" with the
// violet/shimmer treatment (an active, in-progress state); completed reads
// "Thought for Ns" in plain text-foreground, matching ToolCallCard's finished
// rows — shimmer/color on a state that already ended reads as still-active.
export function ReasoningRow({ text, completed = false, elapsedSec }: { text: string; completed?: boolean; elapsedSec?: number }) {
    const [expanded, setExpanded] = useState(false);
    if (!text) return null;

    return (
        <div className="my-1.5 text-foreground">
            <button
                type="button"
                onClick={() => setExpanded(e => !e)}
                className="flex items-center gap-2 w-full text-left"
            >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0 text-current">
                    <path d="M2 3.5h10a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5.5L3 12v-2.5H2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
                </svg>
                {completed ? (
                    <span className="text-sm font-semibold flex-1 truncate text-foreground">
                        {elapsedSec !== undefined ? `Thought for ${elapsedSec}s` : 'Thought it through'}
                    </span>
                ) : (
                    // Lighter tone of the same primary shade "Working for Ns" uses (text-primary/80),
                    // not the inherited near-white text-foreground — the shimmer gradient sweeps
                    // currentColor -> #fff -> currentColor, so a base color already close to white
                    // leaves almost no visible contrast to sweep.
                    <span className="shimmer-text text-sm font-semibold flex-1 truncate text-primary/60">Thinking it through</span>
                )}
                <svg
                    width="10" height="10" viewBox="0 0 10 10" fill="none"
                    className={`shrink-0 transition-transform text-foreground ${expanded ? "rotate-90" : ""}`}
                >
                    <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            {expanded && (
                <div className="flex gap-2.5 mt-1.5 pl-0.5">
                    <div className="w-3 shrink-0 border-l border-b border-border rounded-bl-md" style={{ marginTop: '-4px', height: '0.85em' }} />
                    <div className="text-sm text-muted-foreground flex-1 min-w-0 [&>*]:mb-2 [&>*:last-child]:mb-0">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                                p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
                                strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                                ul: ({ children }) => <ul className="list-disc list-outside ml-4 space-y-1">{children}</ul>,
                                ol: ({ children }) => <ol className="list-decimal list-outside ml-4 space-y-1">{children}</ol>,
                            }}
                        >
                            {text}
                        </ReactMarkdown>
                    </div>
                </div>
            )}
        </div>
    );
}

const WARMUP_STEPS = [
    "Thinking...",
    "Still working on it...",
    "Taking a bit longer than usual...",
];

const WARMUP_STEP_INTERVAL_MS = 8_000;

function PulsingDots() {
    return (
        <span className="flex gap-[3px] items-center">
            <span className="h-[4px] w-[4px] rounded-full bg-primary/70 animate-bounce [animation-delay:-0.3s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-primary/70 animate-bounce [animation-delay:-0.15s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-primary/70 animate-bounce" />
        </span>
    );
}

// The content-only half of the live indicator — "Working for Ns · <message>",
// active/completed tool-call cards, and the live reasoning row. No AgentOrb,
// no outer row wrapper: this renders inside whichever surface already
// provides those (MessageItem's own row for the actively-streaming message,
// or ThinkingIndicator's own wrapper for the window before that message row
// exists yet — see both call sites below). Returns null once nothing is
// streaming, mirroring the old inline Phase 2 fallthrough.
export interface LiveTraceProps {
    isStreaming: boolean;
    activeToolCalls: ToolCall[];
    completedToolCalls: CompletedToolCall[];
    reasoningText?: string;
}

export function LiveTrace({
    isStreaming,
    activeToolCalls,
    completedToolCalls,
    reasoningText = '',
}: LiveTraceProps) {
    const [messageIndex, setMessageIndex] = useState(0);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    // Ticks the live "Working for Ns" counter once a second. This is separate
    // from the completedTrace concept (which lives on the Message once
    // streaming finishes) — purely a local display value for the in-progress
    // Phase 2a line, so it doesn't need to survive this component unmounting.
    const [liveElapsed, setLiveElapsed] = useState(0);

    const isRAG = activeToolCalls.some(tc => tc.toolName === 'retrieve_documents');
    const isPRD = activeToolCalls.some(tc =>
        tc.toolName === 'save-prd' || tc.toolName === 'savePRD'
        || tc.toolName?.startsWith('agent-prd') || tc.toolName?.startsWith('workflow-prd'));
    const isRoadmap = activeToolCalls.some(tc =>
        tc.toolName === 'save-plan' || tc.toolName === 'savePlan'
        || tc.toolName?.startsWith('agent-roadmap'));
    const isTasks = activeToolCalls.some(tc =>
        tc.toolName === 'save-tasks' || tc.toolName === 'saveTasks'
        || tc.toolName?.startsWith('agent-task'));

    const THINKING_MESSAGES = [
        "Thinking...",
        "Reading your question...",
        "Forming a response...",
        "Almost there...",
    ];

    const RAG_MESSAGES = [
        "Searching your documents...",
        "Finding relevant context...",
        "Reviewing sources...",
    ];

    const PRD_MESSAGES = [
        "Writing your PRD...",
        "Structuring requirements...",
        "Adding acceptance criteria...",
        "Finalising the document...",
    ];

    const ROADMAP_MESSAGES = [
        "Building your roadmap...",
        "Organising milestones...",
        "Sequencing deliverables...",
        "Almost done...",
    ];

    const TASKS_MESSAGES = [
        "Breaking down tasks...",
        "Estimating effort...",
        "Assigning priorities...",
        "Almost done...",
    ];

    const thinkingMessages = isPRD ? PRD_MESSAGES
        : isRoadmap ? ROADMAP_MESSAGES
        : isTasks ? TASKS_MESSAGES
        : isRAG ? RAG_MESSAGES
        : THINKING_MESSAGES;

    useEffect(() => {
        if (!isStreaming) return;
        const id = setInterval(() => {
            setMessageIndex(prev => (prev + 1) % thinkingMessages.length);
        }, 2500);
        return () => clearInterval(id);
    }, [isStreaming, thinkingMessages.length]);

    useEffect(() => {
        if (isStreaming && startedAt === null) {
            setStartedAt(Date.now());
        }
    }, [isStreaming, startedAt]);

    useEffect(() => {
        if (!isStreaming || startedAt === null) return;
        const tick = () => setLiveElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [isStreaming, startedAt]);

    // Tool calls (active + completed)
    const loadingTools = activeToolCalls.filter(t => t.isLoading);
    if (loadingTools.length > 0 || completedToolCalls.length > 0) {
        return (
            <div className="animate-in fade-in duration-300">
                {liveElapsed >= 2 && (
                    <div className="shimmer-text text-sm text-primary/80 font-mono mb-1.5" key={loadingTools.length > 0 ? messageIndex : 'done'}>
                        Working for {liveElapsed}s{loadingTools.length > 0 ? ` · ${thinkingMessages[messageIndex]}` : ''}
                    </div>
                )}
                <ReasoningRow text={reasoningText} />
                {completedToolCalls.map(tc => (
                    <ToolCallCard
                        key={tc.id}
                        toolName={tc.toolName}
                        query={tc.query}
                        status="done"
                        results={tc.results}
                    />
                ))}
                {loadingTools.map(tool => (
                    <ToolCallCard
                        key={tool.id}
                        toolName={tool.toolName}
                        query={String(tool.arguments?.query ?? tool.arguments?.filename ?? tool.arguments?.subject ?? '')}
                        status="loading"
                    />
                ))}
            </div>
        );
    }

    // Plain thinking, no tool calls yet
    if (isStreaming) {
        return (
            <div className="animate-in fade-in duration-300">
                <div className="flex items-center gap-2">
                    <PulsingDots />
                    <span className="shimmer-text text-sm text-primary/80 font-mono animate-in fade-in duration-500" key={messageIndex}>
                        {liveElapsed >= 2 ? `Working for ${liveElapsed}s · ` : ''}{thinkingMessages[messageIndex]}
                    </span>
                </div>
                <ReasoningRow text={reasoningText} />
            </div>
        );
    }

    return null;
}

// Wraps LiveTrace with its own AgentOrb + row, and owns the retry-warmup
// phase — used only as MessageThread's trailing element, for the window
// before a streaming message row exists yet in the messages array (no tool
// call/reasoning delta has arrived, so onDelta hasn't created that row).
// Once a row exists, MessageItem renders LiveTrace itself, inside that row,
// above its text — see MessageThread's hasStreamingMessage gate.
export interface ThinkingIndicatorProps {
    isRetrying: boolean;
    isStreaming: boolean;
    activeToolCalls: ToolCall[];
    completedToolCalls: CompletedToolCall[];
    reasoningText?: string;
}

export function ThinkingIndicator({
    isRetrying,
    isStreaming,
    activeToolCalls,
    completedToolCalls,
    reasoningText = '',
}: ThinkingIndicatorProps) {
    const [stepIndex, setStepIndex] = useState(0);

    useEffect(() => {
        if (!isRetrying) {
            setStepIndex(0);
            return;
        }
        setStepIndex(0);
        const id = setInterval(() => {
            setStepIndex(prev => (prev + 1) % WARMUP_STEPS.length);
        }, WARMUP_STEP_INTERVAL_MS / 2); // Cycle faster
        return () => clearInterval(id);
    }, [isRetrying]);

    if (isRetrying) {
        return (
            <div className="flex items-center gap-4 animate-in fade-in duration-300 pt-1">
                <AgentOrb size={40} state="thinking" isLoading />
                <div className="h-6 overflow-hidden">
                    <div
                        className="transition-transform duration-500 ease-in-out"
                        style={{ transform: `translateY(-${stepIndex * 1.5}rem)` }}
                    >
                        {WARMUP_STEPS.map((step) => (
                            <div key={step} className="flex items-center gap-2 h-6">
                                <PulsingDots />
                                <span className="text-sm text-primary/80 font-mono">
                                    {step}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (!isStreaming) return null;

    const hasToolActivity = activeToolCalls.some(t => t.isLoading) || completedToolCalls.length > 0;

    return (
        <div className="flex items-start gap-4">
            <AgentOrb size={40} state={hasToolActivity ? "searching" : "thinking"} isLoading={hasToolActivity} />
            <div className={hasToolActivity ? "flex-1 pt-1" : "flex-1 pt-1.5"}>
                <LiveTrace
                    isStreaming={isStreaming}
                    activeToolCalls={activeToolCalls}
                    completedToolCalls={completedToolCalls}
                    reasoningText={reasoningText}
                />
            </div>
        </div>
    );
}

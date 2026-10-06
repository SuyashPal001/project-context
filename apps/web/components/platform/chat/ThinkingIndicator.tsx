"use client";

import { useContext, useEffect, useState } from "react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentOrb } from "./AgentOrb";
import { ToolCall, CompletedToolCall, LiveStep } from "./types";
import { StepList } from "./StepList";
import { AwaitingApprovalContext, ToolCallCard, groupImageToolCalls, withoutRepeatedTraceFiles } from "./ToolCallCard";
import type { PersonaSummary } from "../personas/types";

// Live extended-thinking trace, streamed via the 'reasoning' SSE event (see
// useChatStream's onReasoning). Collapsed by default — same disclosure pattern
// as TraceSummary's post-completion "Worked for Ns" row.
//
// `completed` distinguishes the historical (TraceSummary) usage from the live
// (ThinkingIndicator) usage: live still reads "Thinking it through" with the
// violet/shimmer treatment (an active, in-progress state); completed reads
// "Thought for Ns" in plain text-foreground, matching ToolCallCard's finished
// rows — shimmer/color on a state that already ended reads as still-active.
// Chevron on the left, a thin guide line under an open row, no boxes — the
// same shape as the step list it sits with (user's pick, 2026-10-06).
export function Chevron({ open }: { open: boolean }) {
    return (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`shrink-0 transition-transform text-muted-foreground ${open ? "rotate-90" : ""}`}>
            <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function ReasoningRow({ text, completed = false, elapsedSec, defaultOpen }: { text: string; completed?: boolean; elapsedSec?: number; defaultOpen?: boolean }) {
    // Live thinking opens itself when it is all there is to watch; during a
    // long job with a step list it stays one quiet line that opens on tap.
    // The completed row (TraceSummary) starts folded.
    const [expanded, setExpanded] = useState(defaultOpen ?? !completed);
    if (!text) return null;

    return (
        <div className="my-1 text-foreground">
            <button
                type="button"
                onClick={() => setExpanded(e => !e)}
                className="flex items-center gap-2 w-full text-left"
            >
                <Chevron open={expanded} />
                {completed ? (
                    <span className="text-sm text-muted-foreground flex-1 truncate">
                        {elapsedSec !== undefined ? `Thought for ${elapsedSec}s` : 'Thought it through'}
                    </span>
                ) : (
                    // text-shimmer-accent-60, not text-primary/60: --primary itself is a pale
                    // rose that reads as unreadably faint (and fails WCAG AA) on this theme's
                    // near-white background — --shimmer-accent is the same hue family, darkened,
                    // and only overridden in light theme. See globals.css.
                    <span className="shimmer-text text-sm flex-1 truncate text-shimmer-accent-60">Thinking…</span>
                )}
            </button>
            {expanded && (
                <div className="mt-1 ml-[4px] border-l border-foreground/20 pl-3 text-sm text-muted-foreground min-w-0 [&>*]:mb-2 [&>*:last-child]:mb-0">
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

// Tools that pause the turn on the user, not on the agent: while only these
// are loading, the agent is waiting for an answer, so the live line stops
// reading "Working for Ns" and its timer stops counting.
const AWAITING_USER_TOOLS = new Set(['ask_clarifying_questions', 'review_shots']);

export function isAwaitingUser(activeToolCalls: ToolCall[]): boolean {
    const loading = activeToolCalls.filter(t => t.isLoading);
    return loading.length > 0 && loading.every(t => AWAITING_USER_TOOLS.has(t.toolName));
}

function PulsingDots() {
    return (
        <span className="flex gap-[3px] items-center">
            <span className="h-[4px] w-[4px] rounded-full bg-[var(--shimmer-accent)] opacity-70 animate-bounce [animation-delay:-0.3s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-[var(--shimmer-accent)] opacity-70 animate-bounce [animation-delay:-0.15s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-[var(--shimmer-accent)] opacity-70 animate-bounce" />
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
    /** Live step list for a long job (orchestrator `step` events). */
    steps?: LiveStep[];
    reasoningText?: string;
    /** fileId -> presigned URL — see ToolCallCard's freshUrls prop. */
    freshUrls?: Record<string, string>;
}

// The kind of media the latest running step makes, for the Director's row label.
function liveMediaKind(steps: LiveStep[]): 'image' | 'video' | 'audio' | undefined {
    for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s.state !== 'running') continue;
        if (s.kind === 'image' || s.kind === 'cast') return 'image';
        if (s.kind === 'video') return 'video';
        if (s.kind === 'voice') return 'audio';
    }
    return undefined;
}

export function LiveTrace({
    isStreaming,
    activeToolCalls,
    completedToolCalls,
    steps = [],
    reasoningText = '',
    freshUrls,
}: LiveTraceProps) {
    const [messageIndex, setMessageIndex] = useState(0);
    const [startedAt, setStartedAt] = useState<number | null>(null);
    // Ticks the live "Working for Ns" counter once a second. This is separate
    // from the completedTrace concept (which lives on the Message once
    // streaming finishes) — purely a local display value for the in-progress
    // Phase 2a line, so it doesn't need to survive this component unmounting.
    const [liveElapsed, setLiveElapsed] = useState(0);
    const [blockOpen, setBlockOpen] = useState(true);
    // Seconds spent waiting on the user, excluded from "Working for Ns".
    const [pausedMs, setPausedMs] = useState(0);
    // An open approval card pauses the run as much as a question does.
    const awaitingApproval = useContext(AwaitingApprovalContext);
    const awaitingUser = isAwaitingUser(activeToolCalls) || awaitingApproval;

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
    const isImageGen = activeToolCalls.some(tc =>
        tc.toolName === 'generate_image' || tc.toolName === 'generate-image'
        || tc.toolName === 'edit_image' || tc.toolName === 'edit-image'
        || tc.toolName === 'generate_images' || tc.toolName === 'generate-images');
    // Live batchProgress is set by onBatchItemProgress in useChatStream.ts as
    // each item settles — on the batch tool's own call, or on the delegate
    // wrapper's call when Olmo delegates (only that id reaches the browser).
    // When present it overrides the rotating message below with a real count.
    const batchProgress = activeToolCalls.find(tc => tc.batchProgress)?.batchProgress;

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

    const IMAGE_MESSAGES = [
        "Generating image...",
        "Rendering details...",
        "Almost done...",
    ];

    const thinkingMessages = batchProgress ? [`Generating ${batchProgress.done} of ${batchProgress.total}...`]
        : isPRD ? PRD_MESSAGES
        : isRoadmap ? ROADMAP_MESSAGES
        : isTasks ? TASKS_MESSAGES
        : isImageGen ? IMAGE_MESSAGES
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
        if (awaitingUser) {
            const pauseStart = Date.now();
            return () => setPausedMs(prev => prev + (Date.now() - pauseStart));
        }
        const tick = () => setLiveElapsed(Math.max(0, Math.floor((Date.now() - startedAt - pausedMs) / 1000)));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [isStreaming, startedAt, awaitingUser, pausedMs]);

    // Tool calls (active + completed)
    const loadingTools = activeToolCalls.filter(t => t.isLoading);
    if (loadingTools.length > 0 || completedToolCalls.length > 0) {
        return (
            <div className="w-full min-w-0 animate-in fade-in duration-300">
                {/* One block: a header that folds, then thinking, steps and
                    results under a thin guide line. */}
                <button type="button" onClick={() => setBlockOpen(o => !o)} className="flex items-center gap-2 text-left mb-1">
                    <Chevron open={blockOpen} />
                    {awaitingUser ? (
                        <span className="text-sm text-muted-foreground">{awaitingApproval ? 'Waiting for your OK' : 'Waiting for your answer'}</span>
                    ) : (
                        <span className="shimmer-text text-sm text-shimmer-accent-80" key={loadingTools.length > 0 ? messageIndex : 'done'}>
                            {liveElapsed >= 2 ? `Working for ${liveElapsed}s` : 'Working…'}{loadingTools.length > 0 && steps.length === 0 ? ` · ${thinkingMessages[messageIndex % thinkingMessages.length]}` : ''}
                        </span>
                    )}
                </button>
                {blockOpen && (
                <div className="ml-[4px] border-l border-foreground/20 pl-3 min-w-0">
                <ReasoningRow text={reasoningText} defaultOpen={steps.length === 0} />
                {steps.length > 0 && <StepList steps={steps} />}
                {groupImageToolCalls(withoutRepeatedTraceFiles(completedToolCalls)).map((group, gi) => (
                    group.length > 1 ? (
                        <div key={gi} className="flex flex-wrap gap-2">
                            {group.map(tc => (
                                <ToolCallCard
                                    key={tc.id}
                                    toolName={tc.toolName}
                                    query={tc.query}
                                    status="done"
                                    results={tc.results}
                                    result={tc.result}
                                    freshUrls={freshUrls}
                                />
                            ))}
                        </div>
                    ) : (
                        <ToolCallCard
                            key={group[0].id}
                            toolName={group[0].toolName}
                            query={group[0].query}
                            status="done"
                            results={group[0].results}
                            result={group[0].result}
                            freshUrls={freshUrls}
                        />
                    )
                ))}
                {groupImageToolCalls(loadingTools).map((group, gi) => (
                    group.length > 1 ? (
                        <div key={gi} className="flex flex-wrap gap-2">
                            {group.map(tool => (
                                <ToolCallCard
                                    key={tool.id}
                                    toolName={tool.toolName}
                                    query={String(tool.arguments?.query ?? tool.arguments?.filename ?? tool.arguments?.subject ?? '')}
                                    prompt={String(tool.arguments?.prompt ?? '')}
                                    status="loading"
                                    generationStarted={tool.generationStarted}
                                    aspectRatio={tool.generationAspectRatio ?? (typeof tool.arguments?.aspectRatio === 'string' ? tool.arguments.aspectRatio : undefined)}
                                    batchProgress={tool.batchProgress}
                                    mediaCount={tool.generationCount}
                                    statusText={tool.statusText}
                                    statusDetails={tool.statusDetails}
                                    liveKind={liveMediaKind(steps)}
                                />
                            ))}
                        </div>
                    ) : (
                        <ToolCallCard
                            key={group[0].id}
                            toolName={group[0].toolName}
                            query={String(group[0].arguments?.query ?? group[0].arguments?.filename ?? group[0].arguments?.subject ?? '')}
                            prompt={String(group[0].arguments?.prompt ?? '')}
                            status="loading"
                            generationStarted={group[0].generationStarted}
                            aspectRatio={group[0].generationAspectRatio ?? (typeof group[0].arguments?.aspectRatio === 'string' ? group[0].arguments.aspectRatio : undefined)}
                            batchProgress={group[0].batchProgress}
                            mediaCount={group[0].generationCount}
                            statusText={group[0].statusText}
                            statusDetails={group[0].statusDetails}
                            liveKind={liveMediaKind(steps)}
                        />
                    )
                ))}
                </div>
                )}
            </div>
        );
    }

    // Plain thinking, no tool calls yet
    if (isStreaming) {
        return (
            <div className="w-full min-w-0 animate-in fade-in duration-300">
                <div className="flex items-center gap-2">
                    <PulsingDots />
                    <span className="shimmer-text text-sm text-shimmer-accent-80 font-mono animate-in fade-in duration-500" key={messageIndex}>
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
    /** Live step list for a long job (orchestrator `step` events). */
    steps?: LiveStep[];
    reasoningText?: string;
    agentAvatarUrl?: string | null;
    agentPersona?: PersonaSummary | null;
    /** The seeded default agent (Olmo) — see AgentOrb's isDefault prop. */
    agentIsDefault?: boolean;
    /** fileId -> presigned URL — see ToolCallCard's freshUrls prop. */
    freshUrls?: Record<string, string>;
}

export function ThinkingIndicator({
    isRetrying,
    isStreaming,
    activeToolCalls,
    completedToolCalls,
    steps = [],
    reasoningText = '',
    agentAvatarUrl,
    agentPersona,
    agentIsDefault,
    freshUrls,
}: ThinkingIndicatorProps) {
    const [stepIndex, setStepIndex] = useState(0);
    const awaitingApprovalCtx = useContext(AwaitingApprovalContext);

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
                <AgentOrb size={32} liveState="thinking" isLoading avatarUrl={agentAvatarUrl} persona={agentPersona} isDefault={agentIsDefault} />
                <div className="h-6 overflow-hidden">
                    <div
                        className="transition-transform duration-500 ease-in-out"
                        style={{ transform: `translateY(-${stepIndex * 1.5}rem)` }}
                    >
                        {WARMUP_STEPS.map((step) => (
                            <div key={step} className="flex items-center gap-2 h-6">
                                <PulsingDots />
                                <span className="shimmer-text text-sm text-shimmer-accent-80 font-mono">
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
    const awaitingUser = isAwaitingUser(activeToolCalls) || awaitingApprovalCtx;

    return (
        <div className="flex items-start gap-4">
            <AgentOrb size={32} liveState={hasToolActivity ? "running" : "thinking"} isLoading={hasToolActivity && !awaitingUser} avatarUrl={agentAvatarUrl} persona={agentPersona} isDefault={agentIsDefault} />
            <div className={hasToolActivity ? "flex-1 min-w-0 pt-1" : "flex-1 min-w-0 pt-1.5"}>
                <LiveTrace
                    isStreaming={isStreaming}
                    activeToolCalls={activeToolCalls}
                    completedToolCalls={completedToolCalls}
                    steps={steps}
                    reasoningText={reasoningText}
                    freshUrls={freshUrls}
                />
            </div>
        </div>
    );
}

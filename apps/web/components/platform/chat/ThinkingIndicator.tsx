"use client";

import { useEffect, useState } from "react";
import { AgentOrb } from "./AgentOrb";
import { cn } from "@/lib/utils";
import { ToolCall, CompletedToolCall } from "./types";
import { ToolCallCard } from "./ToolCallCard";

const WARMUP_STEPS = [
    "Starting your workspace...",
    "Loading agent runtime...",
    "Registering tools...",
    "Almost ready...",
];

const WARMUP_STEP_INTERVAL_MS = 8_000;

function PulsingDots() {
    return (
        <span className="flex gap-[3px] items-center">
            <span className="h-[4px] w-[4px] rounded-full bg-[#c4b5fd] animate-bounce [animation-delay:-0.3s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-[#c4b5fd] animate-bounce [animation-delay:-0.15s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-[#c4b5fd] animate-bounce" />
        </span>
    );
}

export interface ThinkingIndicatorProps {
    isRetrying: boolean;
    isStreaming: boolean;
    activeToolCalls: ToolCall[];
    completedToolCalls: CompletedToolCall[];
    hasContent: boolean;
}

export function ThinkingIndicator({
    isRetrying,
    isStreaming,
    activeToolCalls,
    completedToolCalls,
    hasContent,
}: ThinkingIndicatorProps) {
    const [stepIndex, setStepIndex] = useState(0);
    const [messageIndex, setMessageIndex] = useState(0);

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
    const isSaveTool = isPRD || isRoadmap || isTasks;

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

    useEffect(() => {
        if (!isStreaming) return;
        const id = setInterval(() => {
            setMessageIndex(prev => (prev + 1) % thinkingMessages.length);
        }, 2500);
        return () => clearInterval(id);
    }, [isStreaming, thinkingMessages.length]);

    if (hasContent && !isSaveTool) return null;

    // Phase 1 — container warmup
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
                                <span className="text-sm text-[#c4b5fd] font-mono">
                                    {step}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    // Phase 2b — tool calls (active + completed)
    const loadingTools = activeToolCalls.filter(t => t.isLoading);
    if (loadingTools.length > 0 || completedToolCalls.length > 0) {
        return (
            <div className="flex items-start gap-4 animate-in fade-in duration-300">
                <AgentOrb size={40} state="searching" isLoading />
                <div className="flex-1 pt-1">
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
            </div>
        );
    }

    // Phase 2a — plain thinking
    if (isStreaming) {
        return (
            <div className="flex items-start gap-4 animate-in fade-in duration-300">
                <AgentOrb size={40} state="thinking" />
                <div className="flex items-center gap-2 pt-1.5">
                    <PulsingDots />
                    <span className="text-sm text-[#c4b5fd] font-mono animate-in fade-in duration-500" key={messageIndex}>
                        {thinkingMessages[messageIndex]}
                    </span>
                </div>
            </div>
        );
    }

    return null;
}

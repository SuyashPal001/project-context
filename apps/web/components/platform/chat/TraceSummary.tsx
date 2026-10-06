'use client';

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CompletedToolCall } from "./types";
import { ToolCallCard, groupImageToolCalls, extractResultFiles, withoutRepeatedTraceFiles } from "./ToolCallCard";
import { ReasoningRow } from "./ThinkingIndicator";

export interface TraceSummaryProps {
    elapsedSec: number;
    toolCalls: CompletedToolCall[];
    reasoningText?: string;
    reasoningElapsedSec?: number;
    defaultCollapsed?: boolean;
    /** fileId -> presigned URL, forwarded to each ToolCallCard so a completed
     *  generation/show_files call renders its image inline — see ToolCallCard's
     *  freshUrls prop. */
    freshUrls?: Record<string, string>;
    /** The turn ended with a finished video: the pictures and clips made on
     *  the way fold behind one row instead of filling the reply. */
    foldMedia?: boolean;
}

// Collapsed "Worked for Ns" row shown after a turn finishes. The outer
// <button> wraps ONLY the chevron + label — never the ToolCallCard list.
// ToolCallCard is itself a clickable div (it toggles its own result
// expansion), so nesting it inside the button caused invalid HTML and made
// clicking a tool card also fire the outer collapse toggle, leaving the
// inner disclosure unusable. The tool call list is rendered as a sibling
// <div>, shown/hidden off the same `collapsed` state instead.
export function TraceSummary({ elapsedSec, toolCalls, reasoningText, reasoningElapsedSec, defaultCollapsed = true, freshUrls, foldMedia = false }: TraceSummaryProps) {
    const [collapsed, setCollapsed] = useState(defaultCollapsed);
    const [mediaOpen, setMediaOpen] = useState(false);

    // A tool call that produced media (an image/video/song, or a show_files
    // result) stays visible even while the rest of the trace is collapsed —
    // collapsing "N steps" behind one line must not also hide the images the
    // user just watched generate. Everything else (search rows, delegate
    // wrappers with no result media, plan/PRD tools, ...) is what collapses.
    const mediaCalls = withoutRepeatedTraceFiles(toolCalls).filter(tc => extractResultFiles(tc.toolName, tc.result).length > 0);
    const stepCalls = toolCalls.filter(tc => extractResultFiles(tc.toolName, tc.result).length === 0);
    const mediaFileCount = mediaCalls.reduce((n, tc) => n + extractResultFiles(tc.toolName, tc.result).length, 0);

    return (
        <div className="flex flex-col w-full min-w-0">
            {mediaCalls.length > 0 && foldMedia && (
                <button
                    type="button"
                    onClick={() => setMediaOpen(o => !o)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 self-start"
                    data-testid="trace-media-fold"
                >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={cn("shrink-0 transition-transform", mediaOpen ? "rotate-90" : "")}>
                        <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>{mediaFileCount} picture{mediaFileCount === 1 ? '' : 's'} and clip{mediaFileCount === 1 ? '' : 's'} made along the way</span>
                </button>
            )}
            {mediaCalls.length > 0 && (!foldMedia || mediaOpen) && (
                <div className="flex flex-col gap-1 normal-case">
                    {groupImageToolCalls(mediaCalls).map((group, gi) => (
                        group.length > 1 ? (
                            <div key={gi} className="flex flex-wrap gap-2">
                                {group.map(tc => (
                                    <ToolCallCard key={tc.id} toolName={tc.toolName} query={tc.query} status="done" results={tc.results} result={tc.result} freshUrls={freshUrls} />
                                ))}
                            </div>
                        ) : (
                            <ToolCallCard key={group[0].id} toolName={group[0].toolName} query={group[0].query} status="done" results={group[0].results} result={group[0].result} freshUrls={freshUrls} />
                        )
                    ))}
                </div>
            )}
            <button
                type="button"
                onClick={() => setCollapsed(c => !c)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 self-start"
            >
                <svg
                    width="10" height="10" viewBox="0 0 10 10" fill="none"
                    className={cn("shrink-0 transition-transform", collapsed ? "" : "rotate-90")}
                >
                    <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Worked for {elapsedSec}s{toolCalls.length > 0 ? ` · ${toolCalls.length} step${toolCalls.length === 1 ? '' : 's'}` : ''}</span>
            </button>
            {!collapsed && (stepCalls.length > 0 || reasoningText) && (
                <div className="ml-4 flex flex-col gap-1 normal-case">
                    {groupImageToolCalls(stepCalls).map((group, gi) => (
                        group.length > 1 ? (
                            <div key={gi} className="flex flex-wrap gap-2">
                                {group.map(tc => (
                                    <ToolCallCard key={tc.id} toolName={tc.toolName} query={tc.query} status="done" results={tc.results} result={tc.result} freshUrls={freshUrls} />
                                ))}
                            </div>
                        ) : (
                            <ToolCallCard key={group[0].id} toolName={group[0].toolName} query={group[0].query} status="done" results={group[0].results} result={group[0].result} freshUrls={freshUrls} />
                        )
                    ))}
                    {reasoningText && <ReasoningRow text={reasoningText} completed elapsedSec={reasoningElapsedSec} />}
                </div>
            )}
        </div>
    );
}

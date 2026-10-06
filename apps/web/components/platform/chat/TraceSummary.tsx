'use client';

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CompletedToolCall, LiveStep } from "./types";
import { StepList, stepTileFiles, withoutStepOwned } from "./StepList";
import { Branch, FileTile } from "./Branch";
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
    /** The step list as the turn ended, shown when the row is opened. */
    steps?: LiveStep[];
    /** What this part of the turn made, named in the header ("1 picture, 2 clips"). */
    made?: { pictures: number; clips: number };
}

const SEARCH_TOOLS = new Set(['web_search', 'browser', 'internet_search']);

const madeLabel = (made?: { pictures: number; clips: number }) => [
    made?.pictures ? `${made.pictures} picture${made.pictures === 1 ? '' : 's'}` : '',
    made?.clips ? `${made.clips} clip${made.clips === 1 ? '' : 's'}` : '',
].filter(Boolean).join(', ');

// Collapsed "Worked for Ns" row shown after a turn finishes. The outer
// <button> wraps ONLY the chevron + label — never the ToolCallCard list.
// ToolCallCard is itself a clickable div (it toggles its own result
// expansion), so nesting it inside the button caused invalid HTML and made
// clicking a tool card also fire the outer collapse toggle, leaving the
// inner disclosure unusable. The tool call list is rendered as a sibling
// <div>, shown/hidden off the same `collapsed` state instead.
export function TraceSummary({ elapsedSec, toolCalls: allToolCalls, reasoningText, reasoningElapsedSec, defaultCollapsed = true, freshUrls, foldMedia = false, steps, made }: TraceSummaryProps) {
    // Pictures and clips hang under their step row; the rows repeating them stay out.
    const toolCalls = withoutStepOwned(allToolCalls, steps);
    const [collapsed, setCollapsed] = useState(defaultCollapsed);
    const [mediaOpen, setMediaOpen] = useState(false);

    // A tool call that produced media (an image/video/song, or a show_files
    // result) stays visible even while the rest of the trace is collapsed —
    // collapsing "N steps" behind one line must not also hide the images the
    // user just watched generate. Everything else (search rows, delegate
    // wrappers with no result media, plan/PRD tools, ...) is what collapses.
    const mediaCalls = withoutRepeatedTraceFiles(toolCalls).filter(tc => extractResultFiles(tc.toolName, tc.result).length > 0);
    const stepCalls = toolCalls.filter(tc => extractResultFiles(tc.toolName, tc.result).length === 0);
    const stepCount = steps && steps.length > 0 ? new Set(steps.map(s => s.key)).size : toolCalls.length;
    const mediaFileCount = mediaCalls.reduce((n, tc) => n + extractResultFiles(tc.toolName, tc.result).length, 0);
    // Each part of a turn is headed by what it did (after beautiful-ui's
    // thinking states, 2026-10-07): a part that only thought says how long it
    // thought; one that only searched says how many sources it read; a part
    // that made things keeps "Worked for" with its steps.
    const hasSteps = !!steps?.length;
    const onlyThought = !!reasoningText && !hasSteps && toolCalls.length === 0;
    const onlySearched = !hasSteps && mediaCalls.length === 0 && stepCalls.length > 0 && stepCalls.every(tc => SEARCH_TOOLS.has(tc.toolName));
    const sourceCount = onlySearched ? stepCalls.reduce((n, tc) => n + (tc.results?.length ?? 0), 0) : 0;
    const header = onlyThought
        ? `Thought for ${reasoningElapsedSec ?? Math.max(1, elapsedSec)}s`
        : onlySearched
            ? `Searched the web${sourceCount ? ` · ${sourceCount} source${sourceCount === 1 ? '' : 's'}` : ''}`
            : `Worked for ${elapsedSec}s${stepCount > 0 ? ` · ${stepCount} step${stepCount === 1 ? '' : 's'}` : ''}${madeLabel(made) ? ` · ${madeLabel(made)}` : ''}`;

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
                            <div key={gi} className="flex flex-col gap-2">
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
                <span>{header}</span>
            </button>
            {/* Folded, the part still shows what it made: its pictures and clips
                hang under the header; opened, each sits under its own step. */}
            {collapsed && steps && stepTileFiles(steps).length > 0 && (
                <Branch>
                    <div className="flex flex-wrap gap-1.5" data-testid="part-files">
                        {stepTileFiles(steps).map(f => <FileTile key={f.fileId} file={f} />)}
                    </div>
                </Branch>
            )}
            {!collapsed && ((steps && steps.length > 0) || stepCalls.length > 0 || reasoningText) && (
                <div className="ml-[4px] border-l border-foreground/20 pl-3 flex flex-col gap-1 normal-case">
                    {reasoningText && (onlyThought
                        ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{reasoningText}</p>
                        : <ReasoningRow text={reasoningText} completed elapsedSec={reasoningElapsedSec} />)}
                    {steps && steps.length > 0 && <StepList steps={steps} live={false} />}
                    {groupImageToolCalls(stepCalls).map((group, gi) => (
                        group.length > 1 ? (
                            <div key={gi} className="flex flex-col gap-2">
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
        </div>
    );
}

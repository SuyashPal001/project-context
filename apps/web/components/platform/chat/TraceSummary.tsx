'use client';

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CompletedToolCall } from "./types";
import { ToolCallCard } from "./ToolCallCard";

export interface TraceSummaryProps {
    elapsedSec: number;
    toolCalls: CompletedToolCall[];
    defaultCollapsed?: boolean;
}

// Collapsed "Worked for Ns" row shown after a turn finishes. The outer
// <button> wraps ONLY the chevron + label — never the ToolCallCard list.
// ToolCallCard is itself a clickable div (it toggles its own result
// expansion), so nesting it inside the button caused invalid HTML and made
// clicking a tool card also fire the outer collapse toggle, leaving the
// inner disclosure unusable. The tool call list is rendered as a sibling
// <div>, shown/hidden off the same `collapsed` state instead.
export function TraceSummary({ elapsedSec, toolCalls, defaultCollapsed = true }: TraceSummaryProps) {
    const [collapsed, setCollapsed] = useState(defaultCollapsed);

    return (
        <div className="flex flex-col">
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
                <span>Worked for {elapsedSec}s</span>
            </button>
            {!collapsed && toolCalls.length > 0 && (
                <div className="ml-4 flex flex-col gap-1 normal-case">
                    {toolCalls.map(tc => (
                        <ToolCallCard key={tc.id} toolName={tc.toolName} query={tc.query} status="done" results={tc.results} />
                    ))}
                </div>
            )}
        </div>
    );
}

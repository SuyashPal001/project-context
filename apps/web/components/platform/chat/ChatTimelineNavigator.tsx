'use client';

import { useRef, useState } from "react";
import { Message } from "./types";

interface ChatTimelineNavigatorProps {
    messages: Message[];
}

const IDLE_TICK_COUNT = 5;
const HOVER_CLOSE_DELAY_MS = 150;

// A slim vertical navigator anchored to the chat panel's right edge,
// vertically centered. Idle: a few decorative tick marks hinting a timeline
// exists. Hover: expands into a floating, right-aligned list of every user
// message in chronological order; clicking one scrolls the thread to it.
export function ChatTimelineNavigator({ messages }: ChatTimelineNavigatorProps) {
    const [expanded, setExpanded] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const userMessages = messages.filter(m => m.role === 'user');

    if (userMessages.length === 0) return null;

    const jumpTo = (id: string) => {
        document.getElementById(`message-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    const cancelClose = () => {
        if (closeTimer.current) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
    };

    const scheduleClose = () => {
        cancelClose();
        closeTimer.current = setTimeout(() => setExpanded(false), HOVER_CLOSE_DELAY_MS);
    };

    return (
        <div
            className="absolute right-3 top-1/2 -translate-y-1/2 z-30"
            onMouseEnter={() => { cancelClose(); setExpanded(true); }}
            onMouseLeave={scheduleClose}
        >
            {expanded && (
                <div className="absolute right-full top-1/2 -translate-y-1/2 mr-2 w-64 max-h-[60vh] overflow-y-auto custom-scrollbar space-y-1 rounded-lg border border-border/40 bg-popover/95 backdrop-blur p-2 shadow-lg">
                    {userMessages.map(m => (
                        <button
                            key={m.id}
                            type="button"
                            onClick={() => jumpTo(m.id)}
                            className="w-full text-right px-3 py-1.5 rounded-md hover:bg-muted/70 text-xs text-muted-foreground hover:text-foreground truncate transition-colors"
                        >
                            {m.content}
                        </button>
                    ))}
                </div>
            )}

            <div className="flex flex-col items-end gap-1.5 py-1">
                {Array.from({ length: IDLE_TICK_COUNT }).map((_, i) => (
                    <span key={i} className="h-[1.5px] w-4 rounded-full bg-muted-foreground/30" />
                ))}
            </div>
        </div>
    );
}

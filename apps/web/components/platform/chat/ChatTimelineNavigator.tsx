'use client';

import { useRef, useState } from "react";
import { Message } from "./types";

interface ChatTimelineNavigatorProps {
    messages: Message[];
}

const IDLE_TICK_COUNT = 5;
const HOVER_CLOSE_DELAY_MS = 150;
const TICK_GAP_PX = 6;
// Opacity falls off with each row of distance from the hovered row: the
// hovered row itself is fully opaque, its neighbors dim progressively,
// clamped to a readable floor so far-away rows are still legible.
const FADE_PER_ROW = 0.22;
const MIN_ROW_OPACITY = 0.28;

export function ChatTimelineNavigator({ messages }: ChatTimelineNavigatorProps) {
    const [expanded, setExpanded] = useState(false);
    const [hoveredRow, setHoveredRow] = useState<number | null>(null);
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
        closeTimer.current = setTimeout(() => { setExpanded(false); setHoveredRow(null); }, HOVER_CLOSE_DELAY_MS);
    };

    return (
        <div
            className="absolute right-3 top-1/2 -translate-y-1/2 z-30"
            onMouseEnter={() => { cancelClose(); setExpanded(true); }}
            onMouseLeave={scheduleClose}
        >
            <div
                className={`absolute right-full top-1/2 -translate-y-1/2 mr-2 w-64 max-h-[60vh] overflow-y-auto custom-scrollbar transition-[opacity,transform] duration-200 ease-out ${expanded ? 'opacity-100 translate-x-0 pointer-events-auto' : 'opacity-0 translate-x-1.5 pointer-events-none'}`}
                onMouseLeave={() => setHoveredRow(null)}
            >
                {userMessages.map((m, i) => {
                    const distance = hoveredRow === null ? 0 : Math.abs(i - hoveredRow);
                    const opacity = hoveredRow === null ? 1 : Math.max(MIN_ROW_OPACITY, 1 - distance * FADE_PER_ROW);
                    return (
                        <button
                            key={m.id}
                            type="button"
                            onClick={() => jumpTo(m.id)}
                            onMouseEnter={() => setHoveredRow(i)}
                            style={{ opacity }}
                            className="block w-full text-right px-1 py-1 text-xs text-foreground truncate transition-opacity duration-150"
                        >
                            {m.content}
                        </button>
                    );
                })}
            </div>

            <div className="flex flex-col items-end py-1" style={{ gap: TICK_GAP_PX }}>
                {Array.from({ length: IDLE_TICK_COUNT }).map((_, i) => (
                    <span
                        key={i}
                        className={`h-[2px] w-4 rounded-sm transition-colors duration-200 ${expanded ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
                    />
                ))}
            </div>
        </div>
    );
}

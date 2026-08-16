'use client';

import { useState } from "react";
import { Menu } from "lucide-react";
import { Message } from "./types";

interface ChatTimelineProps {
    messages: Message[];
}

// A floating stack of this conversation's own past user turns, sitting just
// above the input bar — a quick way to glance back at what you already asked
// without scrolling the whole thread. Collapsed by default: a peeked stack of
// the last few, most recent frontmost; the toggle expands it into a full
// scrollable list. Clicking any entry scrolls the thread to that message.
export function ChatTimeline({ messages }: ChatTimelineProps) {
    const [expanded, setExpanded] = useState(false);
    const userMessages = messages.filter(m => m.role === 'user');

    if (userMessages.length === 0) return null;

    const jumpTo = (id: string) => {
        document.getElementById(`message-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    const peek = userMessages.slice(-3);

    return (
        <div className="relative max-w-3xl mx-auto w-full px-4 pt-3">
            <button
                type="button"
                onClick={() => setExpanded(e => !e)}
                className="absolute right-4 top-0.5 z-20 h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors"
                title={expanded ? "Collapse timeline" : "Expand timeline"}
            >
                <Menu className="h-3.5 w-3.5" />
            </button>

            {expanded ? (
                <div className="max-h-40 overflow-y-auto custom-scrollbar space-y-1 pr-8">
                    {userMessages.map(m => (
                        <button
                            key={m.id}
                            type="button"
                            onClick={() => { jumpTo(m.id); setExpanded(false); }}
                            className="w-full text-left px-3.5 py-1.5 rounded-full bg-muted/40 hover:bg-muted/70 text-xs text-muted-foreground hover:text-foreground truncate transition-colors"
                        >
                            {m.content}
                        </button>
                    ))}
                </div>
            ) : (
                <div className="relative h-8 pr-8">
                    {peek.map((m, i) => {
                        // i counts oldest-to-newest within the peek slice; depthFromTop
                        // inverts that so the most recent message sits frontmost (depth 0:
                        // full opacity, no offset, highest z-index) and older ones stack
                        // behind it, faded and nudged upward.
                        const depthFromTop = peek.length - 1 - i;
                        return (
                            <button
                                key={m.id}
                                type="button"
                                onClick={() => jumpTo(m.id)}
                                style={{
                                    zIndex: peek.length - depthFromTop,
                                    transform: `translateY(${-depthFromTop * 6}px) scale(${1 - depthFromTop * 0.04})`,
                                    opacity: 1 - depthFromTop * 0.3,
                                }}
                                className="absolute inset-x-0 top-0 truncate text-left px-4 py-2 rounded-2xl bg-muted/60 border border-border/40 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {m.content}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

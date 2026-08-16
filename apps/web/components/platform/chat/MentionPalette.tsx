'use client';

import { AtSign } from "lucide-react";

interface MentionPaletteProps {
    query: string;
    onSelect: (label: string) => void;
    onClose: () => void;
}

// Elements available to @-mention. Static for now — document/task mentions are a
// separate data-wiring effort once this UI shell is confirmed.
const ELEMENTS: string[] = [];

export function MentionPalette({ query, onSelect, onClose }: MentionPaletteProps) {
    const filtered = query
        ? ELEMENTS.filter(e => e.toLowerCase().includes(query.toLowerCase()))
        : ELEMENTS;

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover shadow-lg p-2">
            {filtered.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground flex items-center gap-2">
                    <AtSign className="h-3.5 w-3.5" />
                    No mentions match &quot;{query}&quot;
                </div>
            ) : (
                filtered.map(label => (
                    <button
                        key={label}
                        type="button"
                        onClick={() => { onSelect(label); onClose(); }}
                        className="w-full px-2 py-2 rounded-xl text-left text-sm hover:bg-muted/60 transition-colors"
                    >
                        {label}
                    </button>
                ))
            )}
        </div>
    );
}

'use client';

import { FileText } from 'lucide-react';

interface Citation {
    name: string;
    score: number;
}

interface CitationStripProps {
    citations: Citation[];
}

export function CitationStrip({ citations }: CitationStripProps) {
    if (citations.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-1.5 mt-2">
            {citations.map((c, i) => (
                <div
                    key={i}
                    title={`Relevance: ${(c.score * 100).toFixed(0)}%`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border/60 bg-muted/50 text-[11px] text-muted-foreground hover:bg-muted transition-colors cursor-default max-w-[200px]"
                >
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                    <span className="truncate">{c.name}</span>
                </div>
            ))}
        </div>
    );
}

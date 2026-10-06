'use client';

interface FollowUpChipsProps {
    suggestions: string[];
    onSelect: (text: string) => void;
}

// Follow-ups as a plain list under the reply, each row sends itself (after
// beautiful-ui's streaming text, 2026-10-07). They arrive a few seconds after
// the reply (chatStream's follow_ups event), so they fade up one by one.
export function FollowUpChips({ suggestions, onSelect }: FollowUpChipsProps) {
    if (suggestions.length === 0) return null;

    return (
        <div className="mt-3 flex flex-col">
            <span className="mb-1 text-[12.5px] text-muted-foreground">Follow-ups</span>
            {suggestions.map((s, i) => (
                <button
                    key={i}
                    type="button"
                    onClick={() => onSelect(s)}
                    style={{ animationDelay: `${i * 90}ms`, animationFillMode: 'both' }}
                    className="group/fu flex items-start gap-2.5 border-b border-border/50 py-2 text-left text-sm leading-snug text-foreground/85 transition-colors last:border-b-0 hover:text-foreground animate-in fade-in slide-in-from-bottom-1 duration-300"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-muted-foreground/60 group-hover/fu:text-foreground" aria-hidden>
                        <path d="M9 10l-5 5 5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />
                    </svg>
                    <span>{s}</span>
                </button>
            ))}
        </div>
    );
}

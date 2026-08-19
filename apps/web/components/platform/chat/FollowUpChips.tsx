'use client';

interface FollowUpChipsProps {
    suggestions: string[];
    onSelect: (text: string) => void;
}

export function FollowUpChips({ suggestions, onSelect }: FollowUpChipsProps) {
    if (suggestions.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2 mt-3">
            {suggestions.map((s, i) => (
                <button
                    key={i}
                    type="button"
                    onClick={() => onSelect(s)}
                    className="text-[12px] px-3 py-1.5 rounded-full border border-border/70 bg-background hover:bg-muted text-foreground/80 hover:text-foreground transition-colors text-left leading-snug"
                >
                    {s}
                </button>
            ))}
        </div>
    );
}

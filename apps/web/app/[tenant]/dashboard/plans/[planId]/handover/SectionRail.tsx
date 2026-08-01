'use client';

import type { Item, Section } from './_types';

export function SectionRail({
    sections,
    items,
    selectedId,
    onSelect,
}: {
    sections: Section[];
    items: Item[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}) {
    return (
        <div className="space-y-3">
            {sections.map((section) => {
                const count = items.filter((item) => item.sectionId === section.id).length;
                const selected = section.id === selectedId;
                return (
                    <button
                        key={section.id}
                        type="button"
                        onClick={() => onSelect(section.id)}
                        className={`w-full rounded-xl border p-4 text-left transition ${
                            selected ? 'border-foreground/40 bg-card' : 'border-border bg-muted/20 hover:bg-muted/40'
                        }`}
                    >
                        <div className="font-medium">{section.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                            {count} {count === 1 ? 'record' : 'records'}
                            {section.isVisible ? '' : ' · hidden'}
                        </div>
                        <div className="mt-3 h-1 w-full rounded-full bg-border">
                            <div
                                className="h-1 rounded-full bg-amber-500/70"
                                style={{ width: count === 0 ? '0%' : `${Math.min(100, count * 20)}%` }}
                            />
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

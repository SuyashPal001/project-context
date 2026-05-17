"use client";

import { Button } from "@/components/ui/button";

export function ChoicePill({
    label,
    selected,
    onSelect,
}: {
    label: string;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <Button
            type="button"
            variant={selected ? "default" : "outline"}
            className="rounded-full px-5 py-2 h-auto text-sm font-medium transition-colors"
            onClick={onSelect}
        >
            {label}
        </Button>
    );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
    return (
        <label className="block text-sm font-medium text-muted-foreground mb-1.5">
            {children}
        </label>
    );
}

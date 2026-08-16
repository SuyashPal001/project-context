'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AtSign, FileText, ListChecks } from "lucide-react";
import type { PaletteHandle } from "./SlashPalette";

interface MentionPaletteProps {
    query: string;
    onSelect: (label: string) => void;
    onClose: () => void;
}

interface DocumentsResponse {
    documents: { id: string; name: string; status: string }[];
}

interface TasksResponse {
    data: { id: string; title: string }[];
}

interface MentionItem {
    key: string;
    label: string;
    type: 'document' | 'task';
}

export const MentionPalette = forwardRef<PaletteHandle, MentionPaletteProps>(function MentionPalette(
    { query, onSelect, onClose },
    ref,
) {
    const { data: documentsData, isLoading: documentsLoading } = useQuery<DocumentsResponse>({
        queryKey: ["documents"],
        queryFn: () => api.get<DocumentsResponse>("/api/v1/documents"),
    });

    const { data: tasksData, isLoading: tasksLoading } = useQuery<TasksResponse>({
        queryKey: ["tasks"],
        queryFn: () => api.get<TasksResponse>("/api/v1/tasks"),
    });

    const elements = useMemo<MentionItem[]>(() => {
        const documents = (documentsData?.documents ?? [])
            .filter(d => d.status === 'ready')
            .map(d => ({ key: `document:${d.id}`, label: d.name, type: 'document' as const }));
        const tasks = (tasksData?.data ?? [])
            .map(t => ({ key: `task:${t.id}`, label: t.title, type: 'task' as const }));
        return [...documents, ...tasks];
    }, [documentsData, tasksData]);

    const isLoading = documentsLoading || tasksLoading;

    const filtered = query
        ? elements.filter(e => e.label.toLowerCase().includes(query.toLowerCase()))
        : elements;

    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => { setActiveIndex(0); }, [query]);

    useImperativeHandle(ref, () => ({
        moveActive: (delta: number) => {
            if (filtered.length === 0) return;
            setActiveIndex(i => (i + delta + filtered.length) % filtered.length);
        },
        selectActive: () => {
            const item = filtered[activeIndex];
            if (!item) return false;
            onSelect(item.label);
            onClose();
            return true;
        },
    }), [filtered, activeIndex, onSelect, onClose]);

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover shadow-lg p-2 max-h-64 overflow-y-auto custom-scrollbar">
            {isLoading ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground flex items-center gap-2">
                    <AtSign className="h-3.5 w-3.5" />
                    No mentions match &quot;{query}&quot;
                </div>
            ) : (
                filtered.map((item, i) => (
                    <button
                        key={item.key}
                        type="button"
                        onClick={() => { onSelect(item.label); onClose(); }}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={`w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left text-sm transition-colors ${i === activeIndex ? 'bg-muted/60' : 'hover:bg-muted/60'}`}
                    >
                        {item.type === 'document' ? (
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                            <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{item.label}</span>
                    </button>
                ))
            )}
        </div>
    );
});

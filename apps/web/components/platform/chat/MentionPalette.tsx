'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Search } from "lucide-react";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { Agent, AgentsResponse } from "../agents/types";
import type { PaletteHandle } from "./SlashPalette";

interface MentionPaletteProps {
    query: string;
    onSelect: (label: string) => void;
    onClose: () => void;
}

// Typing "@" opens this to mention/tag a specific agent. Unlike SlashPalette
// (which stays anchored to the textarea and filters off what's typed there),
// this owns its own real search input — autofocused on open — so it behaves
// like the reference's standalone "Search expert or team" field rather than
// mirroring keystrokes typed elsewhere. Arrow/Enter/Escape are therefore
// handled locally on that input, not via the imperative handle the "/"
// trigger relies on; the handle is still exposed for interface parity with
// SlashPalette but mouse hover/click is the primary path once this owns focus.
export const MentionPalette = forwardRef<PaletteHandle, MentionPaletteProps>(function MentionPalette(
    { query: initialQuery, onSelect, onClose },
    ref,
) {
    const [searchValue, setSearchValue] = useState(initialQuery);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        // Seed once from whatever was typed after "@" before the palette mounted;
        // further edits happen in this input, not by re-syncing from the prop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const { data, isLoading } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });

    const activeAgents = (data?.data ?? []).filter((a: Agent) => a.status === 'active');
    const filtered = searchValue
        ? activeAgents.filter((a: Agent) => a.name.toLowerCase().includes(searchValue.toLowerCase()))
        : activeAgents;

    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => { setActiveIndex(0); }, [searchValue]);

    const moveActive = (delta: number) => {
        if (filtered.length === 0) return;
        setActiveIndex(i => (i + delta + filtered.length) % filtered.length);
    };

    const selectActive = () => {
        const agent = filtered[activeIndex];
        if (!agent) return false;
        onSelect(agent.name);
        onClose();
        return true;
    };

    useImperativeHandle(ref, () => ({ moveActive, selectActive }), [filtered, activeIndex, onSelect]);

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover shadow-elevated p-2 max-h-80 overflow-y-auto custom-scrollbar">
            <div className="flex items-center gap-2 px-3 h-10 mb-1 rounded-xl bg-muted/50 focus-within:ring-1 focus-within:ring-primary/30">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                    ref={inputRef}
                    type="text"
                    value={searchValue}
                    onChange={e => setSearchValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); return; }
                        if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); return; }
                        if (e.key === "Enter") { e.preventDefault(); if (!selectActive()) onClose(); return; }
                        if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
                    }}
                    placeholder="Search expert or team"
                    className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
                />
            </div>
            {isLoading ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                    No experts match &quot;{searchValue}&quot;
                </div>
            ) : (
                filtered.map((agent: Agent, i: number) => (
                    <button
                        key={agent.id}
                        type="button"
                        onClick={() => { onSelect(agent.name); onClose(); }}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left transition-colors ${i === activeIndex ? 'bg-muted/60' : 'hover:bg-muted/60'}`}
                    >
                        <PersonaAvatar persona={agent.persona} size={36} className="rounded-full" />
                        <span className="text-sm truncate">{agent.name}</span>
                    </button>
                ))
            )}
        </div>
    );
});

'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Search } from "lucide-react";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { Agent, AgentsResponse } from "../agents/types";
import { getAgentTypeIcon } from "../agents/agentTypeIcon";

interface SlashPaletteProps {
    query: string;
    onSelect: (agent: Agent) => void;
    onClose: () => void;
}

export interface PaletteHandle {
    moveActive: (delta: number) => void;
    selectActive: () => boolean;
}

export const SlashPalette = forwardRef<PaletteHandle, SlashPaletteProps>(function SlashPalette(
    { query, onSelect, onClose },
    ref,
) {
    const { data, isLoading } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });

    const activeAgents = (data?.data ?? []).filter(a => a.status === 'active');
    const filtered = query
        ? activeAgents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()))
        : activeAgents;

    const [activeIndex, setActiveIndex] = useState(0);

    // Query changes reshuffle `filtered`, so a stale index would highlight the
    // wrong row (or point past the end) as the user keeps typing.
    useEffect(() => { setActiveIndex(0); }, [query]);

    useImperativeHandle(ref, () => ({
        moveActive: (delta: number) => {
            if (filtered.length === 0) return;
            setActiveIndex(i => (i + delta + filtered.length) % filtered.length);
        },
        selectActive: () => {
            const agent = filtered[activeIndex];
            if (!agent) return false;
            onSelect(agent);
            onClose();
            return true;
        },
    }), [filtered, activeIndex, onSelect, onClose]);

    return (
        <div className="absolute bottom-full left-0 right-0 mb-1.5 rounded-2xl border border-border bg-popover shadow-elevated p-2 max-h-72 overflow-y-auto custom-scrollbar">
            <div className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Skills and AI employees
            </div>
            <div className="flex items-center gap-2 px-2.5 py-2 mb-1 rounded-xl bg-muted/50 text-muted-foreground">
                <Search className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">
                    {query ? query : "Search skills, AI employees"}
                </span>
            </div>
            {isLoading ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                    No skills match &quot;{query}&quot;
                </div>
            ) : (
                filtered.map((agent, i) => (
                    <button
                        key={agent.id}
                        type="button"
                        onClick={() => { onSelect(agent); onClose(); }}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left transition-colors ${i === activeIndex ? 'bg-muted/60' : 'hover:bg-muted/60'}`}
                    >
                        <PersonaAvatar persona={agent.persona} avatarUrl={agent.avatarUrl} size={32} icon={getAgentTypeIcon(agent.type)} />
                        <div className="flex flex-col overflow-hidden">
                            <span className="text-sm font-medium truncate">{agent.name}</span>
                            <span className="text-xs text-muted-foreground truncate">
                                {agent.description ?? `${agent.type} agent`}
                            </span>
                        </div>
                    </button>
                ))
            )}
        </div>
    );
});

'use client';

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Bot } from "lucide-react";
import { Agent, AgentsResponse } from "../agents/types";

interface SlashPaletteProps {
    query: string;
    onSelect: (agent: Agent) => void;
    onClose: () => void;
}

export function SlashPalette({ query, onSelect, onClose }: SlashPaletteProps) {
    const { data, isLoading } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });

    const activeAgents = (data?.data ?? []).filter(a => a.status === 'active');
    const filtered = query
        ? activeAgents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()))
        : activeAgents;

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border bg-popover shadow-lg p-2 max-h-64 overflow-y-auto custom-scrollbar">
            <div className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Skills and AI employees
            </div>
            {isLoading ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                    No skills match &quot;{query}&quot;
                </div>
            ) : (
                filtered.map(agent => (
                    <button
                        key={agent.id}
                        type="button"
                        onClick={() => { onSelect(agent); onClose(); }}
                        className="w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left hover:bg-muted/60 transition-colors"
                    >
                        <div className="h-8 w-8 shrink-0 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                            <Bot className="h-4 w-4" />
                        </div>
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
}

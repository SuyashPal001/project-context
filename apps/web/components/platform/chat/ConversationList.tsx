"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useParams } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Search, MoreVertical, Trash2, Archive, LockKeyhole, ChevronRight } from "lucide-react";
import { Conversation, ConversationsResponse } from "./types";
import { Agent, AgentsResponse } from "../agents/types";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { getAgentTypeIcon } from "../agents/agentTypeIcon";
import type { PersonaAnimationState } from "@/components/platform/personas/usePersonaAnimationState";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ConversationListProps {
    selectedId?: string;
    onSelect: (conversation: Conversation) => void;
    onNewChat: (agentId?: string) => void;
    activeAgentId?: string;
    activeState?: PersonaAnimationState;
}

// ─── ConversationRow ──────────────────────────────────────────────────────────

function ConversationRow({ conversation, isSelected, onSelect, onArchive, onDelete }: {
    conversation: Conversation;
    isSelected: boolean;
    onSelect: () => void;
    onArchive: () => void;
    onDelete: () => void;
}) {
    return (
        <div className="relative group">
            <button
                onClick={onSelect}
                className={cn(
                    "w-full flex items-center h-9 px-2.5 rounded-md transition-colors text-left",
                    isSelected
                        ? "bg-accent/80 text-foreground font-semibold"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground font-medium"
                )}
            >
                <span className="truncate text-[13px] w-[calc(100%-1.25rem)]">
                    {conversation.title || `Chat with ${conversation.agent?.name || 'Agent'}`}
                </span>
            </button>
            <div className={cn(
                "absolute right-1 top-1/2 -translate-y-1/2",
                isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon"
                            className="h-7 w-7 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted shadow-none data-[state=open]:opacity-100"
                        >
                            <MoreVertical className="h-[14px] w-[14px]" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[160px] rounded-lg">
                        <DropdownMenuItem className="cursor-pointer rounded-lg mx-1 my-0.5" onClick={onArchive}>
                            <Archive className="h-4 w-4 mr-2" />Archive
                        </DropdownMenuItem>
                        <div className="h-px bg-border my-1 mx-2" />
                        <DropdownMenuItem
                            className="text-red-500 focus:text-red-500 focus:bg-red-500/10 cursor-pointer rounded-lg mx-1 my-0.5"
                            onClick={onDelete}
                        >
                            <Trash2 className="h-4 w-4 mr-2 opacity-80" />Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    );
}

// ─── AgentSection ─────────────────────────────────────────────────────────────
//
// Collapsed by default: one row per agent (avatar + name only). Clicking
// toggles it open to reveal that agent's conversations nested underneath.
// The row's left slot shows the avatar normally and swaps to a chevron
// (inside a pill hover background) on hover/expanded state, rather than
// showing both at once — matches the reference's collapsed-list treatment.

function AgentSection({ agent, conversations, selectedId, isExpanded, onToggle, onSelect, onNewChat, onArchive, onDelete, activeAgentId, activeState, hasSelectedConversation }: {
    agent: Agent;
    conversations: Conversation[];
    selectedId?: string;
    isExpanded: boolean;
    onToggle: () => void;
    onSelect: (c: Conversation) => void;
    onNewChat: (agentId: string) => void;
    onArchive: (id: string) => void;
    onDelete: (id: string) => void;
    activeAgentId?: string;
    activeState?: PersonaAnimationState;
    hasSelectedConversation?: boolean;
}) {
    return (
        <div className="mb-1.5">
            <button
                onClick={onToggle}
                title={isExpanded ? "Collapse" : `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`}
                className={cn(
                    "w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition-colors group",
                    hasSelectedConversation ? "bg-accent/60" : "hover:bg-accent/60"
                )}
            >
                <PersonaAvatar
                    persona={agent.persona}
                    state={agent.id === activeAgentId ? activeState : undefined}
                    size={36}
                    className="rounded-full h-9 w-9 shrink-0"
                    iconClassName="text-foreground/50"
                    icon={getAgentTypeIcon(agent.type)}
                />
                <span className={cn(
                    "text-[15px] truncate flex-1",
                    hasSelectedConversation ? "font-semibold text-foreground" : "font-medium text-foreground/80"
                )}>
                    {agent.name}
                </span>
                {conversations.length > 0 && (
                    <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0">
                        {conversations.length}
                    </span>
                )}
                <ChevronRight
                    className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform",
                        isExpanded && "rotate-90"
                    )}
                />
            </button>

            {isExpanded && (
                <div className="relative ml-[22px] pl-[26px] pt-1 border-l border-border/60">
                    {conversations.length === 0 ? (
                        <button
                            onClick={() => onNewChat(agent.id)}
                            className="w-full text-left px-2.5 py-2 text-[12px] text-muted-foreground/40 hover:text-muted-foreground transition-colors rounded-md hover:bg-accent/30"
                        >
                            Start a conversation…
                        </button>
                    ) : (
                        conversations.map(conv => (
                            <ConversationRow
                                key={conv.id}
                                conversation={conv}
                                isSelected={selectedId === conv.id}
                                onSelect={() => onSelect(conv)}
                                onArchive={() => onArchive(conv.id)}
                                onDelete={() => onDelete(conv.id)}
                            />
                        ))
                    )}
                    <button
                        onClick={() => onNewChat(agent.id)}
                        className="w-full flex items-center gap-1.5 h-9 px-2.5 rounded-md text-[13px] text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        New chat
                    </button>
                </div>
            )}
        </div>
    );
}

// ─── ConversationList ─────────────────────────────────────────────────────────

export function ConversationList({ selectedId, onSelect, onNewChat, activeAgentId, activeState }: ConversationListProps) {
    const [deleteId, setDeleteId] = useState<string | null>(null);
    const [actionType, setActionType] = useState<'archive' | 'delete'>('archive');
    const [search, setSearch] = useState('');
    const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
    // Tracks the last selectedId we auto-expanded for, so a manual collapse by
    // the user (clicking the same section closed again) doesn't get immediately
    // re-forced open on the next render — only a genuinely NEW selection (e.g.
    // clicking a conversation under a different agent) should auto-expand.
    const lastAutoExpandedForRef = useRef<string | undefined>(undefined);
    const queryClient = useQueryClient();
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;

    const { data: conversationsData, isLoading: loadingConvs, isError, refetch } = useQuery<ConversationsResponse>({
        queryKey: ["conversations"],
        queryFn: () => api.get<ConversationsResponse>("/api/v1/conversations"),
    });

    const { data: agentsData, isLoading: loadingAgents } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });

    const archiveMutation = useMutation({
        mutationFn: (id: string) => api.del(`/api/v1/conversations/${id}`),
        onSuccess: (_, id) => {
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            toast.success("Conversation archived");
            if (selectedId === id) router.push(`/${tenantSlug}/dashboard/chat`);
        },
        onError: (e: any) => toast.error(e.data?.message || "Failed to archive"),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.del(`/api/v1/conversations/${id}/permanent`),
        onSuccess: (_, id) => {
            queryClient.invalidateQueries({ queryKey: ["conversations"] });
            toast.success("Conversation deleted");
            if (selectedId === id) router.push(`/${tenantSlug}/dashboard/chat`);
        },
        onError: (e: any) => toast.error(e.data?.message || "Failed to delete"),
    });

    const activeAgents = (agentsData?.data ?? []).filter(a => a.status === 'active');
    const lockedAgents = (agentsData?.data ?? []).filter(a => a.status === 'paused');
    const allConvs = (conversationsData?.data ?? []).filter(c => c.status !== 'archived');
    const filtered = search.trim()
        ? allConvs.filter(c => (c.title || '').toLowerCase().includes(search.toLowerCase()))
        : allConvs;

    const convsByAgent = filtered.reduce<Record<string, Conversation[]>>((acc, c) => {
        (acc[c.agentId] ??= []).push(c);
        return acc;
    }, {});

    const isLoading = loadingConvs || loadingAgents;

    useEffect(() => {
        if (!selectedId || selectedId === lastAutoExpandedForRef.current) return;
        const conv = allConvs.find(c => c.id === selectedId);
        if (!conv) return;
        setExpandedAgentId(conv.agentId);
        lastAutoExpandedForRef.current = selectedId;
    }, [selectedId, allConvs]);

    return (
        <div className="flex flex-col h-full bg-[var(--messages-panel)] border-r border-border">
            <div className="pt-6 px-4 pb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-foreground">Messages</h2>
                <Button onClick={() => onNewChat()} size="icon" variant="ghost"
                    className="h-8 w-8 rounded-full hover:bg-accent/50 transition-colors"
                    title="New conversation"
                >
                    <Plus className="h-4 w-4" />
                </Button>
            </div>

            <div className="px-4 pb-4">
                <div className="relative group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
                    <input
                        type="text"
                        placeholder="Search chats..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full h-9 bg-secondary border border-border rounded-lg pl-9 pr-4 text-sm focus:ring-1 focus:ring-primary/20 outline-none transition-all"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
                {isError ? (
                    <div className="py-10 text-center px-4">
                        <p className="text-sm text-destructive mb-2">Failed to load chats</p>
                        <Button variant="outline" size="sm" onClick={() => refetch()} className="mx-auto">Retry</Button>
                    </div>
                ) : isLoading ? (
                    <div className="space-y-3 p-2">
                        {[1, 2].map(i => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
                    </div>
                ) : activeAgents.length > 0 ? (
                    <>
                        <p className="px-2.5 pb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-widest">
                            Your Team
                        </p>
                        {activeAgents.map(agent => (
                            <AgentSection
                                key={agent.id}
                                agent={agent}
                                conversations={convsByAgent[agent.id] ?? []}
                                selectedId={selectedId}
                                // A search in progress overrides collapse state so matching
                                // conversations are actually visible rather than hidden inside
                                // a closed section the user has no reason to think to open.
                                isExpanded={search.trim() ? (convsByAgent[agent.id]?.length ?? 0) > 0 : expandedAgentId === agent.id}
                                onToggle={() => setExpandedAgentId(id => id === agent.id ? null : agent.id)}
                                onSelect={onSelect}
                                onNewChat={onNewChat}
                                onArchive={(id) => { setActionType('archive'); setDeleteId(id); }}
                                onDelete={(id) => { setActionType('delete'); setDeleteId(id); }}
                                activeAgentId={activeAgentId}
                                activeState={activeState}
                                hasSelectedConversation={!!selectedId && (convsByAgent[agent.id] ?? []).some(c => c.id === selectedId)}
                            />
                        ))}
                        {lockedAgents.map(agent => (
                            <div key={agent.id} className="mb-4">
                                <div className="flex items-start justify-between px-2 mb-1">
                                    <button
                                        className="flex flex-col min-w-0 text-left"
                                        onClick={() => router.push(`/${tenantSlug}/dashboard/agents/${agent.id}`)}
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <PersonaAvatar
                                                persona={agent.persona}
                                                size={16}
                                                className="rounded bg-transparent border-0"
                                                iconClassName="text-muted-foreground/40"
                                                icon={getAgentTypeIcon(agent.type)}
                                            />
                                            <span className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider truncate">
                                                {agent.name}
                                            </span>
                                        </div>
                                        {agent.description && (
                                            <p className="text-[10px] text-muted-foreground/30 mt-0.5 pl-4 leading-snug line-clamp-1">
                                                {agent.description}
                                            </p>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => router.push(`/${tenantSlug}/dashboard/billing`)}
                                        className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-primary transition-colors shrink-0 mt-0.5"
                                        title="Upgrade to unlock"
                                    >
                                        <LockKeyhole className="h-3 w-3" />
                                        Upgrade
                                    </button>
                                </div>
                                <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground/30 italic">
                                    Unlock on paid plan
                                </div>
                            </div>
                        ))}
                    </>
                ) : (
                    <div className="py-10 text-center text-sm text-muted-foreground px-4">
                        No active agents. Create one to start chatting.
                    </div>
                )}
            </div>

            <AlertDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{actionType === 'delete' ? 'Delete Conversation?' : 'Archive Conversation?'}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {actionType === 'delete'
                                ? 'This will permanently delete the conversation and all its messages.'
                                : 'This will move the conversation to your archives.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                                if (!deleteId) return;
                                if (actionType === 'delete') deleteMutation.mutate(deleteId);
                                else archiveMutation.mutate(deleteId);
                                setDeleteId(null);
                            }}
                        >
                            {actionType === 'delete' ? 'Delete' : 'Archive'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { getAgentTypeIcon } from "@/components/platform/agents/agentTypeIcon";
import { MAX_FILES_PER_SELECTION } from "@/components/platform/chat/useFileUpload";
import type { Conversation } from "@/components/platform/chat/types";

/** A disabled folder trigger has to say *why* on its face: a disabled button
 *  does not reliably fire hover in every browser, so a `title` alone leaves the
 *  user with a dead control and no reason. Shared so grid and list agree. */
/** Undated rows are worse than none: a bad timestamp reads as fact. Anything
 *  unparseable drops out of the line entirely rather than rendering "Invalid Date". */
export function relativeAge(createdAt: string | undefined): string {
    if (!createdAt) return '';
    const at = new Date(createdAt);
    if (Number.isNaN(at.getTime())) return '';
    return formatDistanceToNow(at, { addSuffix: true });
}

/** Most picks are the chat you were just in. Showing every chat turns a
 *  one-glance decision into a scan, so older ones stay one click away.
 *  Collapsing a single row would be pure friction, hence the +1. */
const RECENT_LIMIT = 5;

interface AgentGroup {
    agentId: string;
    agent: Conversation['agent'];
    conversations: Conversation[];
}

/** The agent repeats on most rows, so it belongs in a heading rather than on
 *  each one. Group order follows the newest chat inside each group, so the
 *  agent you last worked with stays on top; `conversations` arrives newest-first
 *  from the API, and that order is preserved within a group. */
export function groupByAgent(conversations: Conversation[]): AgentGroup[] {
    const groups = new Map<string, AgentGroup>();
    for (const conversation of conversations) {
        const existing = groups.get(conversation.agentId);
        if (existing) existing.conversations.push(conversation);
        else groups.set(conversation.agentId, {
            agentId: conversation.agentId,
            agent: conversation.agent,
            conversations: [conversation],
        });
    }
    return [...groups.values()];
}

export function folderChatLabel(fileCount: number): string {
    if (fileCount === 0) return 'Empty folder';
    if (fileCount > MAX_FILES_PER_SELECTION) return `Over ${MAX_FILES_PER_SELECTION}-file limit`;
    return 'Add to chat';
}

interface AddToChatMenuProps {
    conversations: Conversation[];
    disabled?: boolean;
    label?: string;
    /** `null` means a new conversation. */
    onPick: (conversationId: string | null) => void;
    /** Row triggers sit quiet until hovered; the bulk bar's is a primary action.
     *  `icon` drops the label for grid cards, where there is no room for it. */
    variant?: 'row' | 'bulk' | 'icon';
    /** Lets a caller match local chrome (the grid's translucent overlay). */
    triggerClassName?: string;
}

export function AddToChatMenu({
    conversations, disabled, label = 'Add to chat', onPick, variant = 'row',
    triggerClassName = '',
}: AddToChatMenuProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [showAll, setShowAll] = useState(false);

    const matches = useMemo(() => {
        const active = conversations.filter(c => c.status === 'active');
        const q = query.trim().toLowerCase();
        if (!q) return active;
        // The agent name is on the row now, so it has to be searchable — a visible
        // field that does not match is read as broken search.
        return active.filter(c =>
            `${c.title || 'Untitled'} ${c.agent?.name ?? ''}`.toLowerCase().includes(q));
    }, [conversations, query]);

    // A search is an explicit request to look past the recent ones, so it never
    // collapses — a hidden match reads as a broken search.
    const collapsible = !query.trim() && matches.length > RECENT_LIMIT + 1;
    const visible = collapsible && !showAll ? matches.slice(0, RECENT_LIMIT) : matches;
    const hiddenCount = matches.length - visible.length;

    const pick = (conversationId: string | null) => {
        setOpen(false);
        setQuery('');
        setShowAll(false);
        onPick(conversationId);
    };

    return (
        <Popover
            open={open}
            onOpenChange={next => { setOpen(next); if (!next) { setQuery(''); setShowAll(false); } }}
        >
            <PopoverTrigger asChild>
                <Button
                    variant={variant === 'bulk' ? 'default' : 'ghost'}
                    size={variant === 'icon' ? 'icon' : 'sm'}
                    disabled={disabled}
                    title={variant === 'icon' ? label : undefined}
                    className={[
                        variant === 'bulk' ? 'h-7 text-xs gap-1.5'
                            : variant === 'icon' ? 'h-6 w-6 text-muted-foreground hover:text-foreground'
                                : 'h-7 text-xs gap-1.5 text-muted-foreground/70 hover:text-foreground',
                        triggerClassName,
                    ].join(' ').trim()}
                >
                    <MessageSquare className={variant === 'icon' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
                    {variant !== 'icon' && label}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-1.5">
                {/* New session first and always reachable: it is the one option that
                    never depends on what the search turns up. */}
                <button
                    type="button"
                    onClick={() => pick(null)}
                    className="w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm text-left hover:bg-secondary/60 transition-colors"
                >
                    {/* Boxed to the avatar's width so the labels below line up. */}
                    <span className="flex h-[22px] w-[22px] items-center justify-center shrink-0">
                        <Plus className="w-4 h-4" />
                    </span>
                    New session
                </button>

                <div className="relative my-1.5">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                        autoFocus
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search chats"
                        className="pl-8 h-8 text-xs"
                    />
                </div>

                <div className="max-h-72 overflow-y-auto">
                    {matches.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-muted-foreground text-center">
                            {query ? 'No chats match.' : 'No chats yet.'}
                        </p>
                    ) : (
                        groupByAgent(visible).map(group => (
                            <div key={group.agentId} className="mb-1 last:mb-0">
                                {/* Identity stated once per agent. Not a button: the
                                    agent is a label here, not a target — picking one
                                    would be ambiguous between its chats. */}
                                <div className="flex items-center gap-2 px-2 pt-2 pb-1">
                                    {/* No `state`: this is a picker, so the avatar stays static. */}
                                    <PersonaAvatar
                                        persona={group.agent?.persona}
                                        avatarUrl={group.agent?.avatarUrl}
                                        size={20}
                                        className="rounded-full h-5 w-5"
                                        iconClassName="text-foreground/50"
                                        icon={getAgentTypeIcon(group.agent?.type)}
                                    />
                                    <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                        {group.agent?.name || 'Agent'}
                                    </span>
                                </div>
                                {group.conversations.map(conversation => (
                                    <button
                                        key={conversation.id}
                                        type="button"
                                        onClick={() => pick(conversation.id)}
                                        // Indented to the heading's text, so the group reads
                                        // as one block rather than a flat list with dividers.
                                        className="w-full pl-9 pr-2 py-1.5 rounded-md text-sm text-left hover:bg-secondary/60 transition-colors"
                                        title={conversation.title || 'Untitled'}
                                    >
                                        <span className="block truncate leading-tight">
                                            {conversation.title || 'Untitled'}
                                        </span>
                                        {relativeAge(conversation.createdAt) && (
                                            <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                                                {relativeAge(conversation.createdAt)}
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        ))
                    )}
                    {hiddenCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setShowAll(true)}
                            className="w-full px-2 py-2 mt-1 rounded-md text-xs text-left text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
                        >
                            Show {hiddenCount} older
                        </button>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

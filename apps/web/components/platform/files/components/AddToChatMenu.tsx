"use client";

import { useMemo, useState } from "react";
import { MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { getAgentTypeIcon } from "@/components/platform/agents/agentTypeIcon";
import type { Conversation } from "@/components/platform/chat/types";

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

    const matches = useMemo(() => {
        const active = conversations.filter(c => c.status === 'active');
        const q = query.trim().toLowerCase();
        if (!q) return active;
        return active.filter(c => (c.title || 'Untitled').toLowerCase().includes(q));
    }, [conversations, query]);

    const pick = (conversationId: string | null) => {
        setOpen(false);
        setQuery('');
        onPick(conversationId);
    };

    return (
        <Popover
            open={open}
            onOpenChange={next => { setOpen(next); if (!next) setQuery(''); }}
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
            <PopoverContent align="end" className="w-64 p-1.5">
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

                <div className="max-h-56 overflow-y-auto">
                    {matches.length === 0 ? (
                        <p className="px-2 py-3 text-xs text-muted-foreground text-center">
                            {query ? 'No chats match.' : 'No chats yet.'}
                        </p>
                    ) : (
                        matches.map(conversation => (
                            <button
                                key={conversation.id}
                                type="button"
                                onClick={() => pick(conversation.id)}
                                className="w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm text-left hover:bg-secondary/60 transition-colors"
                                title={conversation.agent?.name
                                    ? `${conversation.title || 'Untitled'} — ${conversation.agent.name}`
                                    : conversation.title || 'Untitled'}
                            >
                                {/* No `state`: this is a picker, so the avatar stays static. */}
                                <PersonaAvatar
                                    persona={conversation.agent?.persona}
                                    avatarUrl={conversation.agent?.avatarUrl}
                                    size={22}
                                    className="rounded-full h-[22px] w-[22px]"
                                    iconClassName="text-foreground/50"
                                    icon={getAgentTypeIcon(conversation.agent?.type)}
                                />
                                <span className="truncate">{conversation.title || 'Untitled'}</span>
                            </button>
                        ))
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

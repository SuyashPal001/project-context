"use client";

import { useMemo, useState } from "react";
import { MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Conversation } from "@/components/platform/chat/types";

interface AddToChatMenuProps {
    conversations: Conversation[];
    disabled?: boolean;
    label?: string;
    /** `null` means a new conversation. */
    onPick: (conversationId: string | null) => void;
    /** Row triggers sit quiet until hovered; the bulk bar's is a primary action. */
    variant?: 'row' | 'bulk';
}

export function AddToChatMenu({
    conversations, disabled, label = 'Add to chat', onPick, variant = 'row',
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
                    size="sm"
                    disabled={disabled}
                    className={variant === 'bulk'
                        ? 'h-7 text-xs gap-1.5'
                        : 'h-7 text-xs gap-1.5 text-muted-foreground/70 hover:text-foreground'}
                >
                    <MessageSquare className="w-3.5 h-3.5" />
                    {label}
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
                    <Plus className="w-4 h-4 shrink-0" />
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
                                className="w-full px-2 py-2 rounded-md text-sm text-left truncate hover:bg-secondary/60 transition-colors"
                                title={conversation.title || 'Untitled'}
                            >
                                {conversation.title || 'Untitled'}
                            </button>
                        ))
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

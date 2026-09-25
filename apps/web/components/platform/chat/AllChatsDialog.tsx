"use client";

import { useState } from "react";
import { Archive, ArchiveRestore, Search, Trash2 } from "lucide-react";
import { format, isToday } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Conversation } from "./types";
import { WORK_ITEM } from "./workItemLabels";

// Every chat, including archived ones — the sidebar shows only the recent few.
// Archived chats live here and nowhere else, so this is also where they come back.

function lastActivity(c: Conversation): number {
    return new Date(c.lastMessage?.createdAt ?? c.createdAt).getTime();
}

function formatDate(ms: number): string {
    const d = new Date(ms);
    return isToday(d) ? format(d, "h:mm a") : format(d, "MMM d");
}

export function AllChatsDialog({ open, onOpenChange, conversations, onSelect, onNewChat, onArchive, onUnarchive, onDelete }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    conversations: Conversation[];
    onSelect: (c: Conversation) => void;
    onNewChat: () => void;
    onArchive: (id: string) => void;
    onUnarchive: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const [tab, setTab] = useState<"active" | "archived">("active");
    const [search, setSearch] = useState("");

    const archivedCount = conversations.filter(c => c.status === "archived").length;
    const query = search.trim().toLowerCase();
    const rows = conversations
        .filter(c => (tab === "archived") === (c.status === "archived"))
        .filter(c => !query || (c.title || "").toLowerCase().includes(query))
        .sort((a, b) => lastActivity(b) - lastActivity(a));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl p-0 gap-0 max-h-[80vh] flex flex-col overflow-hidden">
                <div className="px-6 pt-6 pb-4 space-y-4 border-b border-border">
                    <div className="flex items-center justify-between gap-3 pr-8">
                        <DialogTitle className="text-xl font-semibold">{WORK_ITEM.all}</DialogTitle>
                        <Button size="sm" className="h-8" onClick={() => { onOpenChange(false); onNewChat(); }}>
                            New
                        </Button>
                    </div>
                    <DialogDescription className="sr-only">Search, reopen or restore your chats.</DialogDescription>
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <input
                                autoFocus
                                type="text"
                                placeholder={`Search ${WORK_ITEM.plural.toLowerCase()}…`}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="w-full h-9 bg-secondary border border-border rounded-lg pl-9 pr-3 text-sm focus:ring-1 focus:ring-primary/20 outline-none"
                            />
                        </div>
                        <div className="flex items-center rounded-lg bg-secondary p-0.5 text-[13px]">
                            {(["active", "archived"] as const).map(t => (
                                <button
                                    key={t}
                                    onClick={() => setTab(t)}
                                    className={cn(
                                        "h-8 px-3 rounded-md transition-colors",
                                        tab === t ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    {t === "active" ? "Active" : `Archived${archivedCount ? ` (${archivedCount})` : ""}`}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-3 py-2 custom-scrollbar">
                    {rows.length === 0 ? (
                        <p className="py-12 text-center text-sm text-muted-foreground">
                            {query
                                ? `No ${WORK_ITEM.plural.toLowerCase()} match "${search.trim()}".`
                                : tab === "archived" ? `No archived ${WORK_ITEM.plural.toLowerCase()}.` : WORK_ITEM.empty}
                        </p>
                    ) : rows.map(c => (
                        <div key={c.id} className="group relative flex items-center border-b border-border/50 last:border-0">
                            <button
                                onClick={() => { onOpenChange(false); onSelect(c); }}
                                className="flex-1 min-w-0 flex items-center gap-3 px-3 py-3 text-left rounded-md hover:bg-accent/40 transition-colors"
                            >
                                <span className="flex-1 min-w-0 truncate text-sm">{c.title || WORK_ITEM.untitled}</span>
                                {c.needsReply && (
                                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--shimmer-accent)] shrink-0" title="Needs reply" />
                                )}
                                <span className="text-[12px] text-muted-foreground tabular-nums shrink-0 group-hover:invisible">
                                    {formatDate(lastActivity(c))}
                                </span>
                            </button>
                            <div className="absolute right-2 hidden group-hover:flex items-center gap-0.5">
                                {c.status === "archived" ? (
                                    <>
                                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Unarchive" onClick={() => onUnarchive(c.id)}>
                                            <ArchiveRestore className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-500" title="Delete" onClick={() => onDelete(c.id)}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </>
                                ) : (
                                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Archive" onClick={() => onArchive(c.id)}>
                                        <Archive className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}

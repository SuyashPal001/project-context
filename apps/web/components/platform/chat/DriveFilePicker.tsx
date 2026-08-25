"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
    Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { getFileIcon, formatFileSize } from "@/components/platform/files/lib/fileIcons";
import type { FileRecord } from "@/components/platform/files/types";
import type { Attachment } from "@/types/agent-events";

interface DriveFilePickerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** How many more files the composer will accept before hitting its cap. */
    remainingSlots: number;
    onConfirm: (attachments: Attachment[]) => void;
}

export function DriveFilePicker({ open, onOpenChange, remainingSlots, onConfirm }: DriveFilePickerProps) {
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<Set<string>>(new Set());

    // Same key as the Drive page so an already-warm cache is reused. No prefix:
    // the endpoint returns the tenant's files flat, and the folder structure Drive
    // shows is derived client-side — a picker wants the flat list.
    const { data, isLoading } = useQuery({
        queryKey: ['files', ''],
        queryFn: () => api.get<{ data: FileRecord[] }>('/api/v1/files'),
        enabled: open,
    });

    const allFiles = useMemo(() => data?.data ?? [], [data]);

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? allFiles.filter(f => f.filename.toLowerCase().includes(q)) : allFiles;
    }, [allFiles, query]);

    const toggle = (id: string) => setPicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else if (next.size < remainingSlots) next.add(id);
        return next;
    });

    const close = () => {
        setPicked(new Set());
        setQuery("");
        onOpenChange(false);
    };

    const confirm = () => {
        onConfirm(allFiles.filter(f => picked.has(f.id)).map(f => ({
            fileId: f.id,
            name: f.filename,
            type: f.contentType,
            size: f.size,
        })));
        close();
    };

    return (
        <Dialog open={open} onOpenChange={o => (o ? onOpenChange(true) : close())}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Add from Drive</DialogTitle>
                </DialogHeader>

                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search files"
                        className="pl-8 h-9 text-sm"
                    />
                </div>

                <div className="max-h-[45vh] overflow-y-auto -mx-1 px-1">
                    {isLoading ? (
                        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading files
                        </div>
                    ) : visible.length === 0 ? (
                        <p className="py-10 text-center text-sm text-muted-foreground">
                            {query ? 'No files match that search.' : 'No files in Drive yet.'}
                        </p>
                    ) : (
                        <ul className="space-y-0.5">
                            {visible.map(file => {
                                const isPicked = picked.has(file.id);
                                // Rows past the cap stay visible but inert, so the limit is
                                // discoverable rather than a click that silently does nothing.
                                const blocked = !isPicked && picked.size >= remainingSlots;
                                return (
                                    <li key={file.id}>
                                        <button
                                            type="button"
                                            onClick={() => toggle(file.id)}
                                            disabled={blocked}
                                            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-left hover:bg-secondary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            <Checkbox checked={isPicked} className="pointer-events-none shrink-0" />
                                            <span className="shrink-0">{getFileIcon(file.contentType)}</span>
                                            <span className="flex-1 min-w-0 truncate text-sm text-foreground/80" title={file.filename}>
                                                {file.filename}
                                            </span>
                                            <span className="shrink-0 text-xs font-mono text-muted-foreground">
                                                {formatFileSize(file.size)}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                <DialogFooter className="sm:justify-between items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                        {picked.size} of {remainingSlots} selected
                    </span>
                    <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
                        <Button size="sm" onClick={confirm} disabled={picked.size === 0}>
                            Add {picked.size > 0 ? picked.size : ''}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

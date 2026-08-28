"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "@/lib/api";
import { getFileIcon, formatFileSize } from "@/components/platform/files/lib/fileIcons";
import type { FileRecord } from "@/components/platform/files/types";
import type { PaletteHandle } from "./SlashPalette";

interface HashFilePaletteProps {
    query: string;
    onSelect: (file: FileRecord) => void;
    onClose: () => void;
    /** Cards past this stay visible but inert, matching DriveFilePicker's
     * cap-discoverability pattern — a click that would silently do nothing
     * is worse than a visibly disabled row. */
    remainingSlots: number;
}

function useThumbnailUrl(file: FileRecord): string | undefined {
    const [url, setUrl] = useState<string | undefined>(undefined);
    useEffect(() => {
        setUrl(undefined);
        if (!file.contentType.includes('image')) return;
        let cancelled = false;
        api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(file.id)}/presigned-url`)
            .then(res => { if (!cancelled) setUrl(res.presignedUrl); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [file.id, file.contentType]);
    return url;
}

function AssetGridCard({ file, isActive, isBlocked, onPick, onHover }: {
    file: FileRecord;
    isActive: boolean;
    isBlocked: boolean;
    onPick: () => void;
    onHover: () => void;
}) {
    const thumbnailUrl = useThumbnailUrl(file);
    return (
        <button
            type="button"
            onClick={onPick}
            onMouseEnter={onHover}
            disabled={isBlocked}
            className={`flex flex-col rounded-xl overflow-hidden border text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isActive ? 'border-primary/50 bg-accent/40' : 'border-border/60 hover:border-border'
            }`}
        >
            <div className="aspect-[16/10] flex items-center justify-center bg-muted/50 relative">
                {thumbnailUrl ? (
                    <img src={thumbnailUrl} alt={file.filename} className="h-full w-full object-cover" />
                ) : (
                    getFileIcon(file.contentType)
                )}
            </div>
            <div className="px-2 py-1.5">
                <p className="text-[11px] font-medium truncate" title={file.filename}>{file.filename}</p>
                <p className="text-[10px] text-muted-foreground">{formatFileSize(file.size)}</p>
            </div>
        </button>
    );
}

// Typing "#" opens this to reference an existing Drive file inline — same data
// and same reference-not-copy attach behavior as the "+" -> "From Drive"
// dialog (DriveFilePicker), just a faster grid-based path triggered from the
// textarea. Deliberately a separate trigger from "@" (agent mentions) and "/"
// (workflows) rather than folded into either — keeps each trigger single-purpose.
export const HashFilePalette = forwardRef<PaletteHandle, HashFilePaletteProps>(function HashFilePalette(
    { query: initialQuery, onSelect, onClose, remainingSlots },
    ref,
) {
    const [searchValue, setSearchValue] = useState(initialQuery);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Same query key as DriveFilePicker and the Drive page — reuses an
    // already-warm cache instead of double-fetching.
    const { data, isLoading } = useQuery({
        queryKey: ['files', ''],
        queryFn: () => api.get<{ data: FileRecord[] }>('/api/v1/files'),
    });

    const allFiles = useMemo(() => data?.data ?? [], [data]);
    const filtered = useMemo(() => {
        const q = searchValue.trim().toLowerCase();
        return q ? allFiles.filter(f => f.filename.toLowerCase().includes(q)) : allFiles;
    }, [allFiles, searchValue]);

    const [activeIndex, setActiveIndex] = useState(0);
    useEffect(() => { setActiveIndex(0); }, [searchValue]);

    const moveActive = (delta: number) => {
        if (filtered.length === 0) return;
        setActiveIndex(i => (i + delta + filtered.length) % filtered.length);
    };

    const selectActive = () => {
        const file = filtered[activeIndex];
        if (!file || activeIndex >= remainingSlots) return false;
        onSelect(file);
        onClose();
        return true;
    };

    useImperativeHandle(ref, () => ({ moveActive, selectActive }), [filtered, activeIndex, remainingSlots, onSelect, onClose]);

    return (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border/50 bg-popover shadow-[0_20px_50px_-12px_rgba(0,0,0,0.28),0_8px_24px_-8px_rgba(0,0,0,0.16)] dark:shadow-[0_24px_60px_-15px_rgba(0,0,0,0.65),0_10px_28px_-8px_rgba(0,0,0,0.45),inset_0_1px_0_0_rgba(255,255,255,0.05)] p-2.5 max-h-80 flex flex-col">
            <div className="flex items-center gap-2 px-3 h-10 mb-2 rounded-xl bg-muted/50 focus-within:ring-1 focus-within:ring-primary/30 shrink-0">
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
                    placeholder="Search Drive files"
                    className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
                />
            </div>
            {isLoading ? (
                <div className="px-3 py-8 text-xs text-muted-foreground text-center">Loading…</div>
            ) : filtered.length === 0 ? (
                <div className="px-3 py-8 text-xs text-muted-foreground text-center">
                    {searchValue ? `No files match "${searchValue}".` : 'No files in Drive yet.'}
                </div>
            ) : (
                <div className="grid grid-cols-3 gap-2 overflow-y-auto custom-scrollbar">
                    {filtered.map((file, i) => (
                        <AssetGridCard
                            key={file.id}
                            file={file}
                            isActive={i === activeIndex}
                            isBlocked={i >= remainingSlots}
                            onPick={() => { if (i < remainingSlots) { onSelect(file); onClose(); } }}
                            onHover={() => setActiveIndex(i)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});

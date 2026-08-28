"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Check } from "lucide-react";
import { api } from "@/lib/api";
import { getFileIcon, formatFileSize } from "@/components/platform/files/lib/fileIcons";
import type { FileRecord } from "@/components/platform/files/types";
import type { PaletteHandle } from "./SlashPalette";

interface HashFilePaletteProps {
    query: string;
    /** Confirms the whole current selection at once (1 or more files) — the
     * merge of what used to be two separate pickers: this one's quick
     * single-pick, and "+" -> "From Drive"'s checkbox multi-select. */
    onConfirm: (files: FileRecord[]) => void;
    onClose: () => void;
    /** Cards past this stay visible but inert — a click that would silently
     * do nothing is worse than a visibly disabled row. */
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

function AssetGridCard({ file, isActive, isPicked, isBlocked, onToggle, onHover }: {
    file: FileRecord;
    isActive: boolean;
    isPicked: boolean;
    isBlocked: boolean;
    onToggle: () => void;
    onHover: () => void;
}) {
    const thumbnailUrl = useThumbnailUrl(file);
    return (
        <button
            type="button"
            onClick={onToggle}
            onMouseEnter={onHover}
            disabled={isBlocked}
            className={`relative flex flex-col overflow-hidden border text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isPicked ? 'border-primary bg-primary/5' : isActive ? 'border-primary/50 bg-accent/40' : 'border-border/60 hover:border-border'
            }`}
            // Inline, not Tailwind utilities — this grid/card layout was silently
            // not receiving several of its utility classes in production (cause
            // still unconfirmed), collapsing every card to a full-width sliver.
            // Inline styles can't be dropped by whatever that pipeline issue is.
            style={{ width: '100%', borderRadius: '12px', boxSizing: 'border-box' }}
        >
            <span
                className={`absolute top-1.5 right-1.5 z-10 rounded-full border flex items-center justify-center transition-colors ${
                    isPicked ? 'bg-primary border-primary' : 'bg-background/80 border-border'
                }`}
                style={{ height: '18px', width: '18px' }}
            >
                {isPicked && <Check className="h-3 w-3 text-primary-foreground" strokeWidth={3} />}
            </span>
            {/* Fixed height, not aspect-ratio — the thumbnail box collapsed to a
                sliver when its width came out unreliable inside the grid, taking
                the whole card down to a thin pill with it. A plain fixed height
                can't collapse regardless of parent width. */}
            <div
                className="flex items-center justify-center bg-muted/50 relative"
                style={{ height: '64px', width: '100%', flexShrink: 0 }}
            >
                {thumbnailUrl ? (
                    <img src={thumbnailUrl} alt={file.filename} className="object-cover" style={{ height: '100%', width: '100%' }} />
                ) : (
                    getFileIcon(file.contentType)
                )}
            </div>
            <div className="px-2 py-1.5 w-full">
                <p className="text-[11px] font-medium truncate" title={file.filename}>{file.filename}</p>
                <p className="text-[10px] text-muted-foreground">{formatFileSize(file.size)}</p>
            </div>
        </button>
    );
}

// Typing "#" opens this to reference existing Drive file(s) inline — same data
// and same reference-not-copy attach behavior the old "+" -> "From Drive"
// dialog had, merged into one picker instead of keeping two separate ones for
// the same job. Deliberately a separate trigger from "@" (agent mentions) and
// "/" (workflows) rather than folded into either — keeps each single-purpose.
export const HashFilePalette = forwardRef<PaletteHandle, HashFilePaletteProps>(function HashFilePalette(
    { query: initialQuery, onConfirm, onClose, remainingSlots },
    ref,
) {
    const [searchValue, setSearchValue] = useState(initialQuery);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Same query key as the Drive page — reuses an already-warm cache instead
    // of double-fetching.
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

    const toggle = (id: string, index: number) => {
        setPicked(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else if (index < remainingSlots) next.add(id);
            return next;
        });
    };

    const confirm = () => {
        if (picked.size === 0) return false;
        onConfirm(allFiles.filter(f => picked.has(f.id)));
        onClose();
        return true;
    };

    // Enter toggles the highlighted card into/out of the selection rather than
    // immediately confirming — multi-select needs a distinct "I'm done" step
    // (the Add button, or Enter again with nothing newly toggled won't do
    // since there's always something highlighted; Cmd/Ctrl+Enter confirms).
    const selectActive = () => {
        const file = filtered[activeIndex];
        if (!file) return false;
        toggle(file.id, activeIndex);
        return true;
    };

    useImperativeHandle(ref, () => ({ moveActive, selectActive }), [filtered, activeIndex, remainingSlots]);

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
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirm(); return; }
                        if (e.key === "Enter") { e.preventDefault(); selectActive(); return; }
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
                <div
                    className="overflow-y-auto flex-1 min-h-0"
                    style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}
                >
                    {filtered.map((file, i) => (
                        <AssetGridCard
                            key={file.id}
                            file={file}
                            isActive={i === activeIndex}
                            isPicked={picked.has(file.id)}
                            isBlocked={!picked.has(file.id) && i >= remainingSlots}
                            onToggle={() => toggle(file.id, i)}
                            onHover={() => setActiveIndex(i)}
                        />
                    ))}
                </div>
            )}
            <div className="flex items-center justify-between pt-2 mt-2 border-t border-border/40 shrink-0">
                <span className="text-[11px] text-muted-foreground px-1">
                    {picked.size} of {remainingSlots} selected
                </span>
                <div className="flex items-center gap-2">
                    <button type="button" onClick={onClose} className="text-xs font-medium text-muted-foreground hover:text-foreground px-2 py-1">
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={confirm}
                        disabled={picked.size === 0}
                        className="text-xs font-medium rounded-full bg-primary text-primary-foreground px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Add{picked.size > 0 ? ` ${picked.size}` : ''}
                    </button>
                </div>
            </div>
        </div>
    );
});

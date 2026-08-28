"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Check, Plus, Play } from "lucide-react";
import { api } from "@/lib/api";
import { formatFileSize } from "@/components/platform/files/lib/fileIcons";
import { assetTypeForFile } from "@/lib/assetType";
import { TYPE_ICONS, TYPE_STYLES } from "@/components/platform/canvas/assetTypeStyles";
import { useVideoFrameThumbnail } from "@/components/platform/canvas/videoFrameThumbnail";
import { useLazyThumbnail, useThumbnailUrl } from "@/hooks/useAssetThumbnail";
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

// Thumbnail fetching (rate-limit-safe presigned URLs, lazy in-view loading)
// lives in hooks/useAssetThumbnail.ts, shared with AttachmentStrip's tiles —
// see that file for why the bounding matters (60/min/tenant API rate limit).

function AssetGridCard({ file, isActive, isPicked, isBlocked, onToggle, onHover }: {
    file: FileRecord;
    isActive: boolean;
    isPicked: boolean;
    isBlocked: boolean;
    onToggle: () => void;
    onHover: () => void;
}) {
    const { ref: cardRef, inView } = useLazyThumbnail<HTMLButtonElement>();
    // Same classifier/icon/tint system as the Drive grid and AssetGallery, so a
    // file looks identical wherever it's listed. For audio/pdf/docx the tinted
    // background *is* the preview.
    const assetType = assetTypeForFile(file.contentType, file.filename);
    const Icon = TYPE_ICONS[assetType];
    const typeStyle = TYPE_STYLES[assetType];
    const isVideo = assetType === 'video';
    const imageThumbnailUrl = useThumbnailUrl(file.id, inView && assetType === 'image');
    const videoFrameUrl = useVideoFrameThumbnail(file.id, inView && isVideo);
    const thumbnailUrl = imageThumbnailUrl ?? videoFrameUrl;
    return (
        <button
            ref={cardRef}
            type="button"
            onClick={onToggle}
            onMouseEnter={onHover}
            disabled={isBlocked}
            className={`group relative flex flex-col overflow-hidden border text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                isPicked ? 'border-primary bg-primary/5' : isActive ? 'border-primary/50 bg-accent/40' : 'border-border/60 hover:border-border'
            }`}
            style={{ width: '100%', borderRadius: '14px', boxSizing: 'border-box' }}
        >
            <span
                className={`absolute top-2 right-2 z-10 rounded-full border flex items-center justify-center transition-colors ${
                    isPicked ? 'bg-primary border-primary' : 'bg-background/90 border-border'
                }`}
                style={{ height: '22px', width: '22px' }}
            >
                {isPicked && <Check className="h-3.5 w-3.5 text-primary-foreground" strokeWidth={3} />}
            </span>
            {/* Fixed pixel height rather than aspect-ratio: the row track that
                holds this card is now min-content, so the card's height has to
                come from a size the box itself declares. */}
            <div
                className={`flex items-center justify-center relative overflow-hidden ${typeStyle.bg}`}
                style={{ height: '150px', width: '100%', flexShrink: 0 }}
            >
                {thumbnailUrl ? (
                    <>
                        <img src={thumbnailUrl} alt={file.filename} className="object-cover" style={{ height: '100%', width: '100%' }} />
                        {isVideo && (
                            <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="h-8 w-8 rounded-full bg-black/50 flex items-center justify-center">
                                    <Play className="h-4 w-4 text-white fill-white" />
                                </span>
                            </span>
                        )}
                    </>
                ) : (
                    <Icon className={`h-10 w-10 ${typeStyle.icon}`} />
                )}
                {!isPicked && !isBlocked && (
                    <span
                        className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/35 transition-colors opacity-0 group-hover:opacity-100"
                    >
                        <span className="flex items-center gap-1.5 rounded-full bg-background text-foreground text-xs font-medium px-3 py-1.5 shadow-sm">
                            <Plus className="h-3.5 w-3.5" />
                            Select
                        </span>
                    </span>
                )}
            </div>
            <div className="px-2.5 py-2 w-full">
                <p className="text-[12px] font-medium truncate" title={file.filename}>{file.filename}</p>
                {/* size is nullable in the DB; formatFileSize(null) renders "NaN undefined". */}
                <p className="text-[10px] text-muted-foreground">
                    {typeof file.size === 'number' && Number.isFinite(file.size) ? formatFileSize(file.size) : '—'}
                </p>
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

    // Blocked when the *selection* is full, not by list position. The old
    // `index < remainingSlots` test made every card past slot N permanently
    // unpickable in a long list (and greyed out at opacity-40), while a short
    // filtered list never hit it — a second reason the unfiltered grid looked
    // broken.
    const toggle = (id: string) => {
        setPicked(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else if (next.size < remainingSlots) next.add(id);
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
    // (the Add button, or Cmd/Ctrl+Enter from the keyboard).
    const selectActive = () => {
        const file = filtered[activeIndex];
        if (!file) return false;
        toggle(file.id);
        return true;
    };

    useImperativeHandle(ref, () => ({ moveActive, selectActive }), [filtered, activeIndex, remainingSlots]);

    return (
        <div
            className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-border/50 bg-popover shadow-[0_20px_50px_-12px_rgba(0,0,0,0.28),0_8px_24px_-8px_rgba(0,0,0,0.16)] dark:shadow-[0_24px_60px_-15px_rgba(0,0,0,0.65),0_10px_28px_-8px_rgba(0,0,0,0.45),inset_0_1px_0_0_rgba(255,255,255,0.05)] p-3 flex flex-col"
            style={{ maxHeight: '70vh' }}
        >
            <div className="flex items-center gap-2 px-3 h-11 mb-3 rounded-xl bg-muted/50 focus-within:ring-1 focus-within:ring-primary/30 shrink-0">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                    ref={inputRef}
                    type="text"
                    value={searchValue}
                    onChange={e => setSearchValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "ArrowDown") { e.preventDefault(); moveActive(3); return; }
                        if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-3); return; }
                        if (e.key === "ArrowRight") { e.preventDefault(); moveActive(1); return; }
                        if (e.key === "ArrowLeft") { e.preventDefault(); moveActive(-1); return; }
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirm(); return; }
                        if (e.key === "Enter") { e.preventDefault(); selectActive(); return; }
                        if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
                    }}
                    placeholder="Search Drive files"
                    className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
                />
            </div>
            {isLoading ? (
                <div className="px-3 py-12 text-xs text-muted-foreground text-center">Loading…</div>
            ) : filtered.length === 0 ? (
                <div className="px-3 py-12 text-xs text-muted-foreground text-center">
                    {searchValue ? `No files match "${searchValue}".` : 'No files in Drive yet.'}
                </div>
            ) : (
                <div
                    className="overflow-y-auto flex-1 min-h-0"
                    // gridAutoRows is load-bearing, not cosmetic. `flex-1 min-h-0`
                    // gives this grid a *definite* height (the panel is capped at
                    // 70vh). Implicit rows default to `auto`, whose minimum is the
                    // item's automatic minimum size — and every card sets
                    // `overflow-hidden`, which makes that minimum 0. Once the rows
                    // don't fit (roughly 4+ rows, i.e. 10+ files) the free space
                    // goes negative and the track sizing algorithm freezes every
                    // row at that 0 minimum instead of overflowing into the
                    // scroller: all 150px cards collapse into ~25px slivers. A
                    // short filtered list has positive free space, so it looked
                    // fine — which is why this read as a size-dependent bug.
                    // `min-content` pins each row to the card's real height, and
                    // `start` keeps rows from stretching when the list is short.
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                        gridAutoRows: 'min-content',
                        alignContent: 'start',
                        gap: '10px',
                    }}
                >
                    {filtered.map((file, i) => (
                        <AssetGridCard
                            key={file.id}
                            file={file}
                            isActive={i === activeIndex}
                            isPicked={picked.has(file.id)}
                            isBlocked={!picked.has(file.id) && picked.size >= remainingSlots}
                            onToggle={() => toggle(file.id)}
                            onHover={() => setActiveIndex(i)}
                        />
                    ))}
                </div>
            )}
            <div className="flex items-center justify-between pt-3 mt-3 border-t border-border/40 shrink-0">
                <div className="flex items-center gap-3 text-[10.5px] text-muted-foreground font-mono">
                    <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded bg-muted">↑↓</kbd>move</span>
                    <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded bg-muted">↵</kbd>select</span>
                    <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 rounded bg-muted">esc</kbd>close</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground px-1">
                        {picked.size} of {remainingSlots} selected
                    </span>
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

'use client';

import { useEffect, useState, type ReactNode } from "react";
import { useThumbnailUrl } from "@/hooks/useAssetThumbnail";
import { cn } from "@/lib/utils";
import { assetTypeForFile } from "@/lib/assetType";
import { TYPE_ICONS, TYPE_STYLES, typeBadge } from "@/components/platform/canvas/assetTypeStyles";
import { EXPECTED_MS, estimatedProgress } from "./ToolCallCard";

// Branch style (2026-10-07, after the reference the user showed): what a step
// made, or what the thinking said, hangs off its row behind a └ connector,
// instead of sitting in the trace as separate rows and full-size cards.

export function Branch({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={cn("relative mt-1 mb-1.5 pl-6 min-w-0", className)}>
            <span aria-hidden className="absolute left-[9px] top-0 h-3.5 w-3 rounded-bl-md border-b border-l border-foreground/25" />
            {children}
        </div>
    );
}

export type TileFile = { fileId?: string; name: string; type: string; size?: number; previewUrl?: string };

/** A small tile for a picture or clip; it opens full size in the canvas. */
export function FileTile({ file, size = 'md' }: { file: TileFile; size?: 'sm' | 'md' }) {
    const url = useThumbnailUrl(file.fileId ?? '', !!file.fileId) ?? file.previewUrl ?? null;
    const type = assetTypeForFile(file.type, file.name);
    const Icon = TYPE_ICONS[type];
    const open = () => {
        if (!file.fileId) return;
        const w = window as unknown as { __openCanvas?: () => void; __canvasUpdate?: (action: string, data: unknown) => void };
        w.__openCanvas?.();
        w.__canvasUpdate?.('asset_open', { asset: { id: file.fileId, type, filename: file.name, mimeType: file.type, thumbnailUrl: url, size: file.size, createdAt: new Date().toISOString(), sourceMessageId: '', fileId: file.fileId } });
    };
    return (
        <button type="button" onClick={open} title={file.name} aria-label={file.name}
            className={cn("relative shrink-0 rounded-md overflow-hidden ring-1 ring-border/60 hover:ring-foreground/40 transition-shadow", size === 'sm' ? "h-20 w-[45px]" : "h-28 w-[63px]", TYPE_STYLES[type].bg)}>
            {url && type === 'image' ? <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />
                : url && type === 'video' ? <video src={url} preload="metadata" muted className="absolute inset-0 h-full w-full object-cover" />
                : <Icon className={cn("absolute inset-0 m-auto h-4 w-4", TYPE_STYLES[type].icon)} />}
            {type !== 'image' && <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[8px] font-semibold text-white">{typeBadge(type, file.name)}</span>}
        </button>
    );
}

/** A tile still being made, with the big generating card's look at tile size:
 *  rose sweep, the estimated percentage and a progress bar. The first version
 *  was a faint grey that read as an empty gap (2026-10-07). */
export function PendingTile({ kind = 'image' }: { kind?: 'image' | 'video' }) {
    const [startedAt] = useState(() => Date.now());
    const [now, setNow] = useState(startedAt);
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(id);
    }, []);
    const pct = estimatedProgress(now - startedAt, EXPECTED_MS[kind]);
    return (
        <div aria-label="being made" className={cn("relative h-28 w-[63px] shrink-0 rounded-md overflow-hidden border border-border/60 flex items-center justify-center", TYPE_STYLES[kind].bg)}>
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-[#E69DB8]/25 to-transparent animate-shimmer" />
            <span className="relative z-10 text-[10px] font-medium tabular-nums text-muted-foreground">{pct}%</span>
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-foreground/10">
                <div className="h-full bg-[var(--shimmer-accent)] transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

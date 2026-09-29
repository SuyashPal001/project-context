"use client";

import { forwardRef, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { FileThumbnail } from './FileThumbnail';
import { AddToChatMenu } from './components/AddToChatMenu';
import { ProductsPanel, type ProductsPanelHandle } from '@/components/platform/chat/creative-library/ProductsPanel';
import type { ProductRecord } from '@/components/platform/chat/creative-library/productsApi';
import type { Attachment } from '@/types/agent-events';
import type { Conversation } from '@/components/platform/chat/types';

type ProductsPage = { pages: { data: ProductRecord[] }[] };

/** `['creative-products']` is a prefix match, not an exact one — it also
 *  catches FilesList's `['creative-products', '__image-file-ids']` query,
 *  whose data is a plain `string[]`. Any cache entry that isn't shaped like
 *  the products infinite-query (an object with an array `pages`) is skipped
 *  rather than assumed. */
function isProductsPage(value: unknown): value is ProductsPage {
    return !!value && typeof value === 'object' && Array.isArray((value as { pages?: unknown }).pages);
}

/** Reads the current copy of a product straight out of `ProductsPanel`'s own
 *  infinite-query cache (every cached search variant, every page), so the
 *  opened view reflects a rename or a naming update instead of the stale
 *  snapshot captured when it was opened. */
function findCachedProduct(queryClient: QueryClient, id: string): ProductRecord | undefined {
    const entries = queryClient.getQueriesData({ queryKey: ['creative-products'] });
    for (const [, data] of entries) {
        if (!isProductsPage(data)) continue;
        const match = data.pages.flatMap(page => page.data).find(product => product.id === id);
        if (match) return match;
    }
    return undefined;
}

/** A cheap string fingerprint of the currently-open product, if the cache has
 *  one — just enough to change when a rename or naming update lands, so the
 *  useSyncExternalStore subscription below knows to re-render. */
function cacheFingerprint(queryClient: QueryClient, openId: string | null): string {
    if (!openId) return '';
    const product = findCachedProduct(queryClient, openId);
    if (!product) return '';
    return `${product.id}:${product.name}:${product.namingStatus}:${product.images.map(image => image.fileId).join(',')}`;
}

/** Drive's Products tab is the product library itself — the same list, cards,
 *  naming, rename and delete as the composer — not a folder of files.
 *
 *  `<ProductsPanel>` stays mounted at all times, just hidden while a product
 *  is open: unmounting it would run its own cleanup, which commits every
 *  pending delete still inside its undo window and drops the in-progress
 *  search. */
export const DriveProducts = forwardRef<ProductsPanelHandle, {
    conversations: Conversation[];
    canAddToChat: boolean;
    onAddToChat: (attachments: Attachment[], conversationId: string | null) => void;
    onDownload: (fileId: string) => void;
    /** Page-level search bar (FilesList), same as every other Drive tab. */
    search: string;
    onSearchChange: (value: string) => void;
}>(function DriveProducts({ conversations, canAddToChat, onAddToChat, onDownload, search, onSearchChange }, ref) {
    const queryClient = useQueryClient();
    const [openId, setOpenId] = useState<string | null>(null);
    // Snapshot fallback only: if the product ever falls out of every cached
    // page (e.g. it no longer matches a search that ran while it was open),
    // the opened view still has something to show instead of blanking out.
    const openSnapshot = useRef(new Map<string, ProductRecord>());
    // Deriving `open` from the cache during render is not by itself reactive —
    // nothing here re-renders this component when the cache changes underneath
    // it (e.g. a rename or naming update lands while the product is open).
    // Subscribing to the query cache's own change events makes that happen;
    // the fingerprint value itself is unused beyond being the thing that changes.
    useSyncExternalStore(
        onChange => queryClient.getQueryCache().subscribe(onChange),
        () => cacheFingerprint(queryClient, openId),
        () => '',
    );
    const open = openId ? findCachedProduct(queryClient, openId) ?? openSnapshot.current.get(openId) ?? null : null;

    return <div className="space-y-4">
        <div hidden={openId !== null}>
            <ProductsPanel ref={ref} selected={null} onSelect={() => {}} hideHeading wide
                search={search} onSearchChange={onSearchChange}
                emptyHint="Paste a product link or drop photos to add your first product."
                onOpen={product => { openSnapshot.current.set(product.id, product); setOpenId(product.id); }} />
        </div>
        {open && <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => setOpenId(null)} aria-label="Back to products">
                    <ArrowLeft className="mr-1 h-4 w-4" />Products
                </Button>
                <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">{open.name}</h2>
                <AddToChatMenu variant="bulk" label="Add photos to chat" conversations={conversations} disabled={!canAddToChat}
                    onPick={conversationId => onAddToChat(open.images, conversationId)} />
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {open.images.map(image => <div key={image.fileId} className="min-w-0">
                    <div className="relative aspect-square overflow-hidden rounded-xl border border-border bg-muted">
                        <FileThumbnail fileId={image.fileId} alt="" />
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={image.name}>{image.name}</span>
                        <AddToChatMenu variant="icon" conversations={conversations} disabled={!canAddToChat}
                            onPick={conversationId => onAddToChat([image], conversationId)} />
                        {/* Per-photo download only: a bulk "Download photos" button called
                            onDownload once per image, but Drive's downloader opens each one
                            via window.open, and browsers allow only one popup per user
                            gesture — photos 2..N were silently blocked. */}
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Download ${image.name}`} onClick={() => onDownload(image.fileId)}>
                            <Download className="h-4 w-4" />
                        </Button>
                    </div>
                </div>)}
            </div>
        </div>}
    </div>;
});

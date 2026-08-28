"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// The API rate-limits at 60 requests/minute/tenant (apps/api/src/app.ts). One
// presigned-url fetch per card/tile with no bound meant any view listing 10+
// image files at once (the "#" file picker; a message with several image
// attachments) could burst past that limit — every 429 silently swallowed,
// so thumbnails just never appeared. Shared module-level state here (not
// per-component) so every consumer of this hook draws from the same budget
// instead of each screen assuming it owns the whole limit.
const MAX_CONCURRENT_THUMBNAIL_FETCHES = 4;
// Comfortably inside the presigned URL's own lifetime — a cached entry that
// outlived the signature would render a broken image instead of refetching.
const PRESIGNED_CACHE_TTL_MS = 5 * 60_000;

let activeThumbnailFetches = 0;
const thumbnailFetchQueue: Array<() => void> = [];
const presignedCache = new Map<string, { url: string; at: number }>();
const presignedInFlight = new Map<string, Promise<string | undefined>>();

function acquireThumbnailSlot(): Promise<void> {
    if (activeThumbnailFetches < MAX_CONCURRENT_THUMBNAIL_FETCHES) {
        activeThumbnailFetches++;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => {
        thumbnailFetchQueue.push(() => { activeThumbnailFetches++; resolve(); });
    });
}

function releaseThumbnailSlot() {
    activeThumbnailFetches--;
    thumbnailFetchQueue.shift()?.();
}

function getPresignedUrl(fileId: string): Promise<string | undefined> {
    const cached = presignedCache.get(fileId);
    if (cached && Date.now() - cached.at < PRESIGNED_CACHE_TTL_MS) return Promise.resolve(cached.url);

    const existing = presignedInFlight.get(fileId);
    if (existing) return existing;

    const request = acquireThumbnailSlot()
        .then(() => api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(fileId)}/presigned-url`))
        .then(res => {
            presignedCache.set(fileId, { url: res.presignedUrl, at: Date.now() });
            return res.presignedUrl as string | undefined;
        })
        .catch(() => undefined)
        .finally(() => {
            releaseThumbnailSlot();
            presignedInFlight.delete(fileId);
        });

    presignedInFlight.set(fileId, request);
    return request;
}

/** True once the element has been within 200px of the scroll viewport —
 *  latches on so a card that scrolls back out doesn't re-request its
 *  thumbnail. Pass a ref; returns true immediately if IntersectionObserver
 *  isn't available (e.g. a non-scrolling context that never needed lazy
 *  loading in the first place). */
export function useInView(ref: React.RefObject<HTMLElement | null>): boolean {
    const [inView, setInView] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (typeof IntersectionObserver === 'undefined') { setInView(true); return; }
        const observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) {
                setInView(true);
                observer.disconnect();
            }
        }, { rootMargin: '200px' });
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return inView;
}

/** Presigned thumbnail URL for an image file, rate-limit-safe: shares a
 *  cache + in-flight dedupe + concurrency cap across every consumer in the
 *  app. `enabled` gates the fetch (pair with useInView for lazy loading, or
 *  pass true for a small fixed list like a composer's attachment strip). */
export function useThumbnailUrl(fileId: string, enabled: boolean): string | undefined {
    const [url, setUrl] = useState<string | undefined>(undefined);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        getPresignedUrl(fileId).then(next => { if (!cancelled && next) setUrl(next); });
        return () => { cancelled = true; };
    }, [fileId, enabled]);
    return url;
}

/** Ref + in-view flag bundled together — the common case for a card that
 *  should only start fetching once it's actually visible. */
export function useLazyThumbnail<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const inView = useInView(ref);
    return { ref, inView };
}

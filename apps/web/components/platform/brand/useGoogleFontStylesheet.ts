'use client';

import { useEffect } from 'react';

// Module-scope so a family is never injected twice across every card/preview
// that asks for it, even across re-renders and remounts.
const injected = new Set<string>();

function hrefFor(family: string): string {
    const encoded = encodeURIComponent(family).replace(/%20/g, '+');
    return `https://fonts.googleapis.com/css2?family=${encoded}:wght@600&display=swap`;
}

/** Injects a Google Fonts `<link>` for each family in `families`, once per
 * family for the page's lifetime. Pass only the families actually visible
 * (a search result page, the one currently selected) — never the whole
 * list. No-ops outside the browser. */
export function useGoogleFontStylesheet(families: ReadonlyArray<string>): void {
    const key = families.filter(Boolean).join('|');
    useEffect(() => {
        if (typeof document === 'undefined' || !key) return;
        for (const family of key.split('|')) {
            if (injected.has(family)) continue;
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = hrefFor(family);
            document.head.appendChild(link);
            injected.add(family);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
}

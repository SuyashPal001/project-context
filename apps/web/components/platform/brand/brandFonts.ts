'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Figtree, Inter, JetBrains_Mono, Playfair_Display, Poppins, Space_Grotesk } from 'next/font/google';
import { useGoogleFontStylesheet } from './useGoogleFontStylesheet';
import type { BrandRecord } from './brandApi';

// The six curated font choices on the brand Look tab's Typography cards.
// Loaded once here (next/font/google calls must sit at module scope) and
// reused for both the card's big "Aa" sample and the live preview headline.
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const figtree = Figtree({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const poppins = Poppins({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const inter = Inter({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const playfairDisplay = Playfair_Display({ subsets: ['latin'], weight: '600', display: 'swap' });
const jetBrainsMono = JetBrains_Mono({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });

/** Font family name -> the next/font className that renders it. */
export const BRAND_FONT_CLASS: Record<string, string> = {
    'Space Grotesk': spaceGrotesk.className,
    Figtree: figtree.className,
    Poppins: poppins.className,
    Inter: inter.className,
    'Playfair Display': playfairDisplay.className,
    'JetBrains Mono': jetBrainsMono.className,
};

/** The font cards, in display order, each with a short subtitle. */
export const BRAND_FONT_CARDS: ReadonlyArray<{ name: string; subtitle: string }> = [
    { name: 'Space Grotesk', subtitle: 'Bold grotesk' },
    { name: 'Figtree', subtitle: 'Friendly sans' },
    { name: 'Poppins', subtitle: 'Geometric sans' },
    { name: 'Inter', subtitle: 'Clean sans' },
    { name: 'Playfair Display', subtitle: 'Elegant serif' },
    { name: 'JetBrains Mono', subtitle: 'Monospace' },
];

/** The CSS font-family name an uploaded brand font registers under. */
export const UPLOADED_FONT_FAMILY = 'BrandUpload';

// Module-scope: a font url, once registered with the FontFace API, stays
// registered for the page's lifetime — no need to redo it per component.
const registeredUrls = new Set<string>();

/**
 * Registers the brand's uploaded font (if any) as a FontFace so it can be
 * used by `fontFamily: UPLOADED_FONT_FAMILY`. Returns whether it's ready to
 * render yet. No-ops in environments without FontFace (e.g. jsdom in tests).
 */
export function useUploadedFontFace(url: string | null | undefined): boolean {
    const [ready, setReady] = useState(() => !!url && registeredUrls.has(url));
    useEffect(() => {
        if (!url) { setReady(false); return; }
        if (registeredUrls.has(url)) { setReady(true); return; }
        if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
            setReady(false);
            return;
        }
        let cancelled = false;
        const face = new FontFace(UPLOADED_FONT_FAMILY, `url(${url})`);
        face.load()
            .then((loaded) => {
                if (cancelled) return;
                document.fonts.add(loaded);
                registeredUrls.add(url);
                setReady(true);
            })
            .catch(() => { if (!cancelled) setReady(false); });
        return () => { cancelled = true; };
    }, [url]);
    return ready;
}

/**
 * Resolves what style/className to apply for the brand's headline font,
 * across all three sources: a curated card (next/font className), a picked
 * Google font (injected stylesheet + inline fontFamily) or an uploaded font
 * (registered FontFace) — in that priority, uploaded always wins.
 */
export function useBrandHeadlineFont(brand: Pick<BrandRecord, 'headlineFont' | 'font'>): { className?: string; style?: CSSProperties } {
    const uploadedReady = useUploadedFontFace(brand.font?.url);
    const isCurated = !!brand.headlineFont && brand.headlineFont in BRAND_FONT_CLASS;
    const googleFamily = !brand.font && brand.headlineFont && !isCurated ? brand.headlineFont : null;
    useGoogleFontStylesheet(googleFamily ? [googleFamily] : []);

    if (brand.font) {
        return uploadedReady ? { style: { fontFamily: `'${UPLOADED_FONT_FAMILY}', sans-serif` } } : {};
    }
    if (isCurated) return { className: BRAND_FONT_CLASS[brand.headlineFont as string] };
    if (googleFamily) return { style: { fontFamily: `'${googleFamily}', sans-serif` } };
    return {};
}

'use client';

import { useState } from 'react';
import { AlertTriangle, Bookmark, ChevronRight, Heart, MessageCircle, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { COLOR_ROLES, type BrandRecord } from './brandApi';
import { BRAND_FONT_CLASS } from './brandFonts';

export type ColorRole = typeof COLOR_ROLES[number];

// Literal fallback hexes, used only for contrast math when a role is unset.
// The swatches themselves still render via the theme's CSS vars (var(--…))
// so they track light/dark mode live — these just approximate this app's
// default tokens closely enough for the readability check to be meaningful.
const FALLBACK_HEX = {
    primary: '#E69DB8',
    text: '#1A1A1A',
    background: '#F2F2F2',
    mutedForeground: '#8C8C8C',
};

function hexToRgb(hex: string): [number, number, number] {
    const v = hex.trim().replace(/^#/, '');
    const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
    const num = parseInt(full, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function channelLuminance(c: number): number {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
    return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two hex colours: 1 (identical) to 21 (black/white). */
export function contrastRatio(hexA: string, hexB: string): number {
    const lumA = relativeLuminance(hexToRgb(hexA));
    const lumB = relativeLuminance(hexToRgb(hexB));
    const lighter = Math.max(lumA, lumB);
    const darker = Math.min(lumA, lumB);
    return (lighter + 0.05) / (darker + 0.05);
}

/** White or black, whichever reads better against `hex`. */
function readableOnColor(hex: string): string {
    return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#FFFFFF') ? '#000000' : '#FFFFFF';
}

interface DraftColor { role: ColorRole; hex: string }

/** Resolves every role to a display value (brand hex, or the matching theme
 * CSS var when unset) and a literal hex (brand hex, or a fallback close to
 * that same theme token) used only for contrast math. A draft colour, if
 * any, overlays the saved record so the preview tracks a live pick. */
function resolveColors(brand: BrandRecord, draftColor?: DraftColor | null) {
    const colors = draftColor ? { ...brand.colors, [draftColor.role]: draftColor.hex } : brand.colors;
    const hasColors = COLOR_ROLES.some((r) => colors[r]);

    const primaryHex = colors.primary || FALLBACK_HEX.primary;
    const primary = colors.primary || 'var(--primary)';
    const secondaryHex = colors.secondary || primaryHex;
    const secondary = colors.secondary || primary;
    const accentHex = colors.accent || primaryHex;
    const accent = colors.accent || primary;
    const textHex = colors.text || FALLBACK_HEX.text;
    const text = colors.text || 'var(--foreground)';
    const backgroundHex = colors.background || FALLBACK_HEX.background;
    const background = colors.background || 'var(--muted)';
    const mutedHex = colors.muted || FALLBACK_HEX.mutedForeground;
    const muted = colors.muted || 'var(--muted-foreground)';

    const hardToRead = contrastRatio(textHex, backgroundHex) < 4.5;
    const buttonText = contrastRatio(primaryHex, backgroundHex) >= 4.5 ? background : readableOnColor(primaryHex);
    const headlineOnMedia = contrastRatio(backgroundHex, primaryHex) >= 4.5 ? background : readableOnColor(primaryHex);

    return {
        primary, primaryHex, secondary, secondaryHex, accent, accentHex,
        text, textHex, background, backgroundHex, muted, mutedHex,
        hasColors, hardToRead, buttonText, headlineOnMedia,
    };
}

interface Props {
    brand: BrandRecord;
    /** A role's colour being dragged/typed in its still-open picker, not yet
     * saved. Overlays `brand.colors` so the preview tracks the live pick
     * without the picker committing early. */
    draftColor?: DraftColor | null;
}

/** The caption/warning line that sits under the card (card itself never
 * owns copy about its own readability — that lives outside it). */
function PreviewCaption({ hardToRead, hasColors }: { hardToRead: boolean; hasColors: boolean }) {
    if (hardToRead) {
        return (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Your text colour is hard to read on your background.
            </p>
        );
    }
    return (
        <p className="text-xs text-muted-foreground">
            {hasColors ? 'Preview with your colours' : 'No brand colours yet — Olmo chooses them for you'}
        </p>
    );
}

/**
 * A premium, Instagram-sponsored-post-style card that shows every brand
 * colour in a realistic use: header (avatar + name), an edge-to-edge media
 * block with the headline overlaid, a CTA bar, an actions row and a
 * caption. Unset roles fall back to this app's own theme tokens, so the
 * card still looks like a real post before any brand colour is picked.
 */
export function BrandPreviewCard({ brand, draftColor }: Props) {
    const c = resolveColors(brand, draftColor);
    const fontClass = brand.headlineFont ? BRAND_FONT_CLASS[brand.headlineFont] : undefined;
    const brandName = brand.name?.trim() || 'Your brand';
    const logoUrl = brand.logo?.url ?? null;
    const mascotUrl = brand.mascot?.url ?? null;

    return (
        <div className="space-y-2">
            <div data-testid="brand-preview-card" className="w-72 overflow-hidden rounded-3xl border border-border/60 bg-card shadow-xl shadow-black/10 ring-1 ring-inset ring-white/5 dark:shadow-black/40">
                <div className="flex items-center gap-2 px-4 py-3">
                    <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold ring-1 ring-border transition-colors duration-300"
                        style={logoUrl ? undefined : { backgroundColor: c.primary, color: c.background }}
                    >
                        {logoUrl
                            ? <img src={logoUrl} alt="Logo" className="h-full w-full object-cover" />
                            : brandName[0]?.toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{brandName}</p>
                        <p className="text-[11px] text-muted-foreground">Sponsored</p>
                    </div>
                    <span className="shrink-0 text-muted-foreground">···</span>
                </div>

                <div
                    className="relative aspect-[4/5] overflow-hidden transition-colors duration-300"
                    style={{ backgroundImage: `linear-gradient(135deg, ${c.primary}, ${c.secondary})` }}
                >
                    <div
                        className="absolute inset-0 transition-colors duration-300"
                        style={{ backgroundImage: `radial-gradient(circle at 80% 20%, ${c.accent}59, transparent 60%)` }}
                    />
                    <span
                        className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-colors duration-300"
                        style={{ backgroundColor: c.accent, color: c.text }}
                    >
                        NEW
                    </span>
                    {mascotUrl && (
                        <img
                            src={mascotUrl} alt="Mascot"
                            className="pointer-events-none absolute bottom-3 right-3 w-[30%] object-contain drop-shadow-lg"
                        />
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-4 pb-4 pt-10">
                        <p
                            className={cn(
                                'text-xl font-semibold leading-tight transition-colors duration-300',
                                mascotUrl && 'max-w-[65%]',
                                fontClass,
                            )}
                            style={{ color: c.headlineOnMedia }}
                        >
                            Your headline here
                        </p>
                    </div>
                </div>

                <div
                    data-testid="brand-preview-cta"
                    className="flex items-center justify-between px-4 py-2.5 text-sm font-medium transition-colors duration-300"
                    style={{ backgroundColor: c.primary, color: c.buttonText }}
                >
                    <span>Shop now</span>
                    <ChevronRight className="h-4 w-4" />
                </div>

                <div className="flex items-center gap-3 px-4 pt-3 text-foreground">
                    <Heart className="h-5 w-5" />
                    <MessageCircle className="h-5 w-5" />
                    <Send className="h-5 w-5" />
                    <Bookmark className="ml-auto h-5 w-5" />
                </div>

                <div className="px-4 pb-4 pt-2 text-xs">
                    <span className="font-semibold text-foreground">{brandName} </span>
                    <span className="text-muted-foreground">A short line that backs it up</span>
                </div>
            </div>

            <PreviewCaption hardToRead={c.hardToRead} hasColors={c.hasColors} />
        </div>
    );
}

/** Below lg, the full card moves into a Sheet — this is the slim sticky bar
 * at the top of the Visuals tab that opens it. Shows just enough to judge
 * the brand at a glance: avatar + name, a 5-colour strip, an "Aa" sample in
 * the headline font, and a tiny "Shop now" pill. */
export function BrandPreviewMobileBar({ brand, draftColor }: Props) {
    const [open, setOpen] = useState(false);
    const c = resolveColors(brand, draftColor);
    const fontClass = brand.headlineFont ? BRAND_FONT_CLASS[brand.headlineFont] : undefined;
    const brandName = brand.name?.trim() || 'Your brand';
    const logoUrl = brand.logo?.url ?? null;
    const strip = [c.primary, c.secondary, c.accent, c.text, c.background];

    return (
        <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
                <button
                    type="button"
                    aria-label="Open brand preview"
                    className="sticky top-0 z-10 flex h-14 w-full items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur"
                >
                    <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold"
                        style={logoUrl ? undefined : { backgroundColor: c.primary, color: c.background }}
                    >
                        {logoUrl
                            ? <img src={logoUrl} alt="Logo" className="h-full w-full object-cover" />
                            : brandName[0]?.toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">{brandName}</span>
                    <span className="flex shrink-0 items-center gap-0.5">
                        {strip.map((hex, i) => (
                            <span key={i} className="h-2 w-4 rounded-full" style={{ backgroundColor: hex }} />
                        ))}
                    </span>
                    <span className={cn('shrink-0 text-base text-foreground', fontClass)} style={{ color: c.text }}>Aa</span>
                    <span
                        className="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium"
                        style={{ backgroundColor: c.primary, color: c.buttonText }}
                    >
                        Shop now
                    </span>
                </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-3xl">
                <SheetHeader>
                    <SheetTitle className="sr-only">Brand preview</SheetTitle>
                </SheetHeader>
                <div className="flex justify-center px-4 pb-6">
                    <BrandPreviewCard brand={brand} draftColor={draftColor} />
                </div>
            </SheetContent>
        </Sheet>
    );
}

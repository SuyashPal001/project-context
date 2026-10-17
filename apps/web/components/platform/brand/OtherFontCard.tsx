'use client';

import { useMemo, useState } from 'react';
import { Type } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { storeCreativeImage } from '../chat/creative-library/storeCreativeImage';
import { importErrorMessage, type BrandPatch, type BrandRecord } from './brandApi';
import { BRAND_FONT_CLASS, UPLOADED_FONT_FAMILY, useUploadedFontFace } from './brandFonts';
import { useGoogleFontStylesheet } from './useGoogleFontStylesheet';
import googleFontsData from './googleFonts.json';

const GOOGLE_FONTS = googleFontsData as ReadonlyArray<{ family: string; category: string }>;
const MAX_RESULTS = 50;
const MAX_FONT_BYTES = 5 * 1024 * 1024;
const BRAND_FONT_PREFIX = 'brand/fonts/';
const WEIGHT_WORD = /^(thin|extralight|ultralight|light|regular|normal|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|bolditalic)$/i;

/** "BrandSans-Bold.otf" -> "BrandSans" — strips the extension and a
 * trailing weight/style word. Good enough for display; the orchestrator
 * reads the real family name from the file itself. */
export function deriveFontFamilyName(filename: string): string {
    const base = filename.replace(/\.(ttf|otf)$/i, '');
    const parts = base.split(/[-_]+/).filter(Boolean);
    while (parts.length > 1 && WEIGHT_WORD.test(parts[parts.length - 1])) parts.pop();
    return parts.join(' ').trim() || base;
}

function GoogleFontRow({ family, category, onPick }: { family: string; category: string; onPick: (family: string) => void }) {
    return (
        <button type="button" onClick={() => onPick(family)}
            className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted/60">
            <span className="min-w-0 truncate text-base text-foreground" style={{ fontFamily: `'${family}', sans-serif` }}>
                Aa {family}
            </span>
            <span className="shrink-0 text-xs capitalize text-muted-foreground">{category}</span>
        </button>
    );
}

interface Props {
    brand: BrandRecord;
    onSave: (patch: BrandPatch) => void;
}

/** The "Other font" card's own trigger subtitle + "Aa" sample — selected
 * when an uploaded font exists, or headlineFont isn't one of the six
 * curated choices. */
export function otherFontSelected(brand: Pick<BrandRecord, 'headlineFont' | 'font'>): boolean {
    const isCurated = !!brand.headlineFont && brand.headlineFont in BRAND_FONT_CLASS;
    return !!brand.font || (!!brand.headlineFont && !isCurated);
}

/**
 * The "Other font" card: a Google Fonts search, and a .ttf/.otf upload for
 * a brand's own typeface. An uploaded font always wins over a picked one
 * (picking a Google font clears any upload).
 */
export function OtherFontCard({ brand, onSave }: Props) {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<'google' | 'upload'>('google');
    const [query, setQuery] = useState('');
    const [agree, setAgree] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isSelected = otherFontSelected(brand);
    const isCurated = !!brand.headlineFont && brand.headlineFont in BRAND_FONT_CLASS;
    const googleFamily = !brand.font && isSelected ? brand.headlineFont : null;
    const uploadedReady = useUploadedFontFace(brand.font?.url);

    const matches = useMemo(() => {
        const q = query.trim().toLowerCase();
        const pool = q ? GOOGLE_FONTS.filter((f) => f.family.toLowerCase().includes(q)) : GOOGLE_FONTS;
        return pool.slice(0, MAX_RESULTS);
    }, [query]);
    useGoogleFontStylesheet(matches.map((f) => f.family));
    useGoogleFontStylesheet(googleFamily ? [googleFamily] : []);

    const subtitle = brand.font
        ? `${brand.fontName ?? brand.headlineFont ?? 'Your font'} · uploaded`
        : isSelected ? (brand.headlineFont as string) : 'Any font you like';

    const sampleStyle = brand.font
        ? (uploadedReady ? { fontFamily: `'${UPLOADED_FONT_FAMILY}', sans-serif` } : undefined)
        : googleFamily ? { fontFamily: `'${googleFamily}', sans-serif` } : undefined;

    const pickGoogleFont = (family: string) => {
        setError(null);
        onSave({ headlineFont: family, fontFileId: null });
        setOpen(false);
    };

    const upload = async (file: File | undefined) => {
        if (!file) return;
        setError(null);
        if (!/\.(ttf|otf)$/i.test(file.name)) { setError('Upload a .ttf or .otf font file'); return; }
        if (file.size > MAX_FONT_BYTES) { setError('That font is larger than 5 MB.'); return; }
        setUploading(true);
        try {
            const stored = await storeCreativeImage(file, BRAND_FONT_PREFIX);
            onSave({ fontFileId: stored.fileId, headlineFont: deriveFontFamilyName(file.name) });
            setOpen(false);
        } catch (err) {
            setError(importErrorMessage(err, "Couldn't add that font. Try again."));
        } finally {
            setUploading(false);
        }
    };

    const handleOpenChange = (next: boolean) => {
        setOpen(next);
        if (next) { setError(null); setAgree(false); setQuery(''); setTab('google'); }
    };

    return (
        <Popover open={open} onOpenChange={handleOpenChange}>
            <PopoverTrigger asChild>
                <button type="button" aria-pressed={isSelected}
                    className={cn('rounded-xl bg-muted/40 p-4 text-left hover:bg-muted/60', isSelected && 'ring-2 ring-primary')}>
                    {isSelected
                        ? <p className="text-3xl text-foreground" style={sampleStyle}>Aa</p>
                        : <Type className="h-5 w-5 text-muted-foreground" />}
                    <p className="mt-2 text-sm font-medium text-foreground">Other font</p>
                    <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" collisionPadding={16} className="w-80 space-y-3 rounded-2xl p-4">
                <div role="tablist" className="flex w-fit gap-1 rounded-full bg-muted p-1">
                    {(['google', 'upload'] as const).map((key) => (
                        <button key={key} type="button" role="tab" aria-selected={tab === key}
                            onClick={() => { setTab(key); setError(null); }}
                            className={cn(
                                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                                tab === key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                            )}>
                            {key === 'google' ? 'Google Fonts' : 'Upload'}
                        </button>
                    ))}
                </div>

                {tab === 'google' ? (
                    <div className="space-y-2">
                        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search fonts" aria-label="Search Google Fonts" />
                        <div className="max-h-64 space-y-0.5 overflow-y-auto">
                            {matches.map((f) => <GoogleFontRow key={f.family} family={f.family} category={f.category} onPick={pickGoogleFont} />)}
                            {matches.length === 0 && (
                                <p className="px-2 py-4 text-center text-xs text-muted-foreground">No fonts match &quot;{query}&quot;.</p>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <label className="flex items-start gap-2 text-xs text-muted-foreground">
                            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" />
                            I have the right to use this font
                        </label>
                        <input type="file" accept=".ttf,.otf" disabled={!agree || uploading} aria-label="Upload font file"
                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void upload(f); }}
                            className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium disabled:opacity-50" />
                        {brand.font && <p className="text-xs text-muted-foreground">Current: {brand.fontName ?? 'your uploaded font'}</p>}
                    </div>
                )}
                {error && <p className="text-xs text-destructive">{error}</p>}
            </PopoverContent>
        </Popover>
    );
}

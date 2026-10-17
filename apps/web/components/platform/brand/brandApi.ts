import { api, ApiError } from '@/lib/api';

export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'text', 'background', 'muted'] as const;
export const FONT_CHOICES = ['Inter', 'Poppins', 'Space Grotesk', 'Figtree', 'Playfair Display', 'JetBrains Mono'] as const;

export interface BrandImageRef { fileId: string; url: string | null }
export interface BrandRecord {
    name: string | null; oneLiner: string | null; audience: string | null;
    region: string; toneWords: string[]; emojiPolicy: string;
    signaturePhrases: string[]; bannedPhrases: string[]; ctaExamples: string[]; voiceNotes: string | null;
    colors: Partial<Record<typeof COLOR_ROLES[number], string>>; headlineFont: string | null;
    logo: BrandImageRef | null; favicon: BrandImageRef | null; mascot: BrandImageRef | null;
    sourceType: 'website' | 'instagram' | 'chat' | null; sourceValue: string | null;
    importStatus: 'idle' | 'importing' | 'done' | 'failed'; importedAt: string | null;
    ready: boolean; missing: Array<'name' | 'audience' | 'voice'>; updatedAt: string;
}
export type BrandPatch = Partial<{
    name: string | null; oneLiner: string | null; audience: string | null; region: string;
    toneWords: string[]; emojiPolicy: string; signaturePhrases: string[]; bannedPhrases: string[];
    ctaExamples: string[]; voiceNotes: string | null;
    // null clears a role — the API merges this against what's saved and
    // deletes any role sent as null.
    colors: Partial<Record<typeof COLOR_ROLES[number], string | null>>; headlineFont: string | null;
    logoFileId: string | null; faviconFileId: string | null; mascotFileId: string | null;
}>;

export const BRAND_QUERY_KEY = ['brand'] as const;
export const BRAND_IMAGE_PREFIX = 'brand/';

/** Shape to feed the always-visible form before any row exists yet — the
 * first blur-save creates the real row; until then the fields just need
 * something well-typed to read from. Region defaults to India (the page no
 * longer shows it; Olmo can change it from chat). */
export const EMPTY_BRAND: BrandRecord = {
    name: null, oneLiner: null, audience: null, region: 'IN', toneWords: [], emojiPolicy: 'minimal',
    signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null, colors: {}, headlineFont: null,
    logo: null, favicon: null, mascot: null, sourceType: null, sourceValue: null, importStatus: 'idle',
    importedAt: null, ready: false, missing: ['name', 'audience', 'voice'], updatedAt: new Date(0).toISOString(),
};

export async function getBrand(): Promise<BrandRecord | null> {
    return (await api.get<{ data: BrandRecord | null }>('/api/v1/brand')).data;
}
export async function patchBrand(patch: BrandPatch): Promise<BrandRecord> {
    return (await api.patch<{ data: BrandRecord }>('/api/v1/brand', patch)).data;
}
export async function importBrand(value: string): Promise<BrandRecord> {
    return (await api.post<{ data: BrandRecord }>('/api/v1/brand/import', { value })).data;
}

const FORMAT_HINT = 'Paste a website link or an Instagram handle';

/** What to show when an import can't start: the API's format hint for a 400, else `fallback`. */
export function importErrorMessage(err: unknown, fallback: string): string {
    if (!(err instanceof ApiError) || err.status !== 400) return fallback;
    const message = err.data?.message;
    return typeof message === 'string' && message ? message : FORMAT_HINT;
}

/** "Filled from mamaearth.in · 2 days ago" */
export function sourceLine(brand: BrandRecord, now = new Date()): string | null {
    if (!brand.sourceValue || brand.sourceType === 'chat') return null;
    const shown = brand.sourceType === 'website' ? brand.sourceValue.replace(/^https:\/\//, '').replace(/\/$/, '') : brand.sourceValue;
    if (!brand.importedAt) return `Filled from ${shown}`;
    const days = Math.floor((now.getTime() - new Date(brand.importedAt).getTime()) / 86_400_000);
    const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    return `Filled from ${shown} · ${when}`;
}

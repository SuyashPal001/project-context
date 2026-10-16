import { api } from '@/lib/api';

export const BRAND_REGIONS = [
    { value: 'IN', label: 'India' }, { value: 'US', label: 'US' }, { value: 'UK', label: 'UK' },
    { value: 'AE', label: 'UAE' }, { value: 'SG', label: 'Singapore' }, { value: 'GLOBAL', label: 'Global' },
] as const;
export const EMOJI_POLICIES = [
    { value: 'none', label: 'None' }, { value: 'minimal', label: 'Minimal' },
    { value: 'moderate', label: 'Moderate' }, { value: 'expressive', label: 'Expressive' },
] as const;
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
    ctaExamples: string[]; voiceNotes: string | null; colors: BrandRecord['colors']; headlineFont: string | null;
    logoFileId: string | null; faviconFileId: string | null; mascotFileId: string | null;
}>;

export const BRAND_QUERY_KEY = ['brand'] as const;
export const BRAND_IMAGE_PREFIX = 'brand/';

export async function getBrand(): Promise<BrandRecord | null> {
    return (await api.get<{ data: BrandRecord | null }>('/api/v1/brand')).data;
}
export async function patchBrand(patch: BrandPatch): Promise<BrandRecord> {
    return (await api.patch<{ data: BrandRecord }>('/api/v1/brand', patch)).data;
}
export async function importBrand(value: string): Promise<BrandRecord> {
    return (await api.post<{ data: BrandRecord }>('/api/v1/brand/import', { value })).data;
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

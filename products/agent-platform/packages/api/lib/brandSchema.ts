import { z } from 'zod';

export const BRAND_REGIONS = ['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL'] as const;
export const EMOJI_POLICIES = ['none', 'minimal', 'moderate', 'expressive'] as const;
export const COLOR_ROLES = ['primary', 'secondary', 'accent', 'text', 'background', 'muted'] as const;
export type BrandRegion = typeof BRAND_REGIONS[number];
export type EmojiPolicy = typeof EMOJI_POLICIES[number];
export type ColorRole = typeof COLOR_ROLES[number];

const HEX = /^#[0-9A-Fa-f]{6}$/;
const line = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, items: number) => z.array(line(max)).max(items);
const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === '' ? null : v));

/**
 * Lenient colours: invalid hex values are dropped, not rejected (AI output
 * and old clients). `null` or `''` for a role is kept as a removal marker
 * (output `null`) so the caller can clear that role; `patchBrand` deletes
 * marked roles after merging with what's saved.
 */
export const colorsSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => {
    const out: Partial<Record<ColorRole, string | null>> = {};
    for (const role of COLOR_ROLES) {
      const v = raw[role];
      if (v === null || v === '') out[role] = null;
      else if (typeof v === 'string' && HEX.test(v.trim())) out[role] = v.trim().toUpperCase();
    }
    return out;
  });

/** What PATCH /brand and update_brand accept. Every key optional; null clears. */
export const brandPatchSchema = z.object({
  name: nullableText(80).optional(),
  oneLiner: nullableText(200).optional(),
  audience: nullableText(300).optional(),
  region: z.enum(BRAND_REGIONS).optional(),
  toneWords: list(30, 5).optional(),
  emojiPolicy: z.enum(EMOJI_POLICIES).optional(),
  signaturePhrases: list(80, 10).optional(),
  bannedPhrases: list(80, 30).optional(),
  ctaExamples: list(80, 10).optional(),
  voiceNotes: nullableText(3000).optional(),
  colors: colorsSchema.optional(),
  headlineFont: nullableText(60).optional(),
  logoFileId: z.string().uuid().nullable().optional(),
  faviconFileId: z.string().uuid().nullable().optional(),
  mascotFileId: z.string().uuid().nullable().optional(),
}).strict();
export type BrandPatch = z.infer<typeof brandPatchSchema>;

/** The fields an import may fill (never bannedPhrases, never images — those come separately). */
export const brandFillSchema = z.object({
  name: z.string().trim().max(80).default(''),
  oneLiner: z.string().trim().max(200).default(''),
  audience: z.string().trim().max(300).default(''),
  region: z.enum(BRAND_REGIONS).catch('IN'),
  toneWords: z.array(z.string().trim().max(30)).default([]).transform((a) => a.filter(Boolean).slice(0, 5)),
  emojiPolicy: z.enum(EMOJI_POLICIES).catch('minimal'),
  signaturePhrases: z.array(z.string().trim().max(80)).default([]).transform((a) => a.filter(Boolean).slice(0, 10)),
  ctaExamples: z.array(z.string().trim().max(80)).default([]).transform((a) => a.filter(Boolean).slice(0, 10)),
  voiceNotes: z.string().trim().max(3000).default(''),
  colors: colorsSchema.default({}),
  headlineFont: z.string().trim().max(60).default(''),
});
export type BrandFill = z.infer<typeof brandFillSchema>;

export interface BrandImageRef { fileId: string; url: string | null }

export interface BrandRecord {
  name: string | null;
  oneLiner: string | null;
  audience: string | null;
  region: BrandRegion;
  toneWords: string[];
  emojiPolicy: EmojiPolicy;
  signaturePhrases: string[];
  bannedPhrases: string[];
  ctaExamples: string[];
  voiceNotes: string | null;
  colors: Partial<Record<ColorRole, string>>;
  headlineFont: string | null;
  logo: BrandImageRef | null;
  favicon: BrandImageRef | null;
  mascot: BrandImageRef | null;
  sourceType: 'website' | 'instagram' | 'chat' | null;
  sourceValue: string | null;
  importStatus: 'idle' | 'importing' | 'done' | 'failed';
  importedAt: string | null;
  ready: boolean;
  missing: Array<'name' | 'audience' | 'voice'>;
  updatedAt: string;
}

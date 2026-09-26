import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

export interface VoiceAccent {
  accent: string;
  locale: string;
  is_native: boolean;
}

// Cached mirror of Cartesia's curated voice metadata, refreshed by
// scripts/refreshVoiceCatalogue.ts. Global catalogue — every tenant sees
// the same 8 voices — so this table is intentionally NOT tenant-scoped:
// no tenantId column, no queryScopeMiddleware (this table is read only
// from apps/web route handlers, which sit outside the Lambda API anyway).
export const voiceCatalogue = pgTable('voice_catalogue', {
  providerId: text('provider_id').primaryKey(), // Cartesia voice UUID
  name: text('name').notNull(),
  tagline: text('tagline').notNull(),
  language: text('language'),
  gender: text('gender'),
  country: text('country'),
  description: text('description'),
  accents: jsonb('accents').$type<VoiceAccent[]>(),
  previewFileUrl: text('preview_file_url'),
  localPreviewAsset: text('local_preview_asset'),
  // Populated on first-ever on-demand TTS generation for a (voice, language)
  // pair — see apps/web/app/api/creative/voices/preview/route.ts. Keyed by
  // language code (e.g. "es" -> S3 key) because the audio differs per
  // language; a single column would have one language's generation
  // overwrite another's pointer. Once a language's key is set, every later
  // request for that (voice, language) is served from S3 instead of calling
  // Cartesia again. Unlike previewFileUrl (Cartesia-hosted) and
  // localPreviewAsset (bundled in apps/web/public, English-only), this
  // covers every language and is the platform's own S3 object.
  generatedPreviewKeys: jsonb('generated_preview_keys').$type<Record<string, string>>(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
});

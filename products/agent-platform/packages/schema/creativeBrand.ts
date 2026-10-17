import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';
import { files } from '@serverless-saas/database/schema/storage';

// A workspace's ad brand: how it sounds and looks in everything Olmo makes.
// Deliberately NOT tenants.brandName/logoFileId/brandColor — those theme the
// app itself (white-label) and must not change when the ad brand changes.
// One row per tenant; a row exists only once something has been saved.
export type BrandColors = Partial<Record<'primary' | 'secondary' | 'accent' | 'text' | 'background' | 'muted', string>>;

export const creativeBrand = pgTable('creative_brand', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  // Nullable: an import creates the row before the name is known.
  name: text('name'),
  oneLiner: text('one_liner'),
  audience: text('audience'),
  region: text('region').notNull().default('IN'), // validated in Zod (lib/brandSchema.ts)
  toneWords: text('tone_words').array().notNull().default(sql`'{}'::text[]`),
  emojiPolicy: text('emoji_policy').notNull().default('minimal'), // validated in Zod
  signaturePhrases: text('signature_phrases').array().notNull().default(sql`'{}'::text[]`),
  bannedPhrases: text('banned_phrases').array().notNull().default(sql`'{}'::text[]`),
  ctaExamples: text('cta_examples').array().notNull().default(sql`'{}'::text[]`),
  voiceNotes: text('voice_notes'),
  colors: jsonb('colors').$type<BrandColors>().notNull().default(sql`'{}'::jsonb`),
  headlineFont: text('headline_font'),
  logoFileId: uuid('logo_file_id').references(() => files.id, { onDelete: 'set null' }),
  faviconFileId: uuid('favicon_file_id').references(() => files.id, { onDelete: 'set null' }),
  mascotFileId: uuid('mascot_file_id').references(() => files.id, { onDelete: 'set null' }),
  fontFileId: uuid('font_file_id').references(() => files.id, { onDelete: 'set null' }),
  sourceType: text('source_type'), // 'website' | 'instagram' | 'chat'
  sourceValue: text('source_value'),
  importStatus: text('import_status').notNull().default('idle'), // 'idle' | 'importing' | 'done' | 'failed'
  importError: text('import_error'), // for logs only, never shown raw
  importStartedAt: timestamp('import_started_at', { withTimezone: true }),
  importedAt: timestamp('imported_at', { withTimezone: true }),
  // API field names (camelCase) the user changed by hand or through update_brand.
  // An import never overwrites these.
  editedByUser: text('edited_by_user').array().notNull().default(sql`'{}'::text[]`),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  tenantUnique: uniqueIndex('creative_brand_tenant_unique').on(t.tenantId),
}));

export type CreativeBrand = typeof creativeBrand.$inferSelect;
export type NewCreativeBrand = typeof creativeBrand.$inferInsert;

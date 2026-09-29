import { pgTable, pgEnum, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { files } from '@serverless-saas/database/schema/storage';

// Platform-owned reusable creative assets (avatar presets today; product
// presets are the next planned kind — see attributes' free-form shape
// below). tenant_id is nullable — NULL = platform-owned, the exact
// convention creativeTemplates.ts already established. Seeded rows are
// platform-owned. A row with tenant_id set is a tenant's own avatar: its
// bytes are a normal `files` row (file_id), so it shows in that tenant's
// Drive and attaches to chat like any upload; this row adds the picker's
// name/role/tone on top.
//
// Unlike creativeTemplates (which only stores a *description* of a
// template — imageUrl there is a display-only static path, and the real
// reference image is deferred to a future referenceFileId), this table's
// storageKey points at a REAL S3 object from day one. Resolving an
// avatar to real bytes without going through the tenant-scoped `files`
// table is the actual problem this plan solves.
export const creativeLibraryAssetKindEnum = pgEnum('creative_library_asset_kind', ['avatar', 'product']);

export const creativeLibraryAssets = pgTable('creative_library_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  slug: text('slug').notNull(),
  kind: creativeLibraryAssetKindEnum('kind').notNull(),
  name: text('name').notNull(),
  // Free-form per-kind display fields (role/tone for avatar, category for
  // a future product preset) — avoids a rigid column per kind for a table
  // explicitly meant to grow more kinds later.
  attributes: jsonb('attributes').notNull().default({}),
  storageKey: text('storage_key').notNull(),
  // Set only on tenant-owned rows (NULL for platform presets, whose bytes
  // live outside the tenant-scoped files table). One asset per file.
  fileId: uuid('file_id').references(() => files.id).unique(),
  mimeType: text('mime_type').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date())
}, (t) => ({
  // .nullsNotDistinct() for the exact reason creativeTemplates.ts documents:
  // a plain unique() defaults to NULLS DISTINCT, so two (NULL, 'x') rows
  // would never collide and re-running the seed's ON CONFLICT would insert
  // duplicates instead of upserting.
  tenantSlugUniq: unique().on(t.tenantId, t.slug).nullsNotDistinct(),
}));

export type CreativeLibraryAsset = typeof creativeLibraryAssets.$inferSelect;
export type NewCreativeLibraryAsset = typeof creativeLibraryAssets.$inferInsert;

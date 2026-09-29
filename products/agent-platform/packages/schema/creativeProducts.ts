import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';

// A tenant's saved product for creative briefs. Deliberately NOT
// creative_library_assets: that table holds platform-owned presets with a
// single required storage_key outside the files table. A product is
// tenant-owned, has several images (files rows, so they stay in Drive) and a
// naming state for AI naming.
export const creativeProductNamingStatusEnum = pgEnum('creative_product_naming_status', ['pending', 'done', 'failed']);

export const creativeProducts = pgTable('creative_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  category: text('category'), // one of a small fixed list, validated in Zod (see lib/productCategories.ts) — not a DB enum, so adding a category is a code change, not a migration
  description: text('description'),
  price: text('price'),
  sourceUrl: text('source_url'),
  // Up to 3 selling points, validated in Zod. Postgres text[] has no length
  // constraint of its own — the cap is enforced at the API boundary.
  usps: text('usps').array().notNull().default(sql`'{}'::text[]`),
  // Ordered; the first id is the main image. No FK (Postgres can't FK array
  // elements) — reads drop ids whose files row is gone.
  imageFileIds: uuid('image_file_ids').array().notNull().default(sql`'{}'::uuid[]`),
  namingStatus: creativeProductNamingStatusEnum('naming_status').notNull().default('done'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  tenantCreatedIdx: index('creative_products_tenant_created_idx').on(t.tenantId, t.createdAt),
}));

export type CreativeProduct = typeof creativeProducts.$inferSelect;
export type NewCreativeProduct = typeof creativeProducts.$inferInsert;

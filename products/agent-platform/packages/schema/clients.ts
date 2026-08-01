import { pgTable, pgEnum, uuid, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';

export const clientStatusEnum = pgEnum('client_status', ['active', 'archived']);

// One row per client of the agency. The agency is the tenant; clients live
// beneath it so staff can query across all of their clients without a
// cross-tenant read. Brand fields are nullable overrides of the tenant's own
// branding — see resolveBranding() in the api package.
export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  brandName: text('brand_name'),
  logoUrl: text('logo_url'),
  brandColor: text('brand_color'),
  status: clientStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  tenantSlugUnique: unique('clients_tenant_slug_unique').on(t.tenantId, t.slug),
  tenantStatusIdx: index('clients_tenant_status_idx').on(t.tenantId, t.status),
}));

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;

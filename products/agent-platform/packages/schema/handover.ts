import { pgTable, pgEnum, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';
import { files } from '@serverless-saas/database/schema/storage';
import { projectPlans } from './pm';
import { clients } from './clients';

export const packStatusEnum = pgEnum('pack_status', ['draft', 'sent', 'signed', 'revoked']);
export const packSectionKindEnum = pgEnum('pack_section_kind', ['delivered', 'credentials', 'training', 'support', 'signoff']);
export const packItemSourceEnum = pgEnum('pack_item_source', ['manual', 'task', 'milestone', 'file']);

// One handover pack per project plan. tokenHash is the sha256 of the portal
// token; the raw token is returned exactly once at send time and never stored.
export const handoverPacks = pgTable('handover_packs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  planId: uuid('plan_id').notNull().references(() => projectPlans.id),
  clientId: uuid('client_id').references(() => clients.id),
  title: text('title').notNull(),
  scopeSummary: text('scope_summary'),
  deliveryDate: timestamp('delivery_date'),
  preparedBy: uuid('prepared_by').notNull().references(() => users.id),
  recipientName: text('recipient_name'),
  recipientEmail: text('recipient_email'),
  status: packStatusEnum('status').notNull().default('draft'),
  tokenHash: text('token_hash'),
  sentAt: timestamp('sent_at'),
  signedAt: timestamp('signed_at'),
  signedByName: text('signed_by_name'),
  signedByEmail: text('signed_by_email'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  tenantStatusIdx: index('handover_packs_tenant_status_idx').on(t.tenantId, t.status),
  tokenHashUniq: uniqueIndex('handover_packs_token_hash_uniq').on(t.tokenHash),
  planLiveUniq: uniqueIndex('handover_packs_plan_live_uniq').on(t.planId).where(sql`deleted_at is null`),
}));

// Five rows per pack, seeded from the template. Each pack owns its sections so
// titles and ordering are editable without affecting any other pack.
export const packSections = pgTable('pack_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  packId: uuid('pack_id').notNull().references(() => handoverPacks.id, { onDelete: 'cascade' }),
  kind: packSectionKindEnum('kind').notNull(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  eyebrow: text('eyebrow'),
  sortOrder: integer('sort_order').notNull().default(0),
  isVisible: boolean('is_visible').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  packKindUniq: uniqueIndex('pack_sections_pack_kind_uniq').on(t.packId, t.kind),
  packSortIdx: index('pack_sections_pack_sort_idx').on(t.packId, t.sortOrder),
}));

// The records inside a section. sourceType/sourceId record where a row came
// from — a human, or a task/milestone/file in the workspace. sourceId carries
// no foreign key because the referenced table varies by sourceType; this
// follows the precedent set by agent_tasks.milestone_id / plan_id.
export const packItems = pgTable('pack_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  packId: uuid('pack_id').notNull().references(() => handoverPacks.id, { onDelete: 'cascade' }),
  sectionId: uuid('section_id').notNull().references(() => packSections.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  statusLabel: text('status_label'),
  categoryLabel: text('category_label'),
  sourceType: packItemSourceEnum('source_type').notNull().default('manual'),
  sourceId: uuid('source_id'),
  fileId: uuid('file_id').references(() => files.id),
  url: text('url'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  sectionSortIdx: index('pack_items_section_sort_idx').on(t.sectionId, t.sortOrder),
  packIdx: index('pack_items_pack_idx').on(t.packId),
  sourceIdx: index('pack_items_source_idx').on(t.sourceType, t.sourceId),
}));

export type HandoverPack = typeof handoverPacks.$inferSelect;
export type NewHandoverPack = typeof handoverPacks.$inferInsert;
export type PackSection = typeof packSections.$inferSelect;
export type NewPackSection = typeof packSections.$inferInsert;
export type PackItem = typeof packItems.$inferSelect;
export type NewPackItem = typeof packItems.$inferInsert;

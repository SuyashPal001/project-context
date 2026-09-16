import { pgTable, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { files } from '@serverless-saas/database/schema/storage';

// Structured recreation contract for a creative-library template, consumed by
// the retrieve_template Mastra tool on Director. Distinct from agent_templates
// (agents.ts), which is an unrelated system for versioned agent system prompts
// — do not conflate the two tables.
//
// tenant_id is nullable — NULL = platform-owned, following the same
// convention agentTemplates already uses (agents.ts). Every row this ships
// with is platform-owned; tenant-authored templates are explicitly future
// scope, not built here.
export const creativeTemplates = pgTable('creative_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  description: text('description').notNull(),
  imageUrl: text('image_url').notNull(),
  // Populated only once Phase 2 (real reference-clip analysis) ships — null
  // for every row this plan creates.
  referenceFileId: uuid('reference_file_id').references(() => files.id),
  clonePrompt: text('clone_prompt').notNull(),
  negativePrompt: text('negative_prompt').notNull(),
  cloneNotes: text('clone_notes').notNull(),
  excludeInClone: text('exclude_in_clone').notNull(),
  // { aspectRatio: string, durationSeconds: number, resolution: string, fps: number }
  technical: jsonb('technical').notNull(),
  // Array<{ order: number, shotType: string, action: string, onScreenText?: string, audio?: string }>
  scenes: jsonb('scenes').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date())
}, (t) => ({
  // .nullsNotDistinct() [review, required]: a plain unique() on a nullable
  // column defaults to NULLS DISTINCT in Postgres, meaning two rows with
  // (NULL, 'offer') are NOT a conflict — the seed script's ON CONFLICT
  // (tenant_id, slug) would then never fire for any platform-owned row,
  // silently duplicating all 6 rows on every re-run instead of upserting.
  // nullsNotDistinct() emits PG15+'s UNIQUE NULLS NOT DISTINCT, which makes
  // (NULL, 'offer') collide with itself and ON CONFLICT work as intended.
  tenantSlugUniq: unique().on(t.tenantId, t.slug).nullsNotDistinct(),
}));

export type CreativeTemplate = typeof creativeTemplates.$inferSelect;
export type NewCreativeTemplate = typeof creativeTemplates.$inferInsert;

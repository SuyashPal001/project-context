import { pgTable, uuid, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from '@serverless-saas/database/schema/auth';
import { agents } from './agents';

export const personaStatusEnum = pgEnum('persona_status', ['draft', 'published']);
// Job-function category, one per persona — drives the Explore-page filter row.
// Not skill-based: see products/agent-platform/packages/api/seeds/personas.ts
// for the mapping. Default 'product' only exists so adding this column to a
// table with existing rows doesn't violate NOT NULL — every real persona's
// value is set explicitly by the seed's INSERT/UPDATE, not left on default.
export const personaCategoryEnum = pgEnum('persona_category', ['engineering', 'product', 'research', 'creative']);

export const personas = pgTable('personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull(),
  basePersonality: text('base_personality').notNull(),
  category: personaCategoryEnum('category').notNull().default('product'),
  skillTags: jsonb('skill_tags').$type<string[]>().notNull().default([]),
  // Hand-authored per official persona (no LLM generation) — see
  // docs/superpowers/specs/2026-09-05-agent-welcome-pills-design.md.
  // null = not yet authored; WelcomeView falls through to a per-type or
  // generic fallback in that case, so this column is safe to add before
  // every persona has a value.
  suggestedPrompts: jsonb('suggested_prompts').$type<Array<{ icon: string; label: string; promptText: string }> | null>(),
  exampleAssetUrl: text('example_asset_url'),
  exampleCaption: text('example_caption'),
  exampleAssetUrl2: text('example_asset_url_2'),
  exampleCaption2: text('example_caption_2'),
  // Core Files — composed into the runtime system prompt in this order:
  // identityFile, soulFile, agentsFile, bootstrapFile, then userFile as
  // context. Tenant-facing UI never returns their content for official
  // personas (see GET /agents/:id/core-files) — only MEMORY.md (agentMemories)
  // is tenant-visible/editable.
  identityFile: text('identity_file'),
  soulFile: text('soul_file'),
  agentsFile: text('agents_file'),
  bootstrapFile: text('bootstrap_file'),
  userFile: text('user_file'),
  isOfficial: boolean('is_official').notNull().default(true),
  status: personaStatusEnum('status').notNull().default('draft'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const personasRelations = relations(personas, ({ many }) => ({
  agents: many(agents),
}));

export type PersonaRow = typeof personas.$inferSelect;
export type NewPersonaRow = typeof personas.$inferInsert;

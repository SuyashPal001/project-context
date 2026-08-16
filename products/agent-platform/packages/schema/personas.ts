import { pgTable, uuid, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from '@serverless-saas/database/schema/auth';
import { agents } from './agents';

export const personaStatusEnum = pgEnum('persona_status', ['draft', 'published']);

export type PersonaAnimationStates = {
  idle: string;
  thinking: string;
  responding: string;
};

export const personas = pgTable('personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull(),
  basePersonality: text('base_personality').notNull(),
  skillTags: jsonb('skill_tags').$type<string[]>().notNull().default([]),
  animationStates: jsonb('animation_states').$type<PersonaAnimationStates | null>(),
  exampleAssetUrl: text('example_asset_url'),
  exampleCaption: text('example_caption'),
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

import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';
import { agents } from './agents';

// A Team is membership only for v1 — a name and a set of hired agents.
// No shared config or team-level execution; it exists so the Fire
// dependency check ("related to N Shifts, N Teams") has a real teamsCount.
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const teamMembers = pgTable('team_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  addedAt: timestamp('added_at').notNull().defaultNow(),
}, (t) => ({
  uniqueMember: unique().on(t.teamId, t.agentId),
}));

export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  agent: one(agents, { fields: [teamMembers.agentId], references: [agents.id] }),
}));

export type TeamRow = typeof teams.$inferSelect;
export type NewTeamRow = typeof teams.$inferInsert;
export type TeamMemberRow = typeof teamMembers.$inferSelect;

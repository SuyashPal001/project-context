import { pgTable, pgEnum, uuid, text, integer, boolean, jsonb, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';

export const skillVisibilityEnum = pgEnum('skill_visibility', ['private', 'public']);
export const skillVersionStatusEnum = pgEnum('skill_version_status', ['pending', 'ready', 'failed']);
// 'authored' is a skill written in the app (agent-generated SKILL.md), not
// imported from a package — it carries its content in the queue message and
// has no external source to point back at, so its sourceRef is null.
export const skillSourceTypeEnum = pgEnum('skill_source_type', ['zip', 'github', 'url', 'authored']);
export const skillInstallStatusEnum = pgEnum('skill_install_status', ['active', 'uninstalled']);

// One row per skill package. latestVersion is only bumped by the worker once
// a skill_versions row for that number reaches 'ready' — never at creation
// time, so a still-importing version never looks installable.
export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerTenantId: uuid('owner_tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  visibility: skillVisibilityEnum('visibility').notNull().default('private'),
  isOfficial: boolean('is_official').notNull().default(false),
  latestVersion: integer('latest_version').notNull().default(0),
  // Global across all tenants — "times installed", the product's only download
  // event. Deliberately NOT per-tenant, unlike skill_installs.run_count.
  downloadCount: integer('download_count').notNull().default(0),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  ownerSlugUniq: unique().on(t.ownerTenantId, t.slug),
  visibilityIdx: index('skills_visibility_idx').on(t.visibility),
  officialIdx: index('skills_official_idx').on(t.isOfficial),
}));

// Immutable once status = 'ready'. version is a per-skill auto-increment
// (computed by the caller as max(version)+1), not a global serial.
export const skillVersions = pgTable('skill_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  skillId: uuid('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  manifest: jsonb('manifest'),
  s3Prefix: text('s3_prefix').notNull(),
  sourceType: skillSourceTypeEnum('source_type').notNull(),
  sourceRef: text('source_ref'),
  status: skillVersionStatusEnum('status').notNull().default('pending'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  skillVersionUniq: unique().on(t.skillId, t.version),
  skillIdx: index('skill_versions_skill_idx').on(t.skillId),
}));

// npm-style pinned install: installedVersion only moves on an explicit
// POST /skills/:id/install/update call, never automatically.
export const skillInstalls = pgTable('skill_installs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  skillId: uuid('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  installedVersion: integer('installed_version').notNull(),
  autoUpdate: boolean('auto_update').notNull().default(false),
  status: skillInstallStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  // Per-tenant: incremented once per chat message sent while this install's
  // skill is attached to the agent. Tenant-scoped by construction, unlike
  // skills.download_count which is global.
  runCount: integer('run_count').notNull().default(0),
}, (t) => ({
  tenantSkillUniq: unique().on(t.tenantId, t.skillId),
  tenantStatusIdx: index('skill_installs_tenant_status_idx').on(t.tenantId, t.status),
}));

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type NewSkillVersion = typeof skillVersions.$inferInsert;
export type SkillInstall = typeof skillInstalls.$inferSelect;
export type NewSkillInstall = typeof skillInstalls.$inferInsert;

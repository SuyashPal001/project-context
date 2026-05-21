import { pgTable, uuid, text, bigint, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const githubInstallations = pgTable(
  'github_installations',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    tenantId:       uuid('tenant_id').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    accountLogin:   text('account_login').notNull(),
    accountType:    text('account_type').notNull(),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt:      timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    tenantIdx:       index('idx_github_installations_tenant').on(t.tenantId),
    installationIdx: uniqueIndex('idx_github_installations_installation').on(t.installationId),
  })
);

export const githubRepos = pgTable(
  'github_repos',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    tenantId:       uuid('tenant_id').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    repoOwner:      text('repo_owner').notNull(),
    repoName:       text('repo_name').notNull(),
    repoFullName:   text('repo_full_name').notNull(),
    defaultBranch:  text('default_branch').notNull().default('main'),
    status:         text('status').notNull().default('active'),
    lastSyncedAt:   timestamp('last_synced_at', { withTimezone: true }),
    createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt:      timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    tenantIdx:       index('idx_github_repos_tenant').on(t.tenantId),
    installationIdx: index('idx_github_repos_installation').on(t.installationId),
    uniqueRepo:      uniqueIndex('idx_github_repos_unique').on(t.tenantId, t.repoFullName),
  })
);

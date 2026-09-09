import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { files } from './storage';

export const sessionStatusEnum = pgEnum('session_status', ['active', 'invalidated']);
export const invalidatedReasonEnum = pgEnum('invalidated_reason', ['role_changed', 'suspended', 'logout', 'expired', 'tenant_deleted']);
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  cognitoId: text('cognito_id').notNull().unique(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  // Presigned S3 GET URLs expire (1hr, see storageService.getDownloadUrl) — storing
  // one directly here (the old avatarUrl text column) meant every avatar silently
  // broke an hour after being saved. Store the stable fileId instead and resolve a
  // fresh presigned URL at read time, same pattern agents.avatarFileId already uses.
  avatarFileId: uuid('avatar_file_id').references((): AnyPgColumn => files.id),
  personalIdentifier: text('personal_identifier').unique(),
  pendingTenantId: uuid('pending_tenant_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tenantId: uuid('tenant_id').notNull(),
  jwtId: text('jwt_id').notNull().unique(),
  status: sessionStatusEnum('status').notNull().default('active'),
  invalidatedAt: timestamp('invalidated_at'),
  invalidatedReason: invalidatedReasonEnum('invalidated_reason'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});


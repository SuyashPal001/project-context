import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { users } from './auth';

export const apiKeyTypeEnum = pgEnum('api_key_type', ['rest', 'mcp', 'oauth', 'agent']);
export const apiKeyStatusEnum = pgEnum('api_key_status', ['active', 'revoked']);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id'),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  type: apiKeyTypeEnum('type').notNull().default('rest'),
  permissions: text('permissions').array().notNull().default([]),
  status: apiKeyStatusEnum('status').notNull().default('active'),
  lastUsedAt: timestamp('last_used_at'),
  expiresAt: timestamp('expires_at'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
  revokedBy: uuid('revoked_by').references(() => users.id),
});

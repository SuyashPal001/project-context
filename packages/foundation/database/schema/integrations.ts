import { pgTable, uuid, text, timestamp, boolean, decimal, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { users } from './auth';

export const integrationStatusEnum = pgEnum('integration_status', ['active', 'disconnected', 'error']);
export const llmProviderEnum = pgEnum('llm_provider', ['openai', 'anthropic', 'mistral', 'openrouter', 'kimi', 'vertex']);
export const emailProviderEnum = pgEnum('email_provider', ['ses', 'sendgrid', 'resend', 'postmark']);
export const storageProviderEnum = pgEnum('storage_provider', ['s3', 'gcs', 'r2']);

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  provider: text('provider').notNull(),
  mcpServerUrl: text('mcp_server_url'),
  credentialsEnc: text('credentials_enc').notNull(),
  status: integrationStatusEnum('status').notNull().default('active'),
  permissions: text('permissions').array().notNull().default([]),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('integrations_tenant_provider_unique').on(table.tenantId, table.provider),
]);

export const llmProviders = pgTable('llm_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  provider: llmProviderEnum('provider').notNull(),
  model: text('model').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  costPerToken: decimal('cost_per_token', { precision: 10, scale: 8 }),
  displayName: text('display_name'),
  isPlatform: boolean('is_platform').notNull().default(false),
  status: text('status').notNull().default('live'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const emailProviders = pgTable('email_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  provider: emailProviderEnum('provider').notNull(),
  credentialsEnc: text('credentials_enc').notNull(),
  fromDomain: text('from_domain'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const storageProviders = pgTable('storage_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  provider: storageProviderEnum('provider').notNull(),
  bucket: text('bucket').notNull(),
  region: text('region'),
  credentialsEnc: text('credentials_enc').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

import {
  pgTable, uuid, bigint, text, timestamp, jsonb, boolean, integer,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenancy';
import { actorTypeEnum } from './billing';   // reuse - redeclaring emits a duplicate CREATE TYPE

export const creditAccounts = pgTable('credit_accounts', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  balanceMicro: bigint('balance_micro', { mode: 'bigint' }).notNull().default(sql`0`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditRates = pgTable('credit_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run'],
  }).notNull(),
  subject: text('subject').notNull().default('*'),
  version: integer('version').notNull().default(1),
  pricingSchema: jsonb('pricing_schema').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('credit_rates_subject_version_uq').on(t.resourceType, t.subject, t.version),
  index('credit_rates_active_idx').on(t.resourceType, t.subject).where(sql`is_active`),
]);

export const creditGrants = pgTable('credit_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => creditAccounts.tenantId),
  actorId: uuid('actor_id'),
  actorType: actorTypeEnum('actor_type'),
  grantType: text('grant_type', {
    enum: ['purchase', 'subscription', 'trial', 'admin', 'refund'],
  }).notNull(),
  amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),
  spentMicro: bigint('spent_micro', { mode: 'bigint' }).notNull().default(sql`0`),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (t) => [
  index('credit_grants_fifo_idx').on(t.tenantId, t.expiresAt, t.createdAt),
]);

export const creditLedger = pgTable('credit_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => creditAccounts.tenantId),
  actorId: uuid('actor_id'),
  actorType: actorTypeEnum('actor_type'),
  grantId: uuid('grant_id').references(() => creditGrants.id),
  kind: text('kind', {
    enum: ['grant', 'debit', 'refund', 'settle', 'expiry', 'adjust'],
  }).notNull(),
  amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),
  balanceAfterMicro: bigint('balance_after_micro', { mode: 'bigint' }).notNull(),
  jobId: uuid('job_id'),
  jobType: text('job_type'),
  rateId: uuid('rate_id').references(() => creditRates.id),
  rateVersion: integer('rate_version'),
  idempotencyKey: text('idempotency_key').notNull(),
  seq: integer('seq').notNull().default(0),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('credit_ledger_key_seq_uq').on(t.idempotencyKey, t.seq),
  index('credit_ledger_tenant_time_idx').on(t.tenantId, t.createdAt),
]);

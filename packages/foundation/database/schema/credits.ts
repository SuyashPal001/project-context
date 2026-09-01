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
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation'],
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
  // The key namespace is per-tenant: ops top-up keys are operator-chosen and
  // free-form, so the same string will legitimately be reused across tenants.
  uniqueIndex('credit_ledger_tenant_key_seq_uq').on(t.tenantId, t.idempotencyKey, t.seq),
  index('credit_ledger_tenant_time_idx').on(t.tenantId, t.createdAt),
]);

/**
 * Purchasable credit packs. A tenant buys a pack, never a raw credit count —
 * checkout takes a pack id, so a client cannot ask for ten million credits at
 * a price it also supplies.
 *
 * ---- Why the markup lives here and not in credit_rates ----
 * A credit costs 1 US cent of inference (credit_rates is seeded at cost) and
 * sells for 2. Doubling credit_rates instead would silently halve what every
 * plan allowance buys: 2,000 credits would stop being $20 of work. So credits
 * stay an honest unit of consumption — 1 credit = 1 cent of inference, always
 * — and the margin lives in `price_cents`, one visible number that can change
 * without touching the metering path.
 *
 * `credits` and `price_cents` are therefore NOT redundant: their ratio is the
 * margin, and nothing enforces 2x at the schema level because a promotion or a
 * volume tier is a price change, not a code change.
 */
export const creditPacks = pgTable('credit_packs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stable string key ('starter', 'standard', 'bulk') — what checkout accepts
  // and what a provider's session metadata carries, so the row's uuid never
  // has to travel to a third party.
  key: text('key').notNull(),
  name: text('name').notNull(),
  credits: integer('credits').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  // Retired packs stay for the payments that reference them; only active ones
  // are offered. Deactivating rather than deleting keeps an old sale
  // reconcilable to the price it was actually sold at.
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('credit_packs_key_uq').on(t.key),
  index('credit_packs_active_idx').on(t.isActive, t.sortOrder),
]);

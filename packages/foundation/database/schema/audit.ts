import { pgTable, uuid, text, timestamp, pgEnum, json, jsonb, varchar } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';

export const auditActorTypeEnum = pgEnum('audit_actor_type', ['human', 'agent', 'system']);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  actorId: text('actor_id').notNull(),
  actorType: auditActorTypeEnum('actor_type').notNull(),
  action: text('action').notNull(),
  resource: text('resource').notNull(),
  resourceId: uuid('resource_id'),
  metadata: json('metadata'),
  previousState: jsonb('previous_state'),
  newState: jsonb('new_state'),
  prevHash: varchar('prev_hash', { length: 64 }),
  entryHash: varchar('entry_hash', { length: 64 }),
  ipAddress: text('ip_address'),
  traceId: text('trace_id').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

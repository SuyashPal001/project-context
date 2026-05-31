import { pgTable, uuid, text, integer, jsonb, timestamp, varchar, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';

export const sensitivityLevelEnum = pgEnum('sensitivity_level', ['public', 'internal', 'confidential', 'restricted']);
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(',').map(Number);
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

// Opaque type so Drizzle knows the column exists but never tries to set or default it.
// The actual column is GENERATED ALWAYS AS (to_tsvector('english', content)) STORED —
// managed directly in SQL, not by Drizzle migrations.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const documents = pgTable('documents', {
  id:         uuid('id').primaryKey().defaultRandom(),
  tenantId:   uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  name:       text('name').notNull(),
  fileKey:    text('file_key'),
  mimeType:   text('mime_type'),
  status:          text('status').notNull().default('pending'),
  sensitivityLevel: sensitivityLevelEnum('sensitivity_level').notNull().default('internal'),
  hash:            varchar('hash', { length: 64 }).notNull(),
  chunkCount: integer('chunk_count').notNull().default(0),
  error:      text('error'),
  metadata:   jsonb('metadata'),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantHashUniq: uniqueIndex('idx_docs_tenant_hash').on(t.tenantId, t.hash),
}));

export const documentChunks = pgTable('document_chunks', {
  id:         uuid('id').primaryKey(),
  tenantId:   uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  content:         text('content').notNull(),
  sensitivityLevel: sensitivityLevelEnum('sensitivity_level').notNull().default('internal'),
  embedding:       vector('embedding'),
  tsv:             tsvector('tsv'),
  chunkIndex:      integer('chunk_index').notNull(),
  metadata:   jsonb('metadata'),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index('idx_chunks_tenant').on(t.tenantId),
  docIdx:    index('idx_chunks_doc').on(t.documentId),
}));

export const embeddingCache = pgTable('embedding_cache', {
  hash:      varchar('hash', { length: 64 }).notNull(),
  provider:  varchar('provider', { length: 50 }).notNull(),
  model:     varchar('model', { length: 200 }).notNull(),
  embedding: vector('embedding').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

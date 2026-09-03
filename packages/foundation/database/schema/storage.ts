import { pgTable, uuid, varchar, integer, timestamp, pgEnum, jsonb, text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenancy';
import { users } from './auth';

// pending: created, awaiting an admin's verify action before ingestion is allowed.
// verified: admin has confirmed the folder's identity — files can be ingested.
export const personFolderStatusEnum = pgEnum('person_folder_status', ['pending', 'verified']);

export const personFolders = pgTable('person_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  identifier: text('identifier').notNull(),
  displayName: text('display_name'),
  status: personFolderStatusEnum('status').notNull().default('pending'),
  // Nullable, not required — this column is new on an existing table (see
  // integrations.ts for the same pattern) and can't assume zero pre-existing
  // rows, unlike status which has a safe default to backfill against.
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdentifierUniq: uniqueIndex('person_folders_tenant_identifier_uniq').on(t.tenantId, t.identifier),
  tenantIdx: index('person_folders_tenant_idx').on(t.tenantId),
}));

// File status enum
// `expired` is kept distinct from `deleted` so the two populations stay
// separable: `deleted` means a user removed a real file, `expired` means an
// upload was presigned but never confirmed and its bytes are being reclaimed.
export const fileStatusEnum = pgEnum('file_status', ['pending', 'uploaded', 'deleted', 'expired']);
export const ingestionStatusEnum = pgEnum('ingestion_status', ['pending', 'processing', 'done', 'failed']);

// Files table - tracks uploaded files metadata
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  key: varchar('key', { length: 512 }).notNull(), // S3 key: {tenantId}/{id}/{filename}
  size: integer('size'), // bytes, set after upload confirmed
  mimeType: varchar('mime_type', { length: 127 }),
  status: fileStatusEnum('status').notNull().default('pending'),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Ingestion metadata
  formatDetected: varchar('format_detected', { length: 64 }),
  // The uploading tenant's display name, stamped on at ingest time (see
  // fileIngest.ts) — not a real office/branch code despite the column name's
  // history; kept as a plain workspace label.
  workspaceName: varchar('workspace_name', { length: 32 }),
  classification: varchar('classification', { length: 32 }).default('Confidential'),
  chunkCount: integer('chunk_count').default(0),
  ingestionStatus: ingestionStatusEnum('ingestion_status').default('pending'),
  extractedFields: jsonb('extracted_fields'),
  personFolderId: uuid('person_folder_id').references(() => personFolders.id),
});

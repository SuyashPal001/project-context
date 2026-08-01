import { pgTable, pgEnum, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';
import { agentTasks } from './agents';

export const revisionActorTypeEnum = pgEnum('revision_actor_type', ['human', 'agent']);

// Append-only ledger of every change to an intent-carrying task field.
// One row per (task, field, change). Ordered by createdAt — there is
// deliberately no revision_number, which would need a lock to allocate.
// Shape follows saarthi-ai's training_examples: the (original, corrected)
// pair plus who made it is what turns an edit into a training signal.
export const taskRevisions = pgTable('task_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  originalContent: jsonb('original_content'),
  correctedContent: jsonb('corrected_content'),
  wasEdited: boolean('was_edited').notNull(),
  actorType: revisionActorTypeEnum('actor_type').notNull(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  taskCreatedAtIdx: index('task_revisions_task_created_at_idx').on(t.taskId, t.createdAt),
  tenantFieldIdx: index('task_revisions_tenant_field_idx').on(t.tenantId, t.field),
}));

export type TaskRevision = typeof taskRevisions.$inferSelect;
export type NewTaskRevision = typeof taskRevisions.$inferInsert;

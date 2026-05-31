import { pgTable, uuid, text, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { users } from '@serverless-saas/database/schema/auth';
import { tenants } from '@serverless-saas/database/schema/tenancy';

export const fairnessStatusEnum = pgEnum('fairness_status', ['pass', 'warn', 'fail']);

export interface FairnessCheckResult {
  checkId: string;
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export const agentFairnessReviews = pgTable('agent_fairness_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  runBy: uuid('run_by').notNull().references(() => users.id),
  runAt: timestamp('run_at').notNull().defaultNow(),
  overallStatus: fairnessStatusEnum('overall_status').notNull(),
  checkResults: jsonb('check_results').$type<FairnessCheckResult[]>().notNull(),
  notes: text('notes'),
}, (t) => ({
  agentIdx: index('fairness_reviews_agent_idx').on(t.agentId),
  tenantIdx: index('fairness_reviews_tenant_idx').on(t.tenantId),
}));

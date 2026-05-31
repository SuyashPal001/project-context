import { pgTable, uuid, text, decimal, integer, timestamp, index } from 'drizzle-orm/pg-core'

export const tokenCosts = pgTable('token_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  agentId: text('agent_id'),
  workflowId: text('workflow_id'),
  runId: text('run_id'),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: decimal('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  tenantTimeIdx: index('token_costs_tenant_time_idx').on(t.tenantId, t.createdAt),
  workflowIdx: index('token_costs_workflow_idx').on(t.workflowId),
}))

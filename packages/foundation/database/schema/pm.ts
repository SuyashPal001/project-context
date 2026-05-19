import {
    pgTable, pgEnum, uuid, text, integer, timestamp, jsonb, decimal,
    primaryKey, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { taskPriorityEnum, agents } from './agents';
import { tenants } from './tenancy';
import { users } from './auth';

// ── Sequence counters ─────────────────────────────────────────────────────────
// One row per (tenantId, resource). Atomically incremented on every insert
// via INSERT ... ON CONFLICT DO UPDATE SET last_seq = last_seq + 1 RETURNING.
// resource values: 'plan' | 'milestone' | 'task'

export const tenantCounters = pgTable('tenant_counters', {
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    resource: text('resource').notNull(),
    lastSeq:  integer('last_seq').notNull().default(0),
}, (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.resource] }),
}));

// ── Plans ─────────────────────────────────────────────────────────────────────

export const planStatusEnum = pgEnum('plan_status', ['draft', 'active', 'completed', 'archived']);

export const projectPlans = pgTable('project_plans', {
    id:          uuid('id').primaryKey().defaultRandom(),
    tenantId:    uuid('tenant_id').notNull().references(() => tenants.id),
    sequenceId:  integer('sequence_id').notNull(),
    title:       text('title').notNull(),
    description: text('description'),
    status:      planStatusEnum('status').notNull().default('draft'),
    startDate:   timestamp('start_date'),
    targetDate:  timestamp('target_date'),
    createdBy:   uuid('created_by').notNull().references(() => users.id),
    deletedAt:   timestamp('deleted_at'),
    createdAt:   timestamp('created_at').notNull().defaultNow(),
    updatedAt:   timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
    tenantStatusIdx: index('project_plans_tenant_status_idx').on(t.tenantId, t.status),
    tenantSeqUniq:   uniqueIndex('project_plans_tenant_seq_uniq').on(t.tenantId, t.sequenceId),
}));

// ── Milestones ────────────────────────────────────────────────────────────────

export const milestoneStatusEnum = pgEnum('milestone_status', ['backlog', 'in_progress', 'completed', 'cancelled']);

export const projectMilestones = pgTable('project_milestones', {
    id:          uuid('id').primaryKey().defaultRandom(),
    tenantId:    uuid('tenant_id').notNull().references(() => tenants.id),
    planId:      uuid('plan_id').notNull().references(() => projectPlans.id),
    sequenceId:  integer('sequence_id').notNull(),
    title:       text('title').notNull(),
    description: text('description'),
    status:      milestoneStatusEnum('status').notNull().default('backlog'),
    startDate:   timestamp('start_date'),
    targetDate:  timestamp('target_date'),
    completedAt: timestamp('completed_at'),
    assigneeId:  uuid('assignee_id').references(() => users.id),
    priority:           taskPriorityEnum('priority').notNull().default('medium'),
    acceptanceCriteria: jsonb('acceptance_criteria').notNull().default([]).$type<{ text: string; checked: boolean }[]>(),
    estimatedHours:     decimal('estimated_hours', { precision: 6, scale: 2 }),
    createdBy:   uuid('created_by').notNull().references(() => users.id),
    deletedAt:   timestamp('deleted_at'),
    createdAt:   timestamp('created_at').notNull().defaultNow(),
    updatedAt:   timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
    planStatusIdx:  index('project_milestones_plan_status_idx').on(t.planId, t.status),
    tenantSeqUniq:  uniqueIndex('project_milestones_tenant_seq_uniq').on(t.tenantId, t.sequenceId),
}));

export type ProjectPlan      = typeof projectPlans.$inferSelect;
export type NewProjectPlan   = typeof projectPlans.$inferInsert;
export type ProjectMilestone = typeof projectMilestones.$inferSelect;
export type NewProjectMilestone = typeof projectMilestones.$inferInsert;

// ── Agent PRDs ────────────────────────────────────────────────────────────────

export const prdStatusEnum = pgEnum('prd_status', ['draft', 'pending_approval', 'approved', 'rejected']);
export const prdContentTypeEnum = pgEnum('prd_content_type', ['markdown', 'html']);

export const agentPrds = pgTable('agent_prds', {
    id:                 uuid('id').primaryKey().defaultRandom(),
    tenantId:           uuid('tenant_id').notNull().references(() => tenants.id),
    agentId:            uuid('agent_id').notNull().references(() => agents.id),
    title:              text('title').notNull(),
    content:            text('content').notNull(),
    contentType:        prdContentTypeEnum('content_type').notNull().default('markdown'),
    status:             prdStatusEnum('status').notNull().default('draft'),
    version:            integer('version').notNull().default(1),
    createdFromTaskIds: uuid('created_from_task_ids').array(),
    createdAt:          timestamp('created_at').notNull().defaultNow(),
    updatedAt:          timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
    tenantAgentIdx: index('agent_prds_tenant_agent_idx').on(t.tenantId, t.agentId),
    tenantStatusIdx: index('agent_prds_tenant_status_idx').on(t.tenantId, t.status),
}));

export type AgentPrd    = typeof agentPrds.$inferSelect;
export type NewAgentPrd = typeof agentPrds.$inferInsert;

import { pgTable, uuid, text, timestamp, boolean, integer, decimal, pgEnum, index, uniqueIndex, customType } from 'drizzle-orm/pg-core';
import { json, jsonb } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() { return 'vector(768)'; },
  toDriver(value: number[]): string { return `[${value.join(',')}]`; },
  fromDriver(value: string): number[] { return value.slice(1, -1).split(',').map(Number); },
});
import { tenants } from './tenancy';
import { users } from './auth';

export const workflowTriggerEnum = pgEnum('workflow_trigger', ['incident_created', 'scheduled', 'manual']);
export const workflowStatusEnum = pgEnum('workflow_status', ['active', 'paused', 'archived']);
export const workflowRunStatusEnum = pgEnum('workflow_run_status', ['running', 'completed', 'failed', 'awaiting_approval']);

export const agentTypeEnum = pgEnum('agent_type', ['ops', 'support', 'billing', 'custom']);
export const agentStatusEnum = pgEnum('agent_status', ['active', 'paused', 'retired']);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  type: agentTypeEnum('type').notNull(),
  model: text('model'),
  status: agentStatusEnum('status').notNull().default('active'),
  apiKeyId: uuid('api_key_id').notNull(),
  llmProviderId: uuid('llm_provider_id'),
  avatarUrl: text('avatar_url'),
  description: text('description'),
  isInternal: boolean('is_internal').notNull().default(false),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const agentWorkflows = pgTable('agent_workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: uuid('agent_id').notNull(),
  name: text('name').notNull(),
  trigger: workflowTriggerEnum('trigger').notNull(),
  steps: json('steps').notNull().default([]),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  llmProviderId: uuid('llm_provider_id'),
  temperature: decimal('temperature', { precision: 3, scale: 2 }),
  maxTokens: integer('max_tokens'),
  systemPrompt: text('system_prompt'),
  status: workflowStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const agentWorkflowRuns = pgTable('agent_workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowId: uuid('workflow_id').notNull().references(() => agentWorkflows.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: uuid('agent_id').notNull(),
  trigger: text('trigger').notNull(),
  stepsCompleted: json('steps_completed').notNull().default([]),
  toolsCalled: json('tools_called').notNull().default([]),
  insights: text('insights'),
  actionsTaken: json('actions_taken').notNull().default([]),
  humanApproved: boolean('human_approved'),
  approvedBy: uuid('approved_by').references(() => users.id),
  status: workflowRunStatusEnum('status').notNull().default('running'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
});

// ── Agent Scrum Board ─────────────────────────────────────────────────────────

export const taskStatusEnum = pgEnum('task_status', ['backlog', 'todo', 'planning', 'awaiting_approval', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled']);
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high', 'urgent']);
export const taskStepStatusEnum = pgEnum('task_step_status', ['pending', 'running', 'done', 'skipped', 'failed']);
export const taskEventActorTypeEnum = pgEnum('task_event_actor_type', ['agent', 'human', 'system']);
export const taskEventTypeEnum = pgEnum('task_event_type', ['status_changed', 'step_completed', 'step_failed', 'clarification_requested', 'clarification_answered', 'plan_proposed', 'plan_approved', 'plan_rejected', 'task_cancelled', 'comment', 'comment_added']);
export const taskCommentAuthorTypeEnum = pgEnum('task_comment_author_type', ['member', 'agent']);

export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: uuid('agent_id').references(() => agents.id),
  assigneeId: uuid('assignee_id').references(() => users.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  title: text('title').notNull(),
  description: text('description'),
  descriptionHtml: text('description_html'),
  acceptanceCriteria: jsonb('acceptance_criteria').notNull().default([]),
  status: taskStatusEnum('status').notNull().default('backlog'),
  priority: taskPriorityEnum('priority').default('medium'),
  estimatedHours: decimal('estimated_hours', { precision: 5, scale: 2 }),
  confidenceScore: decimal('confidence_score', { precision: 3, scale: 2 }),
  planApprovedAt: timestamp('plan_approved_at'),
  planApprovedBy: uuid('plan_approved_by').references(() => users.id),
  blockedReason: text('blocked_reason'),
  cancelReason: text('cancel_reason'),
  startDate: timestamp('start_date'),
  dueDate: timestamp('due_date'),
  upvotes: integer('upvotes').notNull().default(0),
  downvotes: integer('downvotes').notNull().default(0),
  referenceText: text('reference_text'),
  links: jsonb('links').$type<string[]>().default([]),
  attachmentFileIds: text('attachment_file_ids').array().notNull().default([]),
  sortOrder: integer('sort_order').default(0),
  mastraRunId: text('mastra_run_id'),
  // PM hierarchy fields (added migration 0021)
  // milestoneId/planId are plain uuid — FK constraints in migration SQL to avoid circular imports with pm.ts
  sequenceId:   integer('sequence_id'),
  milestoneId:  uuid('milestone_id'),
  planId:       uuid('plan_id'),
  parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => agentTasks.id),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  embedding: vector('embedding'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  tenantStatusIdx:  index('agent_tasks_tenant_status_idx').on(t.tenantId, t.status),
  tenantAgentIdx:   index('agent_tasks_tenant_agent_idx').on(t.tenantId, t.agentId),
  tenantCreatedByIdx: index('agent_tasks_tenant_created_by_idx').on(t.tenantId, t.createdBy),
  milestoneIdx:     index('agent_tasks_milestone_idx').on(t.milestoneId),
  planIdx:          index('agent_tasks_plan_idx').on(t.planId),
}));

export const taskSteps = pgTable('task_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  stepNumber: integer('step_number').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  toolName: text('tool_name'),
  reasoning: text('reasoning'),
  status: taskStepStatusEnum('status').notNull().default('pending'),
  estimatedHours: decimal('estimated_hours', { precision: 4, scale: 2 }),
  confidenceScore: decimal('confidence_score', { precision: 3, scale: 2 }),
  humanFeedback: text('human_feedback'),
  feedbackHistory: jsonb('feedback_history').$type<Array<{ round: number; feedback: string; generalInstruction: string | null; replannedAt: string }>>().notNull().default([]),
  agentOutput: text('agent_output'),
  summary: text('summary'),
  toolArgs: jsonb('tool_args'),
  toolResult: jsonb('tool_result'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  taskIdIdx: index('task_steps_task_id_idx').on(t.taskId),
  tenantStatusIdx: index('task_steps_tenant_status_idx').on(t.tenantId, t.status),
}));

export const taskEvents = pgTable('task_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  actorType: taskEventActorTypeEnum('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  eventType: taskEventTypeEnum('event_type').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  taskCreatedAtIdx: index('task_events_task_created_at_idx').on(t.taskId, t.createdAt),
  tenantEventTypeIdx: index('task_events_tenant_event_type_idx').on(t.tenantId, t.eventType),
}));

export const taskComments = pgTable('task_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => agentTasks.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  authorId: uuid('author_id').notNull(),
  authorType: taskCommentAuthorTypeEnum('author_type').notNull(),
  content: text('content').notNull(),
  contentHtml: text('content_html'),
  parentId: uuid('parent_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  taskIdIdx: index('task_comments_task_id_idx').on(t.taskId),
  tenantTaskIdx: index('task_comments_tenant_task_idx').on(t.tenantId, t.taskId),
}));

// ── Task Dependencies ─────────────────────────────────────────────────────────

export const taskDependencyRelationEnum = pgEnum('task_dependency_relation', ['blocks', 'blocked_by', 'start_before', 'finish_before']);

export const taskDependencies = pgTable('task_dependencies', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
  fromTaskId:   uuid('from_task_id').notNull().references(() => agentTasks.id),
  toTaskId:     uuid('to_task_id').notNull().references(() => agentTasks.id),
  relationType: taskDependencyRelationEnum('relation_type').notNull(),
  createdBy:    uuid('created_by').references(() => users.id),
  createdAt:    timestamp('created_at').notNull().defaultNow(),
  deletedAt:    timestamp('deleted_at'),
}, (t) => ({
  fromTaskIdx: index('task_dependencies_from_task_idx').on(t.fromTaskId),
  toTaskIdx:   index('task_dependencies_to_task_idx').on(t.toTaskId),
  tenantIdx:   index('task_dependencies_tenant_idx').on(t.tenantId),
}));

// ─── Tool Registry ───────────────────────────────────────────────

export const agentToolStakesEnum = pgEnum('agent_tool_stakes', [
  'low',       // read-only, no side effects
  'medium',    // writes to external system
  'high',      // irreversible action (send email, create record)
  'critical',  // destructive (delete, financial, access change)
])

export const agentTools = pgTable('agent_tools', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  // null = platform tool available to all tenants
  name: text('name').notNull(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  provider: text('provider'),           // 'gmail' | 'drive' | 'jira' etc
  parametersSchema: jsonb('parameters_schema'),  // JSON Schema for input
  stakes: agentToolStakesEnum('stakes').notNull().default('low'),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  maxRetries: integer('max_retries').notNull().default(1),
  timeoutMs: integer('timeout_ms').notNull().default(30_000),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const agentToolAssignments = pgTable(
  'agent_tool_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    toolId: uuid('tool_id').notNull().references(() => agentTools.id),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('agent_tool_assignments_unique')
      .on(t.agentId, t.toolId),
  })
)

// ─── Agent Template System ────────────────────────────────────────────────────
// Platform-level versioned agent prompts (ADR-030).
// No tenantId — owned by platform admins via Mission Control.

export const agentTemplateStatusEnum = pgEnum('agent_template_status', ['draft', 'published', 'archived'])

export const agentTemplates = pgTable('agent_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  systemPrompt: text('system_prompt').notNull(),
  tools: text('tools').array(),
  model: text('model'),
  version: integer('version').notNull().default(1),
  status: agentTemplateStatusEnum('status').notNull().default('draft'),
  config: jsonb('config'),
  publishedAt: timestamp('published_at'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

export type AgentTemplate = typeof agentTemplates.$inferSelect
export type NewAgentTemplate = typeof agentTemplates.$inferInsert

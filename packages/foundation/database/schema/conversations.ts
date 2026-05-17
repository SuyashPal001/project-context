import { pgTable, uuid, text, timestamp, boolean, integer, jsonb, pgEnum, unique, varchar, decimal } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tenants } from './tenancy';
import { users } from './auth';
import { agents } from './agents';

export const conversationStatusEnum = pgEnum('conversation_status', ['active', 'archived', 'escalated']);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  userId: uuid('user_id').references(() => users.id),
  externalUserId: text('external_user_id'),
  title: text('title'),
  status: conversationStatusEnum('status').notNull().default('active'),
  needsHuman: boolean('needs_human').notNull().default(false),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [conversations.tenantId],
    references: [tenants.id],
  }),
  agent: one(agents, {
    fields: [conversations.agentId],
    references: [agents.id],
  }),
  user: one(users, {
    fields: [conversations.userId],
    references: [users.id],
  }),
  messages: many(messages),
}));

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  role: messageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('tool_calls'),
  toolResults: jsonb('tool_results'),
  tokenCount: integer('token_count'),
  model: text('model'),
  attachments: jsonb('attachments'),
  artifactRef: jsonb('artifact_ref'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  tenant: one(tenants, {
    fields: [messages.tenantId],
    references: [tenants.id],
  }),
}));

export const agentSkillStatusEnum = pgEnum('agent_skill_status', ['active', 'archived']);

export const agentSkills = pgTable('agent_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  tools: text('tools').array().notNull().default([]),
  config: jsonb('config'),
  version: integer('version').notNull().default(1),
  status: agentSkillStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqueSkillVersion: unique().on(t.agentId, t.tenantId, t.name, t.version),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, {
    fields: [agentSkills.agentId],
    references: [agents.id],
  }),
  tenant: one(tenants, {
    fields: [agentSkills.tenantId],
    references: [tenants.id],
  }),
}));

export const agentPolicies = pgTable('agent_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  allowedActions: text('allowed_actions').array().notNull().default([]),
  blockedActions: text('blocked_actions').array().notNull().default([]),
  requiresApproval: text('requires_approval').array().notNull().default([]),
  maxTokensPerMessage: integer('max_tokens_per_message'),
  maxMessagesPerConversation: integer('max_messages_per_conversation'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqueAgentPolicy: unique().on(t.agentId, t.tenantId),
}));

export const agentPoliciesRelations = relations(agentPolicies, ({ one }) => ({
  agent: one(agents, {
    fields: [agentPolicies.agentId],
    references: [agents.id],
  }),
  tenant: one(tenants, {
    fields: [agentPolicies.tenantId],
    references: [tenants.id],
  }),
}));

// ── Evals tables ──────────────────────────────────────────────────────────────

export const conversationFeedback = pgTable('conversation_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  messageId: uuid('message_id').notNull(),
  userId: uuid('user_id').notNull(),
  rating: varchar('rating', { length: 4 }).notNull(),
  comment: text('comment'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const evalResults = pgTable('eval_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  messageId: uuid('message_id').notNull(),
  evalType: varchar('eval_type', { length: 20 }).notNull(),
  score: decimal('score', { precision: 3, scale: 2 }),
  reasoning: text('reasoning'),
  model: varchar('model', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow(),
});

export const conversationMetrics = pgTable('conversation_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').unique().notNull(),
  ragFired: boolean('rag_fired').default(false),
  ragChunksRetrieved: integer('rag_chunks_retrieved').default(0),
  responseTimeMs: integer('response_time_ms'),
  totalTokens: integer('total_tokens').default(0),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  totalCost: decimal('total_cost', { precision: 10, scale: 6 }).default('0'),
  userMessageCount: integer('user_message_count').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

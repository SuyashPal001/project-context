import { relations } from 'drizzle-orm';
import { users } from '@serverless-saas/database/schema/auth';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { agents, agentTasks, taskSteps, taskEvents, taskDependencies } from './agents';
import { githubInstallations, githubRepos } from './github';
import { conversations } from './conversations';

export const agentTasksRelations = relations(agentTasks, ({ one, many }) => ({
    tenant: one(tenants, {
        fields: [agentTasks.tenantId],
        references: [tenants.id],
    }),
    agent: one(agents, {
        fields: [agentTasks.agentId],
        references: [agents.id],
    }),
    createdByUser: one(users, {
        fields: [agentTasks.createdBy],
        references: [users.id],
        relationName: 'agentTasksCreatedBy',
    }),
    planApprovedByUser: one(users, {
        fields: [agentTasks.planApprovedBy],
        references: [users.id],
        relationName: 'agentTasksPlanApprovedBy',
    }),
    conversation: one(conversations, {
        fields: [agentTasks.conversationId],
        references: [conversations.id],
    }),
    steps: many(taskSteps),
    events: many(taskEvents),
    outgoingDependencies: many(taskDependencies, { relationName: 'fromTask' }),
    incomingDependencies: many(taskDependencies, { relationName: 'toTask' }),
}));

export const taskStepsRelations = relations(taskSteps, ({ one }) => ({
    task: one(agentTasks, {
        fields: [taskSteps.taskId],
        references: [agentTasks.id],
    }),
    tenant: one(tenants, {
        fields: [taskSteps.tenantId],
        references: [tenants.id],
    }),
}));

export const taskDependenciesRelations = relations(taskDependencies, ({ one }) => ({
    fromTask: one(agentTasks, {
        fields: [taskDependencies.fromTaskId],
        references: [agentTasks.id],
        relationName: 'fromTask',
    }),
    toTask: one(agentTasks, {
        fields: [taskDependencies.toTaskId],
        references: [agentTasks.id],
        relationName: 'toTask',
    }),
    createdByUser: one(users, {
        fields: [taskDependencies.createdBy],
        references: [users.id],
    }),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
    task: one(agentTasks, {
        fields: [taskEvents.taskId],
        references: [agentTasks.id],
    }),
    tenant: one(tenants, {
        fields: [taskEvents.tenantId],
        references: [tenants.id],
    }),
}));

export const githubInstallationsRelations = relations(githubInstallations, ({ one, many }) => ({
    tenant: one(tenants, {
        fields: [githubInstallations.tenantId],
        references: [tenants.id],
    }),
    repos: many(githubRepos),
}));

export const githubReposRelations = relations(githubRepos, ({ one }) => ({
    tenant: one(tenants, {
        fields: [githubRepos.tenantId],
        references: [tenants.id],
    }),
    installation: one(githubInstallations, {
        fields: [githubRepos.installationId],
        references: [githubInstallations.installationId],
    }),
}));

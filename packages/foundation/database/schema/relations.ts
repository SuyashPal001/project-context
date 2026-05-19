import { relations } from 'drizzle-orm';
import { users } from './auth';
import { memberships, tenants } from './tenancy';
import { roles } from './authorization';
import { agents, agentTasks, taskSteps, taskEvents, taskDependencies } from './agents';

export const membershipsRelations = relations(memberships, ({ one }) => ({
    user: one(users, {
        fields: [memberships.userId],
        references: [users.id],
    }),
    role: one(roles, {
        fields: [memberships.roleId],
        references: [roles.id],
    }),
    tenant: one(tenants, {
        fields: [memberships.tenantId],
        references: [tenants.id],
    }),
}));

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

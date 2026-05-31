import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { agentTasks, taskSteps, taskEvents } from '@serverless-saas/agent-schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

// GET /tasks — list tasks with optional filters
export async function handleListTasks(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agent_tasks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const statusFilter = c.req.query('status');
    const agentIdFilter = c.req.query('agentId');
    const parentTaskIdFilter = c.req.query('parentTaskId');

    // Internal states hidden from board unless explicitly requested via ?status=
    const boardCondition = !statusFilter
        ? sql`${agentTasks.status} NOT IN ('planning', 'awaiting_approval')`
        : eq(agentTasks.status, statusFilter as any);

    const taskList = await db.select()
        .from(agentTasks)
        .where(and(
            eq(agentTasks.tenantId, tenantId),
            boardCondition,
            agentIdFilter ? eq(agentTasks.agentId, agentIdFilter) : undefined,
            parentTaskIdFilter ? eq(agentTasks.parentTaskId, parentTaskIdFilter) : undefined,
        ))
        .orderBy(asc(agentTasks.sortOrder), desc(agentTasks.createdAt));

    const tasksWithCounts = await Promise.all(taskList.map(async (task: typeof agentTasks.$inferSelect) => {
        const [{ value: totalSteps }] = await db
            .select({ value: count() })
            .from(taskSteps)
            .where(eq(taskSteps.taskId, task.id));

        const [{ value: completedSteps }] = await db
            .select({ value: count() })
            .from(taskSteps)
            .where(and(eq(taskSteps.taskId, task.id), eq(taskSteps.status, 'done')));

        return { ...task, sortOrder: task.sortOrder ?? 0, totalSteps: Number(totalSteps), completedSteps: Number(completedSteps) };
    }));

    return c.json({ data: tasksWithCounts });
}

// GET /tasks/:taskId — fetch single task with steps and events
export async function handleGetTask(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agent_tasks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const taskId = c.req.param('taskId') as string;

    const task = (await db.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId),
        eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);

    const steps = await db.select().from(taskSteps).where(eq(taskSteps.taskId, taskId)).orderBy(asc(taskSteps.stepNumber));
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.createdAt));

    return c.json({ data: { task: { ...task, sortOrder: task.sortOrder ?? 0 }, steps, events } });
}

import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agentTasks, taskEvents } from '@serverless-saas/agent-schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import { pushWebSocketEvent } from '../lib/websocket';
import { publishToQueue } from '@serverless-saas/queue';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

// POST /tasks/:taskId/plan — manually trigger planning (task must be in todo)
export async function handlePlanTask(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const task = (await db.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'todo') return c.json({ error: 'Task must be in todo status to generate a plan' }, 400);
    if (!task.agentId) return c.json({ error: 'An agent must be assigned to generate a plan' }, 400);

    const [updatedTask] = await db.update(agentTasks)
        .set({ status: 'planning', updatedAt: new Date() })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)))
        .returning();

    await db.insert(taskEvents).values({
        taskId, tenantId, actorType: 'human', actorId: userId,
        eventType: 'status_changed', payload: { from: 'todo', to: 'planning' },
    });
    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'task_planning_initiated', resource: 'agent_task', resourceId: taskId, metadata: { agentId: task.agentId }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    console.log('[SQS] Publishing plan_task for task', taskId);
    try {
        await publishToQueue(process.env.AGENT_TASK_QUEUE_URL!, { type: 'plan_task', taskId, traceId: randomUUID() });
    } catch (sqsErr) {
        console.error('[SQS] plan_task publish failed for task', taskId, sqsErr);
        await db.update(agentTasks)
            .set({ status: 'blocked', blockedReason: 'Failed to queue task for planning. Please retry.', updatedAt: new Date() })
            .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
        return c.json({ error: 'Failed to queue task for planning. Please retry.' }, 502);
    }

    try {
        await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'planning' });
    } catch (wsErr) {
        console.error('WS push failed (non-fatal):', wsErr);
    }

    return c.json({ data: { task: { ...updatedTask, sortOrder: updatedTask.sortOrder ?? 0 } } });
}

// POST /tasks/:taskId/clarify — provide clarification for a blocked task
export async function handleClarifyTask(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const schema = z.object({ answer: z.string().min(1) });
    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'blocked') return c.json({ error: 'Task is not awaiting clarification' }, 400);

    const { answer } = result.data;

    await db.insert(taskEvents).values({
        taskId, tenantId, actorType: 'human', actorId: userId,
        eventType: 'clarification_answered', payload: { answer },
    });
    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'task_clarification_provided', resource: 'agent_task', resourceId: taskId, metadata: {}, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    const [updatedTask] = await db.update(agentTasks)
        .set({ status: 'planning', blockedReason: null, planApprovedAt: null, updatedAt: new Date() })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)))
        .returning();

    await db.insert(taskEvents).values({
        taskId, tenantId, actorType: 'system', actorId: 'system',
        eventType: 'status_changed', payload: { from: 'blocked', to: 'planning' },
    });

    console.log('[SQS] Publishing replan_task (clarification) for task', taskId);
    try {
        await publishToQueue(process.env.AGENT_TASK_QUEUE_URL!, {
            type: 'replan_task', taskId, traceId: randomUUID(), extraContext: 'User clarification: ' + answer,
        });
    } catch (sqsErr) {
        console.error('[SQS] replan_task (clarification) publish failed for task', taskId, sqsErr);
        await db.update(agentTasks)
            .set({ status: 'blocked', blockedReason: 'Failed to queue task for replanning. Please retry.', updatedAt: new Date() })
            .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
        return c.json({ error: 'Failed to queue task for replanning. Please retry.' }, 502);
    }

    try {
        await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'planning' });
    } catch (wsErr) {
        console.error('WS push failed (non-fatal):', wsErr);
    }

    return c.json({ data: { task: { ...updatedTask, sortOrder: updatedTask.sortOrder ?? 0 } } });
}

// POST /tasks/:taskId/vote — upvote or downvote a task
export async function handleVoteTask(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const schema = z.object({ type: z.enum(['up', 'down']) });
    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Invalid vote type' }, 400);

    const column = result.data.type === 'up' ? agentTasks.upvotes : agentTasks.downvotes;
    const [updated] = await db.update(agentTasks)
        .set({ [result.data.type === 'up' ? 'upvotes' : 'downvotes']: sql`${column} + 1` })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)))
        .returning();

    if (!updated) return c.json({ error: 'Task not found' }, 404);

    try {
        await db.insert(auditLog).values({
            tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'task_voted', resource: 'agent_task', resourceId: taskId,
            metadata: { type: result.data.type }, traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ data: updated });
}

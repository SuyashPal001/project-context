import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { agentTasks, taskComments, taskEvents } from '@serverless-saas/agent-schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { pushWebSocketEvent } from '../../lib/websocket';
import { publishToQueue } from '@serverless-saas/queue';
import { getCacheClient } from '@serverless-saas/cache';
import { isAuthorized, MAX_CLARIFICATION_ROUNDS } from './tasks.auth';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const authCheck = (c: Context<AppEnv>) =>
    !isAuthorized(c.req.header('x-internal-service-key') ?? '');

const fireNotification = async (sqsUrl: string | undefined, tenantId: string, messageType: string, actorId: string, recipientId: string, taskId: string, taskTitle: string) => {
    if (!sqsUrl) return;
    try {
        await publishToQueue(sqsUrl, { type: 'notification.fire', tenantId, messageType, actorId, actorType: 'agent', recipientIds: [recipientId], data: { taskId, taskTitle } });
    } catch (err) {
        console.error(`[task/${messageType}] notification publish failed (non-fatal):`, (err as Error).message);
    }
};

// POST /internal/tasks/:taskId/complete
export async function handleCompleteTask(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const parsed = z.object({ summary: z.string().optional(), tenantId: z.string().uuid().optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (parsed.data.tenantId && parsed.data.tenantId !== task.tenantId) return c.json({ error: 'Tenant mismatch' }, 403);

    const { tenantId, agentId } = task;
    const actorId = agentId ?? 'system';

    const [updatedTask] = await db.update(agentTasks)
        .set({ status: 'review', completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId), eq(agentTasks.status, 'in_progress')))
        .returning({ id: agentTasks.id });

    if (!updatedTask) return c.json({ error: 'Task is not in a completable state' }, 409);

    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'agent', actorId, eventType: 'status_changed', payload: { from: task.status, to: 'review', summary: parsed.data.summary ?? null } });
    db.insert(auditLog).values({ tenantId, actorId, actorType: 'agent', action: 'task_completed', resource: 'agent_task', resourceId: taskId, metadata: { summary: parsed.data.summary ?? null }, traceId: c.req.header('x-trace-id') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    try { await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'review' }); }
    catch (wsErr) { console.error('WS push failed (non-fatal):', wsErr); }

    getCacheClient().del(`task:watchdog:${taskId}`).catch(() => {});
    await fireNotification(process.env.SQS_PROCESSING_QUEUE_URL, tenantId, 'task.completed', actorId, task.createdBy, task.id, task.title);

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/fail
export async function handleFailTask(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const parsed = z.object({ error: z.string().min(1), tenantId: z.string().uuid().optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (parsed.data.tenantId && parsed.data.tenantId !== task.tenantId) return c.json({ error: 'Tenant mismatch' }, 403);

    const { tenantId, agentId } = task;
    const actorId = agentId ?? 'system';
    const failError = parsed.data.error;

    await db.update(agentTasks).set({ status: 'blocked', blockedReason: failError, updatedAt: new Date() }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'agent', actorId, eventType: 'status_changed', payload: { from: task.status, to: 'blocked', error: failError } });
    db.insert(auditLog).values({ tenantId, actorId, actorType: 'agent', action: 'task_failed', resource: 'agent_task', resourceId: taskId, metadata: { error: failError }, traceId: c.req.header('x-trace-id') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    try { await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'blocked' }); }
    catch (wsErr) { console.error('WS push failed (non-fatal):', wsErr); }

    getCacheClient().del(`task:watchdog:${taskId}`).catch(() => {});
    await fireNotification(process.env.SQS_PROCESSING_QUEUE_URL, tenantId, 'task.failed', actorId, task.createdBy, task.id, task.title);

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/clarify
export async function handleClarifyTask(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const parsed = z.object({ questions: z.array(z.string().min(1)).min(1), tenantId: z.string().uuid().optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (parsed.data.tenantId && parsed.data.tenantId !== task.tenantId) return c.json({ error: 'Tenant mismatch' }, 403);

    const { tenantId, agentId } = task;
    const actorId = agentId ?? 'system';
    const { questions } = parsed.data;

    const priorClarifications = await db.select({ id: taskEvents.id }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.eventType, 'clarification_requested')));

    if (priorClarifications.length >= MAX_CLARIFICATION_ROUNDS) {
        const reason = 'Maximum clarification rounds reached. Please restart with more detail.';
        await db.update(agentTasks).set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() }).where(eq(agentTasks.id, taskId));
        await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'blocked' });
        return c.json({ error: reason, code: 'MAX_CLARIFICATIONS' }, 429);
    }

    const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await db.update(agentTasks).set({ status: 'blocked', blockedReason: `Agent needs clarification:\n${numbered}`, updatedAt: new Date() }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'agent', actorId, eventType: 'clarification_requested', payload: { questions } });
    db.insert(auditLog).values({ tenantId, actorId, actorType: 'agent', action: 'task_clarification_requested', resource: 'agent_task', resourceId: taskId, metadata: { questions }, traceId: c.req.header('x-trace-id') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    await fireNotification(process.env.SQS_PROCESSING_QUEUE_URL, tenantId, 'task.needs_clarification', actorId, task.createdBy, task.id, task.title);

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/mastra-run
export async function handleMastraRun(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const parsed = z.object({ mastraRunId: z.string().min(1) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const task = (await db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);

    await db.update(agentTasks).set({ mastraRunId: parsed.data.mastraRunId, updatedAt: new Date() }).where(eq(agentTasks.id, taskId));

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/suspend
export async function handleSuspendTask(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const task = (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const { tenantId } = task;
    await db.update(agentTasks).set({ status: 'awaiting_approval', blockedReason: null, updatedAt: new Date() }).where(eq(agentTasks.id, taskId));
    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'system', actorId: 'system', eventType: 'status_changed', payload: { from: task.status, to: 'awaiting_approval', source: 'mastra_workflow' } });
    db.insert(auditLog).values({ tenantId, actorId: 'system', actorType: 'system', action: 'task_suspended', resource: 'agent_task', resourceId: taskId, metadata: { source: 'mastra_workflow' }, traceId: c.req.header('x-trace-id') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    try { await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'awaiting_approval' }); }
    catch (wsErr) { console.error('WS push failed (non-fatal):', wsErr); }

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/comments (agent posting)
export async function handlePostComment(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const parsed = z.object({ content: z.string().min(1), agentId: z.string().uuid(), parentId: z.string().uuid().optional(), tenantId: z.string().uuid().optional() }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (parsed.data.tenantId && parsed.data.tenantId !== task.tenantId) return c.json({ error: 'Tenant mismatch' }, 403);

    const { tenantId } = task;
    const { content, agentId, parentId } = parsed.data;

    const [comment] = await db.insert(taskComments).values({ taskId, tenantId, authorId: agentId, authorType: 'agent', content, parentId: parentId ?? null }).returning();
    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'agent', actorId: agentId, eventType: 'comment_added', payload: { commentId: comment.id } });
    db.insert(auditLog).values({ tenantId, actorId: agentId, actorType: 'agent', action: 'task_comment_added', resource: 'agent_task', resourceId: taskId, metadata: { commentId: comment.id }, traceId: c.req.header('x-trace-id') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    await pushWebSocketEvent(tenantId, { type: 'task.comment.added', taskId, comment });

    return c.json({ data: comment }, 201);
}

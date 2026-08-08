import { z } from 'zod';
import { eq, and, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { agentTasks, taskSteps, taskComments, taskEvents } from '@serverless-saas/agent-schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { pushWebSocketEvent } from '../../lib/websocket';
import { getCacheClient } from '@serverless-saas/cache';
import { isAuthorized } from './tasks.auth';
import { refreshTaskHeartbeat, clearTaskHeartbeat } from '../../lib/task-heartbeat';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const authCheck = (c: Context<AppEnv>) =>
    !isAuthorized(c.req.header('x-internal-service-key') ?? '');

// GET /internal/tasks/:taskId/comments
export async function handleGetComments(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const task = (await db.select({ id: agentTasks.id, tenantId: agentTasks.tenantId })
        .from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const comments = await db.select().from(taskComments)
        .where(and(eq(taskComments.taskId, taskId), eq(taskComments.tenantId, task.tenantId)))
        .orderBy(taskComments.createdAt);

    return c.json({ data: comments });
}

// POST /internal/tasks/:taskId/steps/:stepId/start
export async function handleStartStep(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const stepId = c.req.param('stepId') as string;

    const step = (await db.select().from(taskSteps).where(and(eq(taskSteps.id, stepId), eq(taskSteps.taskId, taskId))).limit(1))[0];
    if (!step) return c.json({ error: 'Step not found' }, 404);

    const { tenantId } = step;
    const task = (await db.select({ agentId: agentTasks.agentId }).from(agentTasks)
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId))).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const previousIncomplete = await db.select({ id: taskSteps.id }).from(taskSteps)
        .where(and(eq(taskSteps.taskId, taskId), lt(taskSteps.stepNumber, step.stepNumber), sql`${taskSteps.status} NOT IN ('done', 'skipped')`))
        .limit(1);
    if (previousIncomplete.length > 0) return c.json({ error: 'Previous steps not yet completed' }, 409);

    await db.update(taskSteps).set({ status: 'running', startedAt: new Date(), updatedAt: new Date() }).where(eq(taskSteps.id, stepId));
    await db.update(agentTasks).set({ status: 'in_progress', updatedAt: new Date() }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'agent', actorId: task.agentId ?? 'system', eventType: 'status_changed', payload: { stepId, stepStatus: 'running' } });
    db.insert(auditLog).values({ tenantId, actorId: task.agentId ?? 'system', actorType: 'agent', action: 'task_step_started', resource: 'task_step', resourceId: stepId, metadata: { taskId, stepNumber: step.stepNumber }, traceId: c.req.header('x-trace-id') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    await pushWebSocketEvent(tenantId, { type: 'task.step.updated', taskId, stepId, status: 'running' });
    void refreshTaskHeartbeat(getCacheClient() as never, taskId, tenantId);

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/steps/:stepId/delta
export async function handleDeltaStep(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const stepId = c.req.param('stepId') as string;

    const bodySchema = z.object({
        tenantId: z.string().uuid(),
        type: z.enum(['task.step.delta', 'task.step.tool_call', 'task.step.tool_result', 'task.step.thinking']).optional(),
        delta: z.string().max(50_000).optional(), text: z.string().max(50_000).optional(),
        toolName: z.string().optional(), toolInput: z.string().optional(),
        durationMs: z.number().optional(), resultSummary: z.string().optional(),
    });

    const parsed = bodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const step = (await db.select({ tenantId: taskSteps.tenantId }).from(taskSteps).where(and(eq(taskSteps.id, stepId), eq(taskSteps.taskId, taskId))).limit(1))[0];
    if (!step) return c.json({ error: 'Step not found' }, 404);
    if (step.tenantId !== parsed.data.tenantId) return c.json({ error: 'Tenant mismatch' }, 403);

    const { tenantId, type: eventType = 'task.step.delta' } = parsed.data;

    if (eventType === 'task.step.tool_call') {
        await pushWebSocketEvent(tenantId, { type: 'task.step.tool_call', taskId, stepId, toolName: parsed.data.toolName, toolInput: parsed.data.toolInput });
    } else if (eventType === 'task.step.tool_result') {
        await pushWebSocketEvent(tenantId, { type: 'task.step.tool_result', taskId, stepId, toolName: parsed.data.toolName, durationMs: parsed.data.durationMs, resultSummary: parsed.data.resultSummary });
    } else if (eventType === 'task.step.thinking') {
        await pushWebSocketEvent(tenantId, { type: 'task.step.thinking', taskId, stepId });
    } else {
        await pushWebSocketEvent(tenantId, { type: 'task.step.delta', taskId, stepId, delta: parsed.data.delta ?? '', text: parsed.data.text ?? '' });
    }

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/steps/:stepId/complete
export async function handleCompleteStep(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const stepId = c.req.param('stepId') as string;
    const traceId = c.req.header('x-trace-id') ?? '';

    const bodySchema = z.object({
        agentOutput: z.string().max(100_000).optional(), summary: z.string().optional(),
        toolResult: z.record(z.unknown()).optional(), reasoning: z.string().optional(),
        actualToolUsed: z.string().optional(),
    });

    const parsed = bodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const step = (await db.select().from(taskSteps).where(and(eq(taskSteps.id, stepId), eq(taskSteps.taskId, taskId))).limit(1))[0];
    if (!step) return c.json({ error: 'Step not found' }, 404);

    const { tenantId } = step;
    const task = (await db.select({ agentId: agentTasks.agentId }).from(agentTasks).where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId))).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const { agentOutput, summary, toolResult, reasoning } = parsed.data;

    try {
        await db.update(taskSteps).set({ status: 'done', agentOutput: agentOutput ?? null, summary: summary ?? null, toolResult: toolResult ?? null, reasoning: reasoning ?? null, completedAt: new Date(), updatedAt: new Date() }).where(eq(taskSteps.id, stepId));
    } catch (dbErr) {
        console.error(JSON.stringify({ level: 'error', msg: 'step/complete DB write failed', traceId, taskId, stepId, error: (dbErr as Error).message, ts: Date.now() }));
        c.header('Retry-After', '2');
        return c.json({ error: 'Step completion write failed, please retry' }, 503);
    }

    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'agent', actorId: task.agentId ?? 'system', eventType: 'step_completed', payload: { stepId } });
    db.insert(auditLog).values({ tenantId, actorId: task.agentId ?? 'system', actorType: 'agent', action: 'task_step_completed', resource: 'task_step', resourceId: stepId, metadata: { taskId, summary: summary ?? null }, traceId: c.req.header('x-trace-id') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    await pushWebSocketEvent(tenantId, { type: 'task.step.updated', taskId, stepId, status: 'done', agentOutput, summary });
    void refreshTaskHeartbeat(getCacheClient() as never, taskId, tenantId);

    return c.json({ success: true });
}

// POST /internal/tasks/:taskId/steps/:stepId/fail
export async function handleFailStep(c: Context<AppEnv>) {
    if (authCheck(c)) return c.json({ error: 'Unauthorized' }, 401);

    const taskId = c.req.param('taskId') as string;
    const stepId = c.req.param('stepId') as string;
    const traceId = c.req.header('x-trace-id') ?? '';

    const parsed = z.object({ error: z.string().min(1) }).safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const step = (await db.select().from(taskSteps).where(and(eq(taskSteps.id, stepId), eq(taskSteps.taskId, taskId))).limit(1))[0];
    if (!step) return c.json({ error: 'Step not found' }, 404);

    const { tenantId } = step;
    const task = (await db.select({ agentId: agentTasks.agentId }).from(agentTasks).where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId))).limit(1))[0];
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const failError = parsed.data.error;
    const [updatedStep] = await db.update(taskSteps)
        .set({ status: 'failed', agentOutput: failError, updatedAt: new Date() })
        .where(and(eq(taskSteps.id, stepId), eq(taskSteps.status, 'running')))
        .returning({ id: taskSteps.id });

    if (!updatedStep) return c.json({ error: 'Step is not in a failable state' }, 409);

    console.error(JSON.stringify({ level: 'error', msg: 'step failed', traceId, taskId, stepId, error: failError, ts: Date.now() }));

    await db.update(agentTasks).set({ status: 'blocked', blockedReason: failError, updatedAt: new Date() }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
    await db.insert(taskEvents).values({ taskId, tenantId, actorType: 'agent', actorId: task.agentId ?? 'system', eventType: 'step_failed', payload: { stepId, error: failError } });
    db.insert(auditLog).values({ tenantId, actorId: task.agentId ?? 'system', actorType: 'agent', action: 'task_step_failed', resource: 'task_step', resourceId: stepId, metadata: { taskId, error: failError }, traceId: traceId }).catch((err: unknown) => console.error('Audit log write failed:', err));
    await pushWebSocketEvent(tenantId, { type: 'task.step.updated', taskId, stepId, status: 'failed' });
    await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'blocked', blockedReason: failError });
    void clearTaskHeartbeat(getCacheClient() as never, taskId);

    return c.json({ success: true });
}

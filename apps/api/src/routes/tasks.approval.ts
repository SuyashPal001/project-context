import { randomUUID } from 'crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agentTasks, taskSteps, taskEvents } from '@serverless-saas/database/schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import { pushWebSocketEvent } from '../lib/websocket';
import { publishToQueue } from '../lib/sqs';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

const CONCURRENT_TASK_LIMITS: Record<string, number> = {
    free: 1, starter: 3, business: 10, enterprise: 50,
};

// PUT /tasks/:taskId/plan/approve
export async function handlePlanApprove(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const schema = z.object({
        approved: z.boolean(),
        stepFeedback: z.array(z.object({ stepId: z.string().uuid(), feedback: z.string() })).optional(),
        extraContext: z.string().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'awaiting_approval' && task.status !== 'blocked') {
        return c.json({ error: 'Task plan cannot be reviewed in its current state' }, 400);
    }

    const { approved, stepFeedback, extraContext } = result.data;

    if (!approved) {
        return handleRejectPlan(c, { tenantId, userId, taskId, stepFeedback, extraContext });
    }

    // Enforce concurrent task limit before approval
    const plan = requestContext?.tenant?.plan ?? 'free';
    const maxConcurrent = CONCURRENT_TASK_LIMITS[plan] ?? 1;
    const [{ value: activeCount }] = await db
        .select({ value: count() })
        .from(agentTasks)
        .where(and(eq(agentTasks.tenantId, tenantId), eq(agentTasks.status, 'in_progress')));

    if (Number(activeCount) >= maxConcurrent) {
        return c.json({
            error: `Concurrent task limit reached (${maxConcurrent} for ${plan} plan). Wait for a running task to complete.`,
            code: 'CONCURRENT_LIMIT',
        }, 429);
    }

    // BUG-6: Atomic update with status predicate to prevent double-approval
    const [updatedTask] = await db.update(agentTasks)
        .set({ status: 'ready', planApprovedAt: new Date(), planApprovedBy: userId, updatedAt: new Date() })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId), eq(agentTasks.status, 'awaiting_approval')))
        .returning();

    if (!updatedTask) return c.json({ error: 'Task plan cannot be reviewed in its current state' }, 409);

    await db.insert(taskEvents).values({
        taskId, tenantId, actorType: 'human', actorId: userId, eventType: 'plan_approved', payload: {},
    });
    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'task_plan_approved', resource: 'agent_task', resourceId: taskId, metadata: {}, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    console.log('[SQS] Publishing execute_task for task', taskId);
    try {
        await publishToQueue(process.env.AGENT_TASK_QUEUE_URL!, { type: 'execute_task', taskId, traceId: randomUUID() });
    } catch (sqsErr) {
        console.error('[SQS] execute_task publish failed for task', taskId, sqsErr);
        await db.update(agentTasks)
            .set({ status: 'blocked', blockedReason: 'Failed to queue task for execution. Please retry.', updatedAt: new Date() })
            .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));
        return c.json({ error: 'Failed to queue task for execution. Please retry.' }, 502);
    }

    // BUG-7: Push WS event so board updates immediately after approval
    try {
        await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'ready' });
    } catch (wsErr) {
        console.error('WS push failed (non-fatal):', wsErr);
    }

    return c.json({ data: { task: updatedTask } });
}

async function handleRejectPlan(c: Context<AppEnv>, opts: {
    tenantId: string; userId: string; taskId: string;
    stepFeedback?: { stepId: string; feedback: string }[];
    extraContext?: string;
}) {
    const { tenantId, userId, taskId, stepFeedback, extraContext } = opts;

    if (stepFeedback?.length) {
        await Promise.all(stepFeedback.map(({ stepId, feedback }) =>
            db.update(taskSteps)
                .set({ humanFeedback: feedback, updatedAt: new Date() })
                .where(and(eq(taskSteps.id, stepId), eq(taskSteps.taskId, taskId)))
        ));
    }

    await db.insert(taskEvents).values({
        taskId, tenantId, actorType: 'human', actorId: userId,
        eventType: 'plan_rejected', payload: { stepFeedback: stepFeedback ?? [] },
    });
    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'task_plan_rejected', resource: 'agent_task', resourceId: taskId, metadata: { stepCount: stepFeedback?.length ?? 0, hasExtraContext: !!extraContext }, traceId: '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    const pendingSteps: (typeof taskSteps.$inferSelect)[] = await db.select()
        .from(taskSteps)
        .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.status, 'pending')));

    const stepFeedbackContext = pendingSteps.filter((s) => s.humanFeedback)
        .map((s) => `- Step "${s.title}": ${s.humanFeedback}`).join('\n');

    const feedbackHistoryMap: Record<string, Array<{ round: number; feedback: string; generalInstruction: string | null; replannedAt: string }>> = {};
    const stepsWithFeedback = pendingSteps.filter((s) => s.humanFeedback);
    if (stepsWithFeedback.length > 0) {
        const replannedAt = new Date().toISOString();
        await Promise.all(stepsWithFeedback.map(async (s) => {
            const existingHistory = (s.feedbackHistory as any[]) ?? [];
            const entry = { round: existingHistory.length + 1, feedback: s.humanFeedback!, generalInstruction: extraContext?.trim() ?? null, replannedAt };
            await db.update(taskSteps)
                .set({ feedbackHistory: sql`COALESCE(${taskSteps.feedbackHistory}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb` })
                .where(eq(taskSteps.id, s.id));
            feedbackHistoryMap[s.title] = [...existingHistory, entry];
        }));
    }

    const parts: string[] = [];
    if (extraContext?.trim()) parts.push(`General instruction: ${extraContext.trim()}`);
    if (stepFeedbackContext) parts.push(stepFeedbackContext);
    const fullFeedbackContext = parts.join('\n');

    console.log('[SQS] Publishing replan_task for task', taskId);
    try {
        await publishToQueue(process.env.AGENT_TASK_QUEUE_URL!, {
            type: 'replan_task', taskId, traceId: randomUUID(),
            ...(fullFeedbackContext ? { extraContext: fullFeedbackContext } : {}),
            ...(Object.keys(feedbackHistoryMap).length > 0 ? { feedbackHistoryMap } : {}),
        });
    } catch (sqsErr) {
        console.error('[SQS] replan_task publish failed for task', taskId, sqsErr);
        return c.json({ error: 'Failed to queue task for replanning. Please retry.' }, 502);
    }

    try {
        await db.delete(taskSteps).where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.status, 'pending')));
    } catch (deleteErr) {
        console.error('[replan] step delete failed after SQS publish (non-fatal):', deleteErr);
    }

    const [updatedTask] = await db.update(agentTasks)
        .set({ status: 'planning', planApprovedAt: null, updatedAt: new Date() })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)))
        .returning();

    return c.json({ data: { task: { ...updatedTask, sortOrder: updatedTask.sortOrder ?? 0 }, steps: [] } });
}

// PUT /tasks/:taskId/workflow/approve
export async function handleWorkflowApprove(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const task = (await db.select({ id: agentTasks.id, status: agentTasks.status, tenantId: agentTasks.tenantId })
        .from(agentTasks)
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)))
        .limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (task.status !== 'awaiting_approval') return c.json({ error: 'Task is not awaiting workflow approval' }, 400);

    const relayUrl = process.env.RELAY_URL;
    if (!relayUrl) return c.json({ error: 'Relay not configured' }, 503);

    const res = await fetch(`${relayUrl}/api/tasks/${taskId}/resume`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '',
            'x-trace-id': c.get('traceId') ?? randomUUID(),
        },
        body: JSON.stringify({}),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[tasks/workflow/approve] relay resume failed ${res.status}: ${text}`);
        return c.json({ error: 'Failed to resume workflow' }, 502);
    }

    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'workflow_approved', resource: 'agent_task', resourceId: taskId, metadata: {}, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    return c.json({ success: true });
}

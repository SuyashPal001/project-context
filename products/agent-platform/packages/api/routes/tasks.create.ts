import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { agentTasks, taskEvents, agents } from '@serverless-saas/agent-schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import { embedTexts } from '@serverless-saas/ai';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const createTaskSchema = z.object({
    agentId: z.string().uuid().optional(),
    assigneeId: z.string().uuid().optional(),
    title: z.string().min(1).max(200),
    description: z.string().optional(),
    referenceText: z.string().optional(),
    acceptanceCriteria: z.array(z.object({ text: z.string(), checked: z.boolean().default(false) })).default([]),
    estimatedHours: z.number().positive().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    links: z.preprocess(
        (v) => {
            const arr = typeof v === 'string' ? JSON.parse(v) : v;
            if (!Array.isArray(arr)) return arr;
            return arr.map((url: unknown) =>
                typeof url === 'string' && !/^https?:\/\//i.test(url) ? `https://${url}` : url
            );
        },
        z.array(z.string().url()).optional(),
    ),
    attachmentFileIds: z.preprocess(
        (v) => (typeof v === 'string' ? JSON.parse(v) : v),
        z.array(z.string().uuid()).optional(),
    ),
    milestoneId: z.string().uuid().nullable().optional(),
    planId: z.string().uuid().nullable().optional(),
    parentTaskId: z.string().uuid().nullable().optional(),
});

// POST /tasks
export async function handleCreateTask(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const result = createTaskSchema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const { agentId, assigneeId, title, description, referenceText, acceptanceCriteria, estimatedHours, priority, links, attachmentFileIds, milestoneId, planId, parentTaskId } = result.data;

    if (agentId) {
        const agent = (await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1))[0];
        if (!agent) return c.json({ error: 'Agent not found in tenant' }, 404);
    }

    const [task] = await db.insert(agentTasks).values({
        tenantId,
        agentId: agentId ?? null,
        assigneeId: assigneeId ?? null,
        createdBy: userId,
        title,
        description,
        rawInput: description ?? title,
        referenceText: referenceText ?? null,
        acceptanceCriteria,
        estimatedHours: estimatedHours !== undefined ? String(estimatedHours) : undefined,
        priority: priority ?? 'medium',
        links: Array.isArray(links) ? links : [],
        attachmentFileIds: Array.isArray(attachmentFileIds) ? attachmentFileIds : [],
        milestoneId: milestoneId ?? null,
        planId: planId ?? null,
        parentTaskId: parentTaskId ?? null,
        status: 'backlog',
    }).returning();

    await db.insert(taskEvents).values({
        taskId: task.id, tenantId, actorType: 'system', actorId: 'system',
        eventType: 'status_changed', payload: { from: null, to: 'backlog' },
    });

    try {
        await db.insert(auditLog).values({
            tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'task_created', resource: 'agent_task', resourceId: task.id,
            metadata: { agentId }, traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    // Fire-and-forget embedding for future RAG-injected planning
    const embedText = [title, description].filter(Boolean).join(' ');
    embedTexts([embedText], 'RETRIEVAL_DOCUMENT')
        .then(([result]) => db.update(agentTasks).set({ embedding: result.embedding }).where(eq(agentTasks.id, task.id)))
        .catch((err: unknown) => console.error('[tasks] embedding generation failed (non-fatal):', (err as Error).message));

    return c.json({ data: { task: { ...task, sortOrder: task.sortOrder ?? 0 }, steps: [] } }, 201);
}

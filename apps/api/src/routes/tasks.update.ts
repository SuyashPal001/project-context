import { and, eq, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agentTasks, agents } from '@serverless-saas/agent-schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import { pushWebSocketEvent } from '../lib/websocket';
import { VALID_USER_TRANSITIONS } from './tasks.constants';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

const patchTaskSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    estimatedHours: z.number().positive().nullable().optional(),
    acceptanceCriteria: z.array(z.object({ text: z.string(), checked: z.boolean() })).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    status: z.enum(['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled']).optional(),
    startedAt: z.string().datetime().nullable().optional(),
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
    sortOrder: z.number().int().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    agentId: z.string().uuid().nullable().optional(),
    referenceText: z.string().nullable().optional(),
    descriptionHtml: z.string().nullable().optional(),
});

// PATCH /tasks/:taskId
export async function handleUpdateTask(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const result = patchTaskSchema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);

    // Ownership rule: owner/admin (with agent_tasks:delete) can update any task.
    // Members can update tasks they created OR tasks assigned to them.
    const canManageAny = hasPermission(permissions, 'agent_tasks', 'delete');
    if (!canManageAny && task.createdBy !== userId && task.assigneeId !== userId) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { title, description, estimatedHours, acceptanceCriteria, dueDate, status, startedAt, links, attachmentFileIds, sortOrder, priority, assigneeId, agentId, referenceText, descriptionHtml } = result.data;

    if (agentId) {
        const agent = (await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1))[0];
        if (!agent) return c.json({ error: 'Agent not found in tenant' }, 404);
    }

    const updateValues: Partial<typeof agentTasks.$inferInsert> = { updatedAt: new Date() };
    if (title !== undefined) updateValues.title = title;
    if (description !== undefined) updateValues.description = description;
    if (estimatedHours !== undefined) updateValues.estimatedHours = estimatedHours !== null ? String(estimatedHours) : null;
    if (acceptanceCriteria !== undefined) updateValues.acceptanceCriteria = acceptanceCriteria;
    if (dueDate !== undefined) updateValues.dueDate = dueDate !== null ? new Date(dueDate) : null;
    if (status !== undefined && status !== task.status) {
        const allowed = VALID_USER_TRANSITIONS[task.status] ?? [];
        if (!allowed.includes(status)) return c.json({ error: `Cannot transition from ${task.status} to ${status}` }, 400);
    }
    if (status !== undefined) updateValues.status = status;
    if (startedAt !== undefined) updateValues.startedAt = startedAt !== null ? new Date(startedAt) : null;
    if (links !== undefined) updateValues.links = links;
    if (attachmentFileIds !== undefined) {
        (updateValues as any).attachmentFileIds = sql`ARRAY[${sql.join(attachmentFileIds.map(id => sql`${id}`), sql`, `)}]::text[]`;
    }
    if (sortOrder !== undefined) updateValues.sortOrder = sortOrder;
    if (priority !== undefined) updateValues.priority = priority;
    if (assigneeId !== undefined) updateValues.assigneeId = assigneeId;
    if (agentId !== undefined) updateValues.agentId = agentId;
    if (referenceText !== undefined) updateValues.referenceText = referenceText;
    if (descriptionHtml !== undefined) updateValues.descriptionHtml = descriptionHtml;

    const [updatedTask] = await db.update(agentTasks)
        .set(updateValues)
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)))
        .returning();

    if (status === 'todo' && task.status === 'backlog') {
        try {
            await pushWebSocketEvent(tenantId, { type: 'task.status.changed', taskId, status: 'todo' });
        } catch (wsErr) {
            console.error('WS push failed (non-fatal):', wsErr);
        }
    }

    try {
        await db.insert(auditLog).values({
            tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'task_updated', resource: 'agent_task', resourceId: taskId,
            metadata: { fields: Object.keys(result.data) }, traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ data: updatedTask });
}

// DELETE /tasks/:taskId — soft-cancel a task
export async function handleDeleteTask(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    const taskId = c.req.param('taskId') as string;
    const task = (await db.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);

    // Ownership rule: owner/admin (with agent_tasks:delete) can delete any task.
    // Members lacking that permission can still delete tasks they created themselves.
    const canManageAny = hasPermission(permissions, 'agent_tasks', 'delete');
    if (!canManageAny && task.createdBy !== userId) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    if (task.status === 'in_progress') return c.json({ error: 'Cannot delete a running task. Cancel it first.' }, 400);

    await db.update(agentTasks)
        .set({ status: 'cancelled', cancelReason: 'Deleted by user', updatedAt: new Date() })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId)));

    try {
        await db.insert(auditLog).values({
            tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'task_deleted', resource: 'agent_task', resourceId: taskId,
            metadata: {}, traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ success: true });
}

// POST /tasks/bulk — bulk create tasks
export async function handleBulkCreate(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const schema = z.object({
        tasks: z.array(z.object({
            title: z.string().min(1).max(200),
            description: z.string().optional(),
            milestoneId: z.string().uuid().optional(),
            planId: z.string().uuid().optional(),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
            assigneeId: z.string().uuid().optional(),
        })).min(1).max(50),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const rows = result.data.tasks.map(t => ({
        tenantId, createdBy: userId, title: t.title, description: t.description ?? null,
        milestoneId: t.milestoneId ?? null, planId: t.planId ?? null,
        priority: (t.priority ?? 'medium') as 'low' | 'medium' | 'high' | 'urgent',
        assigneeId: t.assigneeId ?? null, status: 'backlog' as const,
        acceptanceCriteria: [], links: [] as string[], attachmentFileIds: [] as string[],
    }));

    const created = await db.insert(agentTasks).values(rows).returning();
    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'tasks_bulk_created', resource: 'agent_task', resourceId: null, metadata: { count: created.length }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    return c.json({ data: created }, 201);
}

// PATCH /tasks/bulk — bulk update tasks
export async function handleBulkUpdate(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const schema = z.object({
        task_ids: z.array(z.string().uuid()).min(1).max(100),
        properties: z.object({
            status: z.enum(['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled']).optional(),
            priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
            assigneeId: z.string().uuid().nullable().optional(),
            milestoneId: z.string().uuid().nullable().optional(),
            planId: z.string().uuid().nullable().optional(),
        }).refine(obj => Object.keys(obj).length > 0, { message: 'At least one property required' }),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const { task_ids, properties } = result.data;
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (properties.status !== undefined) updates.status = properties.status;
    if (properties.priority !== undefined) updates.priority = properties.priority;
    if (properties.assigneeId !== undefined) updates.assigneeId = properties.assigneeId;
    if (properties.milestoneId !== undefined) updates.milestoneId = properties.milestoneId;
    if (properties.planId !== undefined) updates.planId = properties.planId;

    const updated = await db.update(agentTasks)
        .set(updates)
        .where(and(inArray(agentTasks.id, task_ids), eq(agentTasks.tenantId, tenantId)))
        .returning({ id: agentTasks.id });

    db.insert(auditLog).values({ tenantId, actorId: userId, actorType: 'human', action: 'tasks_bulk_updated', resource: 'agent_task', resourceId: null, metadata: { count: updated.length, fields: Object.keys(properties) }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    return c.json({ data: { updated: updated.length } });
}

import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agentTasks, taskComments, taskEvents, agents } from '@serverless-saas/agent-schema/agents';
import { users } from '@serverless-saas/database/schema/auth';
import { hasPermission } from '@serverless-saas/permissions';
import { pushWebSocketEvent } from '../lib/websocket';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

// GET /tasks/:taskId/comments
export async function handleListComments(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agent_tasks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const task = (await db.select({ id: agentTasks.id }).from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);

    const comments = await db
        .select({
            id: taskComments.id,
            taskId: taskComments.taskId,
            authorId: taskComments.authorId,
            authorType: taskComments.authorType,
            authorName: sql<string>`COALESCE(${users.name}, ${agents.name}, 'Unknown')`,
            content: taskComments.content,
            contentHtml: taskComments.contentHtml,
            parentId: taskComments.parentId,
            createdAt: taskComments.createdAt,
            updatedAt: taskComments.updatedAt,
        })
        .from(taskComments)
        .leftJoin(users, and(eq(taskComments.authorId, users.id), eq(taskComments.authorType, 'member')))
        .leftJoin(agents, and(sql`${taskComments.authorId} = ${agents.id}`, eq(taskComments.authorType, 'agent')))
        .where(and(eq(taskComments.taskId, taskId), eq(taskComments.tenantId, tenantId)))
        .orderBy(asc(taskComments.createdAt));

    return c.json({ data: comments });
}

// POST /tasks/:taskId/comments
export async function handleAddComment(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_tasks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const taskId = c.req.param('taskId') as string;
    const schema = z.object({
        content: z.string().min(1),
        contentHtml: z.string().nullable().optional(),
        parentId: z.string().uuid().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const task = (await db.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId), eq(agentTasks.tenantId, tenantId),
    )).limit(1))[0];

    if (!task) return c.json({ error: 'Task not found' }, 404);

    const [comment] = await db.insert(taskComments).values({
        taskId, tenantId, authorId: userId, authorType: 'member',
        content: result.data.content,
        contentHtml: result.data.contentHtml ?? null,
        parentId: result.data.parentId ?? null,
    }).returning();

    await db.insert(taskEvents).values({
        taskId, tenantId, actorType: 'human', actorId: userId,
        eventType: 'comment_added', payload: { commentId: comment.id },
    });

    try {
        await pushWebSocketEvent(tenantId, { type: 'task.comment.added', taskId, comment });
    } catch (wsErr) {
        console.error('WS push failed (non-fatal):', wsErr);
    }

    return c.json({ data: comment }, 201);
}

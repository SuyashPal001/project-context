import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database/client';
import { conversations } from '@serverless-saas/database/schema/conversations';
import { agents } from '@serverless-saas/database/schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const conversationsRoutes = new Hono<AppEnv>();

// GET /conversations — list conversations scoped to the calling member
conversationsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = requestContext?.userId as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { agentId, status } = c.req.query();

    const filters = [eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)];
    if (agentId) filters.push(eq(conversations.agentId, agentId));
    if (status) filters.push(eq(conversations.status, status as 'active' | 'archived' | 'escalated'));

    try {
        const data = await db
            .select({
                id: conversations.id,
                tenantId: conversations.tenantId,
                agentId: conversations.agentId,
                title: conversations.title,
                status: conversations.status,
                metadata: conversations.metadata,
                createdAt: conversations.createdAt,
                updatedAt: conversations.updatedAt,
                agent: {
                    id: agents.id,
                    name: agents.name,
                    type: agents.type,
                }
            })
            .from(conversations)
            .innerJoin(agents, eq(conversations.agentId, agents.id))
            .where(and(...filters))
            .orderBy(desc(conversations.createdAt));

        return c.json({ data });
    } catch (error) {
        console.error('Fetch conversations failed:', error);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// POST /conversations — create new conversation (userId always stamped from JWT)
conversationsRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = requestContext?.userId as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const schema = z.object({
        agentId: z.string().uuid(),
        externalUserId: z.string().optional(),
        title: z.string().max(255).optional(),
        metadata: z.record(z.unknown()).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, result.data.agentId), eq(agents.tenantId, tenantId)))
        .limit(1);

    if (!agent) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const [created] = await db.insert(conversations).values({
        tenantId,
        agentId: result.data.agentId,
        userId,
        externalUserId: result.data.externalUserId ?? null,
        title: result.data.title ?? null,
        metadata: result.data.metadata ?? null,
        status: 'active',
        needsHuman: false,
    }).returning();

    return c.json({ data: created }, 201);
});

// GET /conversations/:id — get single conversation (member-scoped)
conversationsRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = requestContext?.userId as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [data] = await db
        .select({
            id: conversations.id,
            tenantId: conversations.tenantId,
            agentId: conversations.agentId,
            userId: conversations.userId,
            externalUserId: conversations.externalUserId,
            title: conversations.title,
            status: conversations.status,
            needsHuman: conversations.needsHuman,
            metadata: conversations.metadata,
            createdAt: conversations.createdAt,
            updatedAt: conversations.updatedAt,
            agent: {
                id: agents.id,
                name: agents.name,
                type: agents.type,
            },
        })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
        .limit(1);

    if (!data) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ data });
});

// PATCH /conversations/:id — update title, status, or needsHuman (member-scoped)
conversationsRoutes.patch('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = requestContext?.userId as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    const schema = z.object({
        title: z.string().max(255).optional(),
        status: z.enum(['active', 'archived', 'escalated']).optional(),
        needsHuman: z.boolean().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    if (Object.keys(result.data).length === 0) {
        return c.json({ error: 'No fields provided for update', code: 'VALIDATION_ERROR' }, 400);
    }

    await db.update(conversations)
        .set({ ...result.data, updatedAt: new Date() })
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)));

    const [updated] = await db
        .select({
            id: conversations.id,
            tenantId: conversations.tenantId,
            agentId: conversations.agentId,
            userId: conversations.userId,
            externalUserId: conversations.externalUserId,
            title: conversations.title,
            status: conversations.status,
            needsHuman: conversations.needsHuman,
            metadata: conversations.metadata,
            createdAt: conversations.createdAt,
            updatedAt: conversations.updatedAt,
            agent: {
                id: agents.id,
                name: agents.name,
                type: agents.type,
            },
        })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentId, agents.id))
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
        .limit(1);

    return c.json({ data: updated });
});

// DELETE /conversations/:id — soft delete (archive, member-scoped)
conversationsRoutes.delete('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = requestContext?.userId as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    await db.update(conversations)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)));

    return c.json({ success: true });
});

// DELETE /conversations/:id/permanent — hard delete (member-scoped)
conversationsRoutes.delete('/:id/permanent', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = requestContext?.userId as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [existing] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    await db.delete(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)));

    return c.json({ success: true });
});

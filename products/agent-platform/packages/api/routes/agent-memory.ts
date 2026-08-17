import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { agents, agentMemories } from '@serverless-saas/agent-schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const agentMemoryRoutes = new Hono<AppEnv>();

async function resolveAgent(agentId: string, tenantId: string) {
    const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1);
    return agent ?? null;
}

// GET /agents/:agentId/memory — the tenant-editable MEMORY.md content
agentMemoryRoutes.get('/:agentId/memory', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('agentId');
    if (!await resolveAgent(agentId, tenantId)) return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);

    const [row] = await db.select({ content: agentMemories.content, updatedAt: agentMemories.updatedAt }).from(agentMemories).where(eq(agentMemories.agentId, agentId)).limit(1);

    return c.json({ data: { content: row?.content ?? '', updatedAt: row?.updatedAt ?? null } });
});

// PUT /agents/:agentId/memory — save the tenant-editable MEMORY.md content
agentMemoryRoutes.put('/:agentId/memory', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('agentId');
    if (!await resolveAgent(agentId, tenantId)) return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);

    const result = z.object({ content: z.string().max(20000) }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

    const [updated] = await db
        .insert(agentMemories)
        .values({ agentId, content: result.data.content })
        .onConflictDoUpdate({ target: agentMemories.agentId, set: { content: result.data.content, updatedAt: new Date() } })
        .returning();

    return c.json({ data: { content: updated.content, updatedAt: updated.updatedAt } });
});

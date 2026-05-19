import { Hono } from 'hono';
import { eq, and, ne, desc } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { agentPrds } from '@serverless-saas/database/schema/pm';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const prdsRoutes = new Hono<AppEnv>();

// GET /prds?agentId=X — latest non-rejected PRD for the agent (used to restore canvas on refresh)
prdsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'read'))
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.query('agentId');
    if (!agentId) return c.json({ data: [] });

    const prds = await db
        .select()
        .from(agentPrds)
        .where(and(
            eq(agentPrds.tenantId, tenantId),
            eq(agentPrds.agentId, agentId),
            ne(agentPrds.status, 'rejected'),
        ))
        .orderBy(desc(agentPrds.createdAt))
        .limit(1);

    return c.json({ data: prds });
});

// GET /prds/:id
prdsRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'read'))
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { id } = c.req.param();
    const prd = (await db
        .select()
        .from(agentPrds)
        .where(and(eq(agentPrds.id, id), eq(agentPrds.tenantId, tenantId)))
        .limit(1))[0];

    if (!prd) return c.json({ error: 'PRD not found' }, 404);
    return c.json({ data: prd });
});

// PATCH /prds/:id/approve
prdsRoutes.patch('/:id/approve', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'project_plans', 'update'))
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const { id } = c.req.param();
    const [updated] = await db
        .update(agentPrds)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(and(eq(agentPrds.id, id), eq(agentPrds.tenantId, tenantId)))
        .returning({ id: agentPrds.id, status: agentPrds.status });

    if (!updated) return c.json({ error: 'PRD not found' }, 404);
    return c.json({ data: updated });
});

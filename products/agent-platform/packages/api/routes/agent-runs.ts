import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db';
import { agentWorkflowRuns } from '@serverless-saas/agent-schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';


export const agentRunsRoutes = new Hono<AppEnv>();

// GET /agent-runs — list all runs for tenant, newest first
agentRunsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    // Optional filter by agentId via query param
    const agentId = c.req.query('agentId');

    const conditions = [eq(agentWorkflowRuns.tenantId, tenantId)];
    if (agentId) {
        conditions.push(eq(agentWorkflowRuns.agentId, agentId));
    }

    const data = await db
        .select()
        .from(agentWorkflowRuns)
        .where(and(...conditions))
        .orderBy(desc(agentWorkflowRuns.startedAt))
        .limit(50);

    return c.json({ data });
});

// GET /agent-runs/:id — full detail of one run
agentRunsRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const runId = c.req.param('id');

    const data = (await db
        .select()
        .from(agentWorkflowRuns)
        .where(and(eq(agentWorkflowRuns.id, runId), eq(agentWorkflowRuns.tenantId, tenantId)))
        .limit(1))[0];

    if (!data) {
        return c.json({ error: 'Run not found' }, 404);
    }

    return c.json({ data });
});
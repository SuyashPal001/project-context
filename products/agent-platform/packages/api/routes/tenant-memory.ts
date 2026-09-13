import { Hono } from 'hono';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const tenantMemoryRoutes = new Hono<AppEnv>();

// GET /tenant-memory — read-only tenant-wide memory insights extracted by
// Observational Memory's Extractor (apps/agent-orchestrator/src/mastra/memory.ts,
// tenantMemoryExtractor). Proxies to the orchestrator the same way
// agents.health.ts does, since only the orchestrator owns the Mastra Postgres
// schema/pool (see project_om_rollout_plan memory note — no direct DB access
// to the `mastra` schema from this Lambda by design).
tenantMemoryRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const relayUrl = process.env.AGENT_ORCHESTRATOR_URL;
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!relayUrl || !serviceKey) {
        return c.json({ data: { topics: [], areas: [], projects: [], threadCount: 0, updatedAt: null } });
    }

    try {
        const res = await fetch(`${relayUrl}/memory/insights/${tenantId}`, {
            headers: { 'X-Service-Key': serviceKey },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return c.json({ error: 'Failed to load memory insights', code: 'UPSTREAM_ERROR' }, 502);
        const body = await res.json();
        return c.json(body);
    } catch (err) {
        console.warn(`[tenant-memory] fetch failed for tenant ${tenantId}:`, err);
        return c.json({ error: 'Failed to load memory insights', code: 'UPSTREAM_ERROR' }, 502);
    }
});

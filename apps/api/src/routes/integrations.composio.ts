import { Hono } from 'hono';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

// Proxy routes to agent-orchestrator for Composio-managed integrations.
// The orchestrator holds COMPOSIO_API_KEY and manages the Composio SDK.

export const composioIntegrationsRoute = new Hono<AppEnv>();

function orchestratorUrl(): string {
    const base = process.env.AGENT_ORCHESTRATOR_URL;
    if (!base) throw new Error('AGENT_ORCHESTRATOR_URL not configured');
    return base;
}

function serviceHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Service-Key': process.env.INTERNAL_SERVICE_KEY ?? '',
    };
}

// GET /integrations/composio/apps
composioIntegrationsRoute.get('/composio/apps', async (c) => {
    const requestContext = c.get('requestContext') as any;
    if (!hasPermission(requestContext?.permissions ?? [], 'integrations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const tenantId = requestContext?.tenant?.id as string;

    try {
        const res = await fetch(`${orchestratorUrl()}/internal/composio/apps?tenantId=${tenantId}`, {
            headers: serviceHeaders(),
        });
        const data = await res.json();
        if (!res.ok) return c.json(data, res.status as any);
        return c.json(data);
    } catch (err) {
        console.error('[composio/apps] proxy error:', (err as Error).message);
        return c.json({ error: 'Failed to fetch Composio apps' }, 502);
    }
});

// POST /integrations/composio/:app/connect
composioIntegrationsRoute.post('/composio/:app/connect', async (c) => {
    const requestContext = c.get('requestContext') as any;
    if (!hasPermission(requestContext?.permissions ?? [], 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const tenantId = requestContext?.tenant?.id as string;
    const appName = c.req.param('app');

    const frontendUrl = process.env.FRONTEND_URL ?? '';
    const slug = requestContext?.tenant?.slug as string ?? '';
    const redirectUrl = `${frontendUrl}/${slug}/dashboard/integrations?composio_connected=${appName}`;

    try {
        const res = await fetch(`${orchestratorUrl()}/internal/composio/connect`, {
            method: 'POST',
            headers: serviceHeaders(),
            body: JSON.stringify({ tenantId, appName, redirectUrl }),
        });
        const data = await res.json();
        if (!res.ok) return c.json(data, res.status as any);
        return c.json(data);
    } catch (err) {
        console.error('[composio/connect] proxy error:', (err as Error).message);
        return c.json({ error: 'Failed to initiate Composio connection' }, 502);
    }
});

// DELETE /integrations/composio/:app
composioIntegrationsRoute.delete('/composio/:app', async (c) => {
    const requestContext = c.get('requestContext') as any;
    if (!hasPermission(requestContext?.permissions ?? [], 'integrations', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const tenantId = requestContext?.tenant?.id as string;
    const appName = c.req.param('app');

    try {
        const res = await fetch(`${orchestratorUrl()}/internal/composio/disconnect`, {
            method: 'DELETE',
            headers: serviceHeaders(),
            body: JSON.stringify({ tenantId, appName }),
        });
        const data = await res.json();
        if (!res.ok) return c.json(data, res.status as any);
        return c.json(data);
    } catch (err) {
        console.error('[composio/disconnect] proxy error:', (err as Error).message);
        return c.json({ error: 'Failed to disconnect Composio app' }, 502);
    }
});

import { Hono } from 'hono';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

// Proxy routes to agent-orchestrator for Composio-managed integrations.
// The orchestrator holds COMPOSIO_API_KEY and manages the Composio SDK.

// Bumped on deploy. Logged once per cold start so CloudWatch shows which build
// is actually serving — without it there is no way to tell a stale bundle from
// a fix that did not work. Change this to force a new bundle hash when
// CloudFormation reports "No changes to deploy".
const BUILD_MARKER = '2026-07-30T14:10Z-composio-proxy-diagnostics';
console.log(`[composio] route module loaded — build ${BUILD_MARKER}`);

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

interface OrchestratorResult {
    ok: boolean;
    status: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
}

/**
 * Calls the orchestrator and always resolves to a status + parsed body.
 *
 * Reads the response as text before parsing: anything between us and the
 * orchestrator (Cloudflare challenge pages, gateway errors, nginx 502s)
 * answers with HTML, and calling res.json() on that throws a SyntaxError
 * that says nothing about what actually happened. Parsing defensively keeps
 * the real status code and a body snippet in the log.
 */
async function callOrchestrator(
    label: string,
    path: string,
    init?: RequestInit,
): Promise<OrchestratorResult> {
    const res = await fetch(`${orchestratorUrl()}${path}`, {
        ...init,
        headers: serviceHeaders(),
    });

    const raw = await res.text();

    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        console.error(
            `[${label}] non-JSON response from orchestrator:`,
            `status=${res.status}`,
            `content-type=${res.headers.get('content-type')}`,
            `body=${raw.slice(0, 200)}`,
        );
        return {
            ok: false,
            status: 502,
            data: { error: 'Orchestrator returned an unexpected response', code: 'ORCHESTRATOR_BAD_RESPONSE' },
        };
    }

    if (!res.ok) {
        console.error(`[${label}] orchestrator error:`, `status=${res.status}`, `body=${raw.slice(0, 200)}`);
    }

    return { ok: res.ok, status: res.status, data };
}

// GET /integrations/composio/apps
composioIntegrationsRoute.get('/composio/apps', async (c) => {
    const requestContext = c.get('requestContext') as any;
    if (!hasPermission(requestContext?.permissions ?? [], 'integrations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const tenantId = requestContext?.tenant?.id as string;

    try {
        const result = await callOrchestrator(
            'composio/apps',
            `/internal/composio/apps?tenantId=${tenantId}`,
        );
        if (!result.ok) {
            // Degrade rather than fail: this is a read-only listing rendered on
            // page load, and a non-2xx here surfaces as a console error plus an
            // empty grid the user can't act on. Return an explicit `degraded`
            // flag so the UI can say "unavailable" instead of "no results".
            // The real status is already in the log above.
            return c.json({ apps: [], degraded: true });
        }
        return c.json(result.data);
    } catch (err) {
        console.error('[composio/apps] proxy error:', (err as Error).message);
        return c.json({ apps: [], degraded: true });
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
        const result = await callOrchestrator('composio/connect', '/internal/composio/connect', {
            method: 'POST',
            body: JSON.stringify({ tenantId, appName, redirectUrl }),
        });
        return c.json(result.data, result.status as any);
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
        const result = await callOrchestrator('composio/disconnect', '/internal/composio/disconnect', {
            method: 'DELETE',
            body: JSON.stringify({ tenantId, appName }),
        });
        return c.json(result.data, result.status as any);
    } catch (err) {
        console.error('[composio/disconnect] proxy error:', (err as Error).message);
        return c.json({ error: 'Failed to disconnect Composio app' }, 502);
    }
});

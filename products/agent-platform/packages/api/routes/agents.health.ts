import { and, eq } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { agents } from '@serverless-saas/agent-schema/agents';
import { hasPermission } from '@serverless-saas/permissions';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const checkRelayHealth = async (relayUrl: string, serviceKey: string, tenantId: string): Promise<boolean> => {
    try {
        const res = await fetch(`${relayUrl}/health/${tenantId}`, {
            headers: { 'X-Service-Key': serviceKey },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        return data.healthy === true || data.status === 'healthy' || data.status === 'running';
    } catch {
        return false;
    }
};

// GET /agents/ensure-ready
export async function handleEnsureReady(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const relayUrl = process.env.RELAY_URL;
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;

    if (!relayUrl || !serviceKey) return c.json({ ready: true, skipped: true });

    const isHealthy = await checkRelayHealth(relayUrl, serviceKey, tenantId);
    if (isHealthy) return c.json({ ready: true });

    fetch(`${relayUrl}/provision/${tenantId}`, {
        method: 'POST',
        headers: { 'X-Service-Key': serviceKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    })
        .then(() => console.log(`[agents/ensure-ready] Provision triggered for tenant ${tenantId}`))
        .catch((err) => console.error(`[agents/ensure-ready] Provision call failed for tenant ${tenantId}:`, err));

    return c.json({ ready: false, code: 'AGENT_NOT_READY' });
}

// GET /agents/:id/status
export async function handleAgentStatus(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('id') as string;
    const agent = (await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1))[0];
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const relayUrl = process.env.RELAY_URL;
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;

    if (!relayUrl || !serviceKey) return c.json({ status: 'ready' });

    try {
        const res = await fetch(`${relayUrl}/health/${tenantId}`, {
            headers: { 'X-Service-Key': serviceKey },
            signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404) return c.json({ status: 'not_found' });
        if (res.ok) {
            const data = await res.json().catch(() => ({})) as Record<string, unknown>;
            const isHealthy = data.healthy === true || data.status === 'running' || data.status === 'healthy';
            return c.json({ status: isHealthy ? 'ready' : 'provisioning' });
        }
        return c.json({ status: 'provisioning' });
    } catch (err) {
        console.warn(`[agents/status] Health check failed for agent ${agentId}:`, err);
        return c.json({ status: 'provisioning' });
    }
}

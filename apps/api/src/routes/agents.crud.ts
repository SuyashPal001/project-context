import { and, eq, count } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agents } from '@serverless-saas/database/schema/agents';
import { users } from '@serverless-saas/database/schema/auth';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { memberships } from '@serverless-saas/database/schema/tenancy';
import { roles } from '@serverless-saas/database/schema/authorization';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { features } from '@serverless-saas/database/schema/entitlements';
import { llmProviders } from '@serverless-saas/database/schema/integrations';
import { hasPermission } from '@serverless-saas/permissions';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

const generateApiKey = (prefix: 'sk' | 'ak'): string => `${prefix}_${randomBytes(32).toString('hex')}`;
const hashKey = (rawKey: string): string => createHash('sha256').update(rawKey).digest('hex');

// GET /agents
export async function handleListAgents(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const data = await db.select().from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.isInternal, false)));
    return c.json({ data });
}

// GET /agents/:id
export async function handleGetAgent(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('id') as string;
    const agent = (await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1))[0];
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    const creator = agent.createdBy
        ? (await db.select({ name: users.name }).from(users).where(eq(users.id, agent.createdBy)).limit(1))[0]
        : null;

    let llmProvider = null;
    if (agent.llmProviderId) {
        const row = (await db.select({ id: llmProviders.id, displayName: llmProviders.displayName, provider: llmProviders.provider, model: llmProviders.model, status: llmProviders.status })
            .from(llmProviders).where(eq(llmProviders.id, agent.llmProviderId)).limit(1))[0];
        if (row) llmProvider = { ...row, displayName: row.displayName ?? row.model };
    }

    return c.json({ ...agent, llmProvider, createdByName: creator?.name ?? null });
}

// POST /agents
export async function handleCreateAgent(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agents', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const entitlements = requestContext?.entitlements as Record<string, { valueLimit?: number; unlimited?: boolean }> | undefined;
    if (entitlements) {
        const [agentFeature] = await db.select({ id: features.id }).from(features).where(eq(features.key, 'agents')).limit(1);
        if (agentFeature) {
            const agentEntitlement = entitlements[agentFeature.id];
            if (agentEntitlement && !agentEntitlement.unlimited) {
                const [{ value: used }] = await db.select({ value: count() }).from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.status, 'active')));
                const limit = agentEntitlement.valueLimit ?? 0;
                if (Number(used) >= limit) return c.json({ error: 'Agent limit reached for your plan', code: 'AGENT_LIMIT_REACHED', used: Number(used), limit }, 403);
            }
        }
    }

    const result = z.object({ name: z.string().min(1).max(100), type: z.enum(['ops', 'support', 'billing', 'custom']), model: z.string().optional(), llmProviderId: z.string().uuid().optional() }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const agentRole = (await db.select().from(roles).where(eq(roles.isAgentRole, true)).limit(1))[0];
    if (!agentRole) return c.json({ error: 'Agent role not configured', code: 'AGENT_ROLE_MISSING' }, 500);

    const rawKey = generateApiKey('ak');
    const [newKey] = await db.insert(apiKeys).values({ tenantId, name: `${result.data.name} API Key`, type: 'agent', keyHash: hashKey(rawKey), permissions: [], status: 'active', createdBy: userId }).returning();
    const [newAgent] = await db.insert(agents).values({ tenantId, name: result.data.name, type: result.data.type, model: result.data.model, llmProviderId: result.data.llmProviderId, apiKeyId: newKey.id, createdBy: userId }).returning();
    await db.insert(memberships).values({ agentId: newAgent.id, tenantId, roleId: agentRole.id, memberType: 'agent', status: 'active' });

    try {
        await db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_created', resource: 'agent', resourceId: newAgent.id, metadata: { type: result.data.type }, traceId: c.get('traceId') ?? '' });
    } catch (auditErr) { console.error('Audit log write failed:', auditErr); }

    return c.json({ data: { agent: newAgent, apiKey: rawKey } }, 201);
}

// PATCH /agents/:id
export async function handleUpdateAgent(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const role = requestContext?.role;

    const canFullUpdate = hasPermission(permissions, 'agents', 'update');
    const isOwner = role === 'owner';
    if (!isOwner && !canFullUpdate) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('id') as string;
    const existing = (await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1))[0];
    if (!existing) return c.json({ error: 'Agent not found' }, 404);

    const result = z.object({ name: z.string().min(1).max(100).optional(), description: z.string().max(500).nullable().optional(), avatarUrl: z.string().url().nullable().optional(), status: z.enum(['active', 'paused', 'retired']).optional(), model: z.string().optional(), llmProviderId: z.string().uuid().optional() }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const updateData = canFullUpdate ? result.data : { name: result.data.name, avatarUrl: result.data.avatarUrl };
    const [updated] = await db.update(agents).set({ ...updateData, updatedAt: new Date() }).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).returning();

    if (result.data.status && canFullUpdate) {
        const action = result.data.status === 'paused' ? 'agent_paused' : result.data.status === 'active' ? 'agent_reactivated' : 'agent_retired';
        try {
            await db.insert(auditLog).values({ tenantId, actorId: c.get('userId') ?? 'system', actorType: 'human', action, resource: 'agent', resourceId: updated.id, metadata: {}, traceId: c.get('traceId') ?? '' });
        } catch (auditErr) { console.error('Audit log write failed:', auditErr); }
    }

    const relayUrl = process.env.RELAY_URL;
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (relayUrl && serviceKey) {
        Promise.resolve().then(async () => {
            await fetch(`${relayUrl}/update/${tenantId}/${agentId}`, { method: 'POST', headers: { 'X-Service-Key': serviceKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentName: updated.name }) });
            console.log(`[agents] update triggered for agent ${agentId}`);
        }).catch((err) => console.error('[agents] update failed:', err));
    }

    return c.json({ data: { agent: updated } });
}

// DELETE /agents/:id
export async function handleDeleteAgent(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'delete')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('id') as string;
    const existing = (await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1))[0];
    if (!existing) return c.json({ error: 'Agent not found' }, 404);

    await db.update(agents).set({ status: 'retired', updatedAt: new Date() }).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (existing.apiKeyId) {
        await db.update(apiKeys).set({ status: 'revoked', revokedAt: new Date() }).where(eq(apiKeys.id, existing.apiKeyId));
    }

    return c.json({ success: true });
}

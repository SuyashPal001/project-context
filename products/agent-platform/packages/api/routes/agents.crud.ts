import { and, eq, count, asc } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { db } from '../db';
import { storageService } from '@serverless-saas/storage';
import { agents, agentWorkflows } from '@serverless-saas/agent-schema/agents';
import { personas } from '@serverless-saas/agent-schema/personas';
import { teamMembers } from '@serverless-saas/agent-schema/teams';
import { users } from '@serverless-saas/database/schema/auth';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { memberships } from '@serverless-saas/database/schema/tenancy';
import { roles, rolePermissions, permissions as permissionsTable } from '@serverless-saas/database/schema/authorization';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { features } from '@serverless-saas/database/schema/entitlements';
import { llmProviders } from '@serverless-saas/database/schema/integrations';
import { hasPermission } from '@serverless-saas/permissions';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const generateApiKey = (prefix: 'sk' | 'ak'): string => `${prefix}_${randomBytes(32).toString('hex')}`;
const hashKey = (rawKey: string): string => createHash('sha256').update(rawKey).digest('hex');

// Shared by DELETE and PATCH status:retired — both are "Fire" and must
// carry the same dependency check.
async function checkFireDependencies(agentId: string): Promise<{ shiftsCount: number; teamsCount: number }> {
    const [[{ value: shiftsCount }], [{ value: teamsCount }]] = await Promise.all([
        db.select({ value: count() }).from(agentWorkflows).where(and(eq(agentWorkflows.agentId, agentId), eq(agentWorkflows.status, 'active'))),
        db.select({ value: count() }).from(teamMembers).where(eq(teamMembers.agentId, agentId)),
    ]);
    return { shiftsCount: Number(shiftsCount), teamsCount: Number(teamsCount) };
}

// Presigned GET URLs expire (1hr — see storageService.getDownloadUrl), so avatarUrl is
// never persisted; only the stable avatarFileId is. Resolve a fresh URL on every read,
// same as chat attachments already do. Swallows a missing/deleted file rather than
// failing the whole agent list/detail response.
async function resolveAvatarUrl(tenantId: string, avatarFileId: string | null): Promise<string | null> {
    if (!avatarFileId) return null;
    try {
        return await storageService.getDownloadUrl(tenantId, avatarFileId);
    } catch {
        return null;
    }
}

// GET /agents
export async function handleListAgents(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const rows = await db
        .select({
            id: agents.id, tenantId: agents.tenantId, name: agents.name, type: agents.type,
            model: agents.model, status: agents.status, llmProviderId: agents.llmProviderId,
            isInternal: agents.isInternal, isDefault: agents.isDefault, description: agents.description, avatarFileId: agents.avatarFileId,
            createdAt: agents.createdAt,
            persona: {
                id: personas.id, slug: personas.slug, name: personas.name, tagline: personas.tagline,
                animationStates: personas.animationStates, skillTags: personas.skillTags, isOfficial: personas.isOfficial,
            },
        })
        .from(agents)
        .leftJoin(personas, eq(agents.personaId, personas.id))
        .where(and(eq(agents.tenantId, tenantId), eq(agents.isInternal, false)))
        .orderBy(asc(agents.createdAt));

    const data = await Promise.all(rows.map(async ({ avatarFileId, ...row }) => ({
        ...row, avatarUrl: await resolveAvatarUrl(tenantId, avatarFileId),
    })));

    return c.json({ data });
}

// GET /agents/:id
export async function handleGetAgent(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('id') as string;
    const agent = (await db
        .select({
            id: agents.id, tenantId: agents.tenantId, name: agents.name, type: agents.type,
            model: agents.model, status: agents.status, apiKeyId: agents.apiKeyId,
            llmProviderId: agents.llmProviderId, avatarFileId: agents.avatarFileId, avatarParams: agents.avatarParams, description: agents.description,
            isInternal: agents.isInternal, createdBy: agents.createdBy, personaId: agents.personaId,
            createdAt: agents.createdAt, updatedAt: agents.updatedAt,
            persona: {
                id: personas.id, slug: personas.slug, name: personas.name, tagline: personas.tagline,
                animationStates: personas.animationStates, skillTags: personas.skillTags, isOfficial: personas.isOfficial,
            },
        })
        .from(agents)
        .leftJoin(personas, eq(agents.personaId, personas.id))
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
        .limit(1))[0];
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

    // avatarFileId stays in the response (unlike the list endpoint) so the identity
    // form can round-trip it unchanged on saves that don't touch the avatar — the
    // resolved avatarUrl alone isn't enough to reconstruct it.
    const avatarUrl = await resolveAvatarUrl(tenantId, agent.avatarFileId);
    return c.json({ ...agent, avatarUrl, llmProvider, createdByName: creator?.name ?? null });
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

    const result = z.object({ name: z.string().min(1).max(100), type: z.enum(['ops', 'support', 'billing', 'custom']), model: z.string().optional(), llmProviderId: z.string().uuid().optional(), personaId: z.string().uuid().optional() }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const agentRole = (await db.select().from(roles).where(eq(roles.isAgentRole, true)).limit(1))[0];
    if (!agentRole) return c.json({ error: 'Agent role not configured', code: 'AGENT_ROLE_MISSING' }, 500);

    const agentRolePermissionRows = await db
        .select({ resource: permissionsTable.resource, action: permissionsTable.action })
        .from(rolePermissions)
        .innerJoin(permissionsTable, eq(rolePermissions.permissionId, permissionsTable.id))
        .where(eq(rolePermissions.roleId, agentRole.id));
    const agentRolePermissionStrings = agentRolePermissionRows.map((p: { resource: string; action: string }) => `${p.resource}:${p.action}`);

    const rawKey = generateApiKey('ak');
    const [newKey] = await db.insert(apiKeys).values({ tenantId, name: `${result.data.name} API Key`, type: 'agent', keyHash: hashKey(rawKey), permissions: agentRolePermissionStrings, status: 'active', createdBy: userId }).returning();
    const [newAgent] = await db.insert(agents).values({ tenantId, name: result.data.name, type: result.data.type, model: result.data.model, llmProviderId: result.data.llmProviderId, personaId: result.data.personaId, apiKeyId: newKey.id, createdBy: userId }).returning();
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

    const body = await c.req.json();
    const result = z.object({
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).nullable().optional(),
        avatarFileId: z.string().uuid().nullable().optional(),
        avatarParams: z.object({
            head: z.enum(['tall', 'round', 'oval']),
            eyes: z.enum(['dots', 'shades', 'visor', 'eyepatch']),
            accessory: z.enum(['cybermohawk', 'hightop', 'animespikes', 'pompadour', 'curtainbangs', 'topknot', 'bikerhelmet', 'bandana', 'hood', 'none']),
            mouth: z.enum(['goatee', 'beard', 'stubble', 'smile', 'none']),
            skinColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
            hairColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
            bgTheme: z.enum(['terracotta', 'light', 'space', 'matrix', 'transparent']),
        }).nullable().optional(),
        status: z.enum(['active', 'paused', 'retired']).optional(),
        model: z.string().optional(),
        llmProviderId: z.string().uuid().optional(),
        personaId: z.string().uuid().nullable().optional(),
    }).safeParse(body);
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    // Retiring via PATCH is the same "Fire" action as DELETE — must carry the
    // same dependency check, or PATCH status:retired trivially bypasses it.
    if (result.data.status === 'retired' && existing.status !== 'retired' && body.force !== true) {
        const { shiftsCount, teamsCount } = await checkFireDependencies(agentId);
        if (shiftsCount > 0 || teamsCount > 0) {
            return c.json({ error: 'Employee has active dependencies', code: 'FIRE_BLOCKED', shiftsCount, teamsCount }, 409);
        }
    }

    const updateData = canFullUpdate ? result.data : { name: result.data.name, avatarFileId: result.data.avatarFileId, avatarParams: result.data.avatarParams, personaId: result.data.personaId };
    const [updated] = await db.update(agents).set({ ...updateData, updatedAt: new Date() }).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).returning();

    if (result.data.status && canFullUpdate) {
        const action = result.data.status === 'paused' ? 'agent_paused' : result.data.status === 'active' ? 'agent_reactivated' : 'agent_retired';
        try {
            await db.insert(auditLog).values({ tenantId, actorId: c.get('userId') ?? 'system', actorType: 'human', action, resource: 'agent', resourceId: updated.id, metadata: {}, traceId: c.get('traceId') ?? '' });
        } catch (auditErr) { console.error('Audit log write failed:', auditErr); }
    }

    const relayUrl = process.env.AGENT_ORCHESTRATOR_URL;
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (relayUrl && serviceKey) {
        Promise.resolve().then(async () => {
            await fetch(`${relayUrl}/update/${tenantId}/${agentId}`, { method: 'POST', headers: { 'X-Service-Key': serviceKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentName: updated.name }) });
            console.log(`[agents] update triggered for agent ${agentId}`);
        }).catch((err) => console.error('[agents] update failed:', err));
    }

    const updatedAvatarUrl = await resolveAvatarUrl(tenantId, updated.avatarFileId);
    return c.json({ data: { agent: { ...updated, avatarUrl: updatedAvatarUrl } } });
}

// DELETE /agents/:id
export async function handleDeleteAgent(c: Context<AppEnv>) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'delete')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const userId = c.get('userId') as string;
    const agentId = c.req.param('id') as string;
    const existing = (await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1))[0];
    if (!existing) return c.json({ error: 'Agent not found' }, 404);

    const force = (await c.req.json().catch(() => ({}))).force === true;
    if (!force) {
        const { shiftsCount, teamsCount } = await checkFireDependencies(agentId);
        if (shiftsCount > 0 || teamsCount > 0) {
            return c.json({ error: 'Employee has active dependencies', code: 'FIRE_BLOCKED', shiftsCount, teamsCount }, 409);
        }
    }

    await db.update(agents).set({ status: 'retired', updatedAt: new Date() }).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (existing.apiKeyId) {
        await db.update(apiKeys).set({ status: 'revoked', revokedAt: new Date() }).where(eq(apiKeys.id, existing.apiKeyId));
    }
    db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_deleted', resource: 'agent', resourceId: agentId, metadata: {}, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));

    return c.json({ success: true });
}

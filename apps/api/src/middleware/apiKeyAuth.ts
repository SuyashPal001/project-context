import { createMiddleware } from 'hono/factory';
import { createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { agents } from '@serverless-saas/agent-schema/agents';
import { memberships } from '@serverless-saas/database/schema/tenancy';
import { rolePermissions, permissions } from '@serverless-saas/database/schema/authorization';
import { intersectPermissions } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const apiKeyAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
        return next(); // No auth header — let downstream middleware handle it
    }

    const token = authHeader.replace('Bearer ', '').trim();

    // Human flow — JWT validated upstream by Cognito + API Gateway, pass through
    if (token.startsWith('eyJ')) return next();

    // Unknown credential format — fail fast before any DB work
    if (!token.startsWith('ak_')) {
        console.log('401 reason: invalid auth header format', { path: c.req.path, tokenPrefix: token.substring(0, 10) });
        return c.json({ error: 'Invalid Authorization header format' }, 401);
    }

    // --- Agent flow (ak_ prefix) ---

    // Hash before lookup — raw keys are never stored (ADR security principle)
    const keyHash = createHash('sha256').update(token).digest('hex');

    const [apiKey] = await db.select().from(apiKeys).where(
        and(
            eq(apiKeys.keyHash, keyHash),
            eq(apiKeys.status, 'active'),
            eq(apiKeys.type, 'agent')
        )
    ).limit(1);

    if (!apiKey) {
        console.log('401 reason: invalid api key', { path: c.req.path, keyHash: keyHash.substring(0, 16) });
        return c.json({ error: 'Invalid API key' }, 401);
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        console.log('401 reason: api key expired', { path: c.req.path, keyId: apiKey.id, expiresAt: apiKey.expiresAt });
        return c.json({ error: 'API key expired' }, 401);
    }

    // Look up the agent this key belongs to via agents.apiKeyId — the link that's
    // actually populated by every agent-creation path. apiKeys.agentId is never
    // written anywhere in this repo and must not be used for this lookup.
    const [agent] = await db.select().from(agents).where(eq(agents.apiKeyId, apiKey.id)).limit(1);

    if (!agent) {
        console.log('401 reason: api key not linked to agent', { path: c.req.path, keyId: apiKey.id, tenantId: apiKey.tenantId });
        return c.json({ error: 'API key is not linked to an agent' }, 401);
    }

    if (agent.status !== 'active') {
        console.log('401 reason: agent not active', { path: c.req.path, agentId: agent.id, agentStatus: agent.status });
        return c.json({ error: 'Agent is not active' }, 401);
    }

    // Membership gives us the role — no membership means no access
    // 403 not 401: we know who it is, it just isn't permitted here
    const [membership] = await db.select().from(memberships).where(
        and(
            eq(memberships.agentId, agent.id),
            eq(memberships.tenantId, apiKey.tenantId),
            eq(memberships.status, 'active')
        )
    ).limit(1);

    if (!membership) {
        console.log('403 reason: agent no active membership', { path: c.req.path, agentId: agent.id, tenantId: apiKey.tenantId });
        return c.json({ error: 'Agent has no active membership in this tenant' }, 403);
    }

    // Resolve permissions from role → role_permissions → permissions
    const permissionRows = await db
        .select({ resource: permissions.resource, action: permissions.action })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(eq(rolePermissions.roleId, membership.roleId));

    // Array of strings, "resource:action" — same format used across the whole platform
    const rolePermissionStrings = permissionRows.map((p: { resource: string; action: string }) =>
        `${p.resource}:${p.action}`
    );

    // Narrow to what this key was actually scoped to at creation. Computed fresh
    // on every request so a later role downgrade also narrows the key automatically.
    const effectivePermissions = intersectPermissions(apiKey.permissions, rolePermissionStrings);

    // Set apiKeyContext — key/agent metadata for other consumers
    c.set('apiKeyContext', {
        keyId: apiKey.id,
        tenantId: apiKey.tenantId,
        type: apiKey.type,
        permissions: effectivePermissions,
    });

    // Set requestContext.permissions — the field every route handler's
    // hasPermission() check reads, regardless of JWT vs API key auth
    const requestContext = (c.get('requestContext' as never) as any) ?? {};
    requestContext.permissions = effectivePermissions;
    c.set('requestContext' as never, requestContext as never);

    c.set('apiKeyId', apiKey.id);
    c.set('agentId', agent.id);
    c.set('actorType', 'agent');

    // Non-blocking usage tracking — failure here must never block the request
    db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id))
        .execute()
        .catch((err: unknown) => console.error('Failed to update API key lastUsedAt:', err));

    return next();
});
import { Hono } from 'hono';
import { z } from 'zod';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { roles } from '@serverless-saas/database/schema/authorization';
import { sessions } from '@serverless-saas/database/schema/auth';
import { agents, agentWorkflows } from '@serverless-saas/agent-schema/agents';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { webhookEndpoints } from '@serverless-saas/database/schema/webhooks';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { getCacheClient, permissionSetKey, tenantContextKey, entitlementSetKey } from '@serverless-saas/cache';
import type { AppEnv } from '../types';

export const workspacesRoutes = new Hono<AppEnv>();

// GET /workspaces/:tenantId — return workspace name + slug
workspacesRoutes.get('/:tenantId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const activeTenantId = requestContext?.tenant?.id as string;
    const pathTenantId = c.req.param('tenantId');

    if (pathTenantId !== activeTenantId) {
        return c.json({ error: 'Forbidden', code: 'TENANT_MISMATCH' }, 403);
    }

    const [tenant] = await db
        .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, activeTenantId))
        .limit(1);

    if (!tenant) return c.json({ error: 'Workspace not found', code: 'NOT_FOUND' }, 404);

    const [{ memberCount }] = await db
        .select({ memberCount: count() })
        .from(memberships)
        .where(and(
            eq(memberships.tenantId, activeTenantId),
            inArray(memberships.status, ['active', 'invited'])
        ));

    return c.json({ workspace: tenant, memberCount });
});

// Helper: check tenantId from path matches active JWT tenant
function verifyTenant(pathTenantId: string, activeTenantId: string) {
    return pathTenantId === activeTenantId;
}

// Helper: get the caller's membership row (with role name)
async function getCallerMembership(tenantId: string, userId: string) {
    const [row] = await db
        .select({ id: memberships.id, roleName: roles.name })
        .from(memberships)
        .innerJoin(roles, eq(memberships.roleId, roles.id))
        .where(and(
            eq(memberships.tenantId, tenantId),
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
        ))
        .limit(1);
    return row ?? null;
}

// PATCH /workspaces/:tenantId — update workspace name and/or slug (owner only)
workspacesRoutes.patch('/:tenantId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const activeTenantId = requestContext?.tenant?.id as string;
    const userId = c.get('userId') as string;
    const pathTenantId = c.req.param('tenantId');

    if (!verifyTenant(pathTenantId, activeTenantId)) {
        return c.json({ error: 'Forbidden', code: 'TENANT_MISMATCH' }, 403);
    }

    const caller = await getCallerMembership(activeTenantId, userId);
    if (!caller || caller.roleName !== 'owner') {
        return c.json({ error: 'Only owners can update workspace settings', code: 'FORBIDDEN' }, 403);
    }

    const schema = z.object({
        name: z.string().min(3).max(50).optional(),
        slug: z.string()
            .min(3)
            .max(50)
            .regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase letters, numbers, and hyphens')
            .optional(),
    });

    const body = await c.req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' }, 400);
    }

    if (!parsed.data.name && !parsed.data.slug) {
        return c.json({ error: 'Nothing to update', code: 'NO_CHANGES' }, 400);
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (parsed.data.name) updateData.name = parsed.data.name;

    if (parsed.data.slug) {
        const [conflicting] = await db
            .select({ id: tenants.id })
            .from(tenants)
            .where(and(eq(tenants.slug, parsed.data.slug), ne(tenants.id, activeTenantId)))
            .limit(1);

        if (conflicting) {
            return c.json({ error: 'This workspace slug is already taken', code: 'SLUG_TAKEN' }, 409);
        }
        updateData.slug = parsed.data.slug;
    }

    const [updated] = await db
        .update(tenants)
        .set(updateData)
        .where(eq(tenants.id, activeTenantId))
        .returning({ id: tenants.id, name: tenants.name, slug: tenants.slug });

    try {
        await db.insert(auditLog).values({
            tenantId: activeTenantId,
            actorId: userId,
            actorType: 'human',
            action: 'tenant_updated',
            resource: 'tenant',
            resourceId: activeTenantId,
            metadata: { updated: parsed.data },
            traceId: c.get('traceId') ?? '',
        });
    } catch (e) {
        console.error('Audit log write failed:', e);
    }

    return c.json({ workspace: updated });
});

// DELETE /workspaces/:tenantId/members/me — leave workspace
workspacesRoutes.delete('/:tenantId/members/me', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const activeTenantId = requestContext?.tenant?.id as string;
    const userId = c.get('userId') as string;
    const pathTenantId = c.req.param('tenantId');

    if (!verifyTenant(pathTenantId, activeTenantId)) {
        return c.json({ error: 'Forbidden', code: 'TENANT_MISMATCH' }, 403);
    }

    const caller = await getCallerMembership(activeTenantId, userId);
    if (!caller) {
        return c.json({ error: 'Membership not found', code: 'NOT_FOUND' }, 404);
    }

    // Sole-owner guard: if this user is the only owner, block leaving
    if (caller.roleName === 'owner') {
        const [{ otherOwners }] = await db
            .select({ otherOwners: count() })
            .from(memberships)
            .innerJoin(roles, eq(memberships.roleId, roles.id))
            .where(and(
                eq(memberships.tenantId, activeTenantId),
                eq(roles.name, 'owner'),
                eq(memberships.status, 'active'),
                ne(memberships.userId, userId),
            ));

        if (otherOwners === 0) {
            return c.json({
                error: 'You are the sole owner of this workspace. Transfer ownership to another member or delete the workspace instead.',
                code: 'SOLE_OWNER_LEAVE_BLOCKED',
            }, 409);
        }
    }

    // Suspend the user's membership
    await db
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(
            eq(memberships.id, caller.id),
            eq(memberships.tenantId, activeTenantId),
        ));

    // Invalidate active sessions for this user in this tenant
    await db
        .update(sessions)
        .set({ status: 'invalidated', invalidatedAt: new Date(), invalidatedReason: 'suspended' })
        .where(and(
            eq(sessions.userId, userId),
            eq(sessions.tenantId, activeTenantId),
        ));

    // Flush Redis permission cache for this user in this tenant
    try {
        const cache = await getCacheClient();
        await cache.del(permissionSetKey(activeTenantId, userId));
    } catch (e) {
        console.error('Cache cleanup error on leave:', e);
    }

    try {
        await db.insert(auditLog).values({
            tenantId: activeTenantId,
            actorId: userId,
            actorType: 'human',
            action: 'member_left',
            resource: 'membership',
            resourceId: caller.id,
            metadata: {},
            traceId: c.get('traceId') ?? '',
        });
    } catch (e) {
        console.error('Audit log write failed:', e);
    }

    return c.json({ success: true });
});

// DELETE /workspaces/:tenantId — delete entire workspace (owner only)
workspacesRoutes.delete('/:tenantId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const activeTenantId = requestContext?.tenant?.id as string;
    const userId = c.get('userId') as string;
    const pathTenantId = c.req.param('tenantId');

    if (!verifyTenant(pathTenantId, activeTenantId)) {
        return c.json({ error: 'Forbidden', code: 'TENANT_MISMATCH' }, 403);
    }

    const caller = await getCallerMembership(activeTenantId, userId);
    if (!caller || caller.roleName !== 'owner') {
        return c.json({ error: 'Only owners can delete a workspace', code: 'FORBIDDEN' }, 403);
    }

    const now = new Date();

    // ── 1. Soft-delete the tenant ─────────────────────────────────────────────
    await db
        .update(tenants)
        .set({ status: 'deleted', deletedAt: now })
        .where(eq(tenants.id, activeTenantId));

    // ── 2. Wind down tenant-scoped resources ──────────────────────────────────
    await db.update(agents)
        .set({ status: 'retired' })
        .where(eq(agents.tenantId, activeTenantId));

    await db.update(agentWorkflows)
        .set({ status: 'archived' })
        .where(eq(agentWorkflows.tenantId, activeTenantId));

    await db.update(apiKeys)
        .set({ status: 'revoked', revokedAt: now })
        .where(and(eq(apiKeys.tenantId, activeTenantId), eq(apiKeys.status, 'active')));

    await db.update(webhookEndpoints)
        .set({ status: 'inactive', deletedAt: now })
        .where(and(eq(webhookEndpoints.tenantId, activeTenantId), eq(webhookEndpoints.status, 'active')));

    // ── 3. Suspend all memberships ────────────────────────────────────────────
    await db.update(memberships)
        .set({ status: 'suspended' })
        .where(and(
            eq(memberships.tenantId, activeTenantId),
            inArray(memberships.status, ['active', 'invited']),
        ));

    // ── 4. Invalidate all sessions for this tenant ────────────────────────────
    await db.update(sessions)
        .set({ status: 'invalidated', invalidatedAt: now, invalidatedReason: 'tenant_deleted' })
        .where(eq(sessions.tenantId, activeTenantId));

    // ── 5. Flush Redis caches for this tenant ─────────────────────────────────
    try {
        const cache = await getCacheClient();
        await cache.del(tenantContextKey(activeTenantId));
        await cache.del(entitlementSetKey(activeTenantId));
        await cache.del(permissionSetKey(activeTenantId, userId));
    } catch (e) {
        console.error('Cache cleanup error on delete workspace:', e);
    }

    // ── 6. Audit log (best-effort; tenant row already soft-deleted) ───────────
    try {
        await db.insert(auditLog).values({
            tenantId: activeTenantId,
            actorId: userId,
            actorType: 'human',
            action: 'tenant_deleted',
            resource: 'tenant',
            resourceId: activeTenantId,
            metadata: { deletedBy: userId },
            traceId: c.get('traceId') ?? '',
        });
    } catch (e) {
        console.error('Audit log write failed:', e);
    }

    return c.json({ success: true });
});

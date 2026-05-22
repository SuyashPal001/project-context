import { and, eq, ilike, desc, count, isNull, gte, lte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { tenants, memberships, users, agents, conversations, tenantFeatureOverrides, features, roles } from '@serverless-saas/database/schema';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { auditLog } from '@serverless-saas/database/schema/audit';

import { isPlatformAdmin } from './ops.guard';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

// GET /ops/tenants
export async function handleListTenants(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const page = parseInt(c.req.query('page') ?? '1');
    const pageSize = parseInt(c.req.query('pageSize') ?? '20');
    const search = c.req.query('search');
    const status = c.req.query('status');

    const conditions = [];
    if (search) conditions.push(ilike(tenants.name, `%${search}%`));
    if (status) conditions.push(eq(tenants.status, status as any));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalRow] = await db.select({ value: count() }).from(tenants).where(where);
    const total = totalRow?.value ?? 0;

    const rows = await db.select().from(tenants)
        .where(where)
        .orderBy(desc(tenants.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

    type TenantRow = typeof rows[number];
    let tenantsWithPlan = rows.map((t: TenantRow) => ({ ...t, plan: null as string | null }));
    if (rows.length > 0) {
        const plans = await db
            .select({ tenantId: subscriptions.tenantId, plan: subscriptions.plan })
            .from(subscriptions)
            .where(inArray(subscriptions.tenantId, rows.map((t: TenantRow) => t.id)));
        const planMap: Record<string, string | null> = Object.fromEntries(
            plans.map((p: typeof plans[number]) => [p.tenantId, p.plan])
        );
        tenantsWithPlan = rows.map((t: TenantRow) => ({ ...t, plan: planMap[t.id] ?? null }));
    }

    return c.json({ tenants: tenantsWithPlan, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
}

// GET /ops/tenants/:id
export async function handleGetTenant(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const tenantId = c.req.param('id') as string;
    const tenant = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
    if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

    const [sub] = await db
        .select({ plan: subscriptions.plan, subscriptionStatus: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, tenantId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);

    const memberRows = await db
        .select({
            membershipId: memberships.id, memberType: memberships.memberType,
            status: memberships.status, joinedAt: memberships.joinedAt,
            createdAt: memberships.createdAt, userId: users.id,
            userName: users.name, userEmail: users.email, roleName: roles.name,
        })
        .from(memberships)
        .leftJoin(users, eq(memberships.userId, users.id))
        .leftJoin(roles, eq(memberships.roleId, roles.id))
        .where(eq(memberships.tenantId, tenantId))
        .orderBy(desc(memberships.createdAt));

    const [agentCountRow] = await db
        .select({ value: count() }).from(agents)
        .where(and(eq(agents.tenantId, tenantId), eq(agents.status, 'active')));

    const [convCountRow] = await db
        .select({ value: count() }).from(conversations)
        .where(eq(conversations.tenantId, tenantId));

    const overrideRows = await db
        .select({
            id: tenantFeatureOverrides.id, featureKey: features.key, featureName: features.name,
            enabled: tenantFeatureOverrides.enabled, valueLimit: tenantFeatureOverrides.valueLimit,
            unlimited: tenantFeatureOverrides.unlimited, reason: tenantFeatureOverrides.reason,
            grantedBy: tenantFeatureOverrides.grantedBy, expiresAt: tenantFeatureOverrides.expiresAt,
            revokedAt: tenantFeatureOverrides.revokedAt, createdAt: tenantFeatureOverrides.createdAt,
        })
        .from(tenantFeatureOverrides)
        .innerJoin(features, eq(tenantFeatureOverrides.featureId, features.id))
        .where(and(eq(tenantFeatureOverrides.tenantId, tenantId), isNull(tenantFeatureOverrides.deletedAt)))
        .orderBy(desc(tenantFeatureOverrides.createdAt));

    const overridesWithStatus = overrideRows.map((o: typeof overrideRows[number]) => ({
        ...o,
        status: o.revokedAt ? 'revoked' : o.expiresAt && new Date(o.expiresAt) < new Date() ? 'expired' : 'active',
    }));

    return c.json({
        tenant: { ...tenant, plan: sub?.plan ?? null, subscriptionStatus: sub?.subscriptionStatus ?? null },
        members: memberRows,
        stats: { memberCount: memberRows.length, activeAgents: agentCountRow?.value ?? 0, totalConversations: convCountRow?.value ?? 0 },
        overrides: overridesWithStatus,
    });
}

// PATCH /ops/tenants/:id
export async function handlePatchTenant(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const tenantId = c.req.param('id') as string;
    const result = z.object({ status: z.enum(['active', 'suspended']) }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const existing = (await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
    if (!existing) return c.json({ error: 'Tenant not found' }, 404);

    const [updated] = await db.update(tenants)
        .set({ status: result.data.status, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId))
        .returning();

    try {
        await db.insert(auditLog).values({
            tenantId, actorId: c.get('userId') ?? 'system', actorType: 'human',
            action: result.data.status === 'suspended' ? 'tenant_suspended' : 'tenant_reactivated',
            resource: 'tenant', resourceId: tenantId, metadata: {}, traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) { console.error('Audit log write failed:', auditErr); }

    return c.json({ data: updated });
}

// GET /ops/audit
export async function handleGetAudit(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const page = parseInt(c.req.query('page') ?? '1');
    const pageSize = parseInt(c.req.query('pageSize') ?? '50');
    const filterTenant = c.req.query('tenantId');
    const filterActorType = c.req.query('actorType') as 'human' | 'agent' | 'system' | undefined;
    const from = c.req.query('from');
    const to = c.req.query('to');

    const conditions: any[] = [];
    if (filterTenant) conditions.push(eq(auditLog.tenantId, filterTenant));
    if (filterActorType) conditions.push(eq(auditLog.actorType, filterActorType));
    if (from) conditions.push(gte(auditLog.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLog.createdAt, new Date(to)));

    const rows = await db
        .select({
            id: auditLog.id, tenantId: auditLog.tenantId, tenantName: tenants.name,
            actorId: auditLog.actorId, actorType: auditLog.actorType, action: auditLog.action,
            resource: auditLog.resource, resourceId: auditLog.resourceId,
            metadata: auditLog.metadata, createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(tenants, eq(auditLog.tenantId, tenants.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(auditLog.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

    const [totalRow] = await db
        .select({ value: count() }).from(auditLog)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

    return c.json({ entries: rows, total: totalRow?.value ?? 0, page, totalPages: Math.ceil((totalRow?.value ?? 0) / pageSize) });
}

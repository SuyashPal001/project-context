import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { features } from '@serverless-saas/database/schema/entitlements';
import { roles } from '@serverless-saas/database/schema/authorization';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { eq, isNull, and, ne, sql } from 'drizzle-orm';
import { resolveWorkspaceLimit } from './tenants.limit';
import type { AppEnv } from '../types';

const tenantCreateSchema = z.object({
    name: z.string().min(3).max(50),
});

const generateSlug = (name: string) => {
    return name.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '-');
};

const checkSlugAvailability = async (slug: string) => {
    const tenant = (await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1))[0];
    return !tenant;
};

const tenantsRoutes = new Hono<AppEnv>();

tenantsRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const userId = c.get('userId');
    // Deliberately NOT `?? {}` — an absent map means entitlementsMiddleware did
    // not run, and coercing it to an empty object is exactly what silently
    // capped every paid plan at one workspace. Let resolveWorkspaceLimit throw.
    const entitlements = requestContext?.entitlements;

    if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json();
    const parsed = tenantCreateSchema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: parsed.error.errors[0].message }, 400);
    }
    const { name } = parsed.data;

    // 1. Check workspace entitlement
    const feature = (await db.select().from(features).where(eq(features.key, 'workspaces')).limit(1))[0];

    if (!feature) {
        return c.json({ error: 'Feature configuration missing', code: 'FEATURE_NOT_FOUND' }, 500);
    }

    const { unlimited: isUnlimited, limit } = resolveWorkspaceLimit(entitlements, feature.id);

    if (!isUnlimited) {
        // Count workspaces the user actively owns.
        //
        // Both filters matter. Without the membership status filter, 'invited'
        // and 'suspended' rows count toward the cap; without the tenant filter,
        // workspaces the user already deleted keep counting. Either one lets the
        // count drift upward permanently and lock a user out of creating a
        // workspace they are entitled to. Mirrors the seat check in
        // invitations.ts, which filters on status for the same reason.
        const result = await db
            .select({ count: sql<number>`cast(count(*) as integer)` })
            .from(memberships)
            .innerJoin(roles, eq(memberships.roleId, roles.id))
            .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
            .where(
                and(
                    eq(memberships.userId, userId),
                    eq(roles.name, 'owner'),
                    eq(memberships.status, 'active'),
                    isNull(tenants.deletedAt),
                    ne(tenants.status, 'deleted')
                )
            );

        const ownerCount = result[0]?.count || 0;

        if (ownerCount >= limit) {
            return c.json({ 
                error: 'Workspace limit reached. Upgrade your plan.', 
                code: 'FEATURE_NOT_ENTITLED', 
                feature: 'workspaces' 
            }, 403);
        }
    }

    // 2. Create workspace
    const slug = generateSlug(name);
    const isAvailable = await checkSlugAvailability(slug);
    let finalSlug = slug;
    if (!isAvailable) {
        const suffix = Math.random().toString(36).substring(2, 6);
        finalSlug = `${slug}-${suffix}`;
    }

    // Find system owner role
    const role = (await db.select().from(roles).where(and(eq(roles.name, 'owner'), isNull(roles.tenantId))).limit(1))[0];
    if (!role) {
        return c.json({ error: 'System configuration error' }, 500);
    }

    const [tenant] = await db.insert(tenants).values({
        name,
        slug: finalSlug,
        type: 'individual',
        status: 'active',
    }).returning();

    await db.insert(memberships).values({
        userId,
        tenantId: tenant.id,
        roleId: role.id,
        memberType: 'human',
        status: 'active',
        joinedAt: new Date(),
    });

    await db.insert(subscriptions).values({
        tenantId: tenant.id,
        plan: 'free',
        status: 'active',
        billingCycle: 'monthly',
        startedAt: new Date(),
    });

    try {
        await db.insert(auditLog).values({
            tenantId: tenant.id,
            actorId: userId,
            actorType: 'human',
            action: 'tenant_created',
            resource: 'tenant',
            resourceId: tenant.id,
            metadata: { slug: finalSlug },
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } }, 201);
});

export { tenantsRoutes };
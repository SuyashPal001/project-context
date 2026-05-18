import { Hono, type Context } from 'hono';
import { and, eq, desc, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { subscriptions, invoices } from '@serverless-saas/database/schema/billing';
import { agents } from '@serverless-saas/database/schema/agents';
import { features, planEntitlements } from '@serverless-saas/database/schema/entitlements';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import { getCacheClient } from '@serverless-saas/cache';
import type { AppEnv } from '../types';


export const billingRoutes = new Hono<AppEnv>();

// GET /billing/subscription — get current active subscription
billingRoutes.get('/subscription', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'billing', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    try {
        const subscription = (await db.select().from(subscriptions).where(and(
            eq(subscriptions.tenantId, tenantId),
            eq(subscriptions.status, 'active')
        )).limit(1))[0];

        return c.json({ subscription: subscription ?? null });
    } catch (err: any) {
        console.error('Get subscription error:', err);
        const code = err.name || 'INTERNAL_ERROR';
        const message = err.message || 'Failed to fetch subscription';
        return c.json({ error: message, code }, 500);
    }
});

// GET /billing/plan — get current active subscription
billingRoutes.get('/plan', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'billing', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const data = (await db.select().from(subscriptions).where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.status, 'active')
    )).limit(1))[0];

    return c.json({ data: data ?? null });
});

// Handler for upgrading/changing subscription plan
const upgradeHandler = async (c: Context<AppEnv>) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'billing', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const schema = z.object({
        plan: z.enum(['free', 'starter', 'business', 'enterprise']),
        billingCycle: z.enum(['monthly', 'annual']).optional().default('monthly'),
    });

    const body = await c.req.json().catch(() => ({}));
    const result = schema.safeParse(body);
    if (!result.success) {
        return c.json({ error: result.error.errors[0].message }, 400);
    }

    // End current active subscription
    await db.update(subscriptions)
        .set({ status: 'cancelled', endedAt: new Date() })
        .where(and(
            eq(subscriptions.tenantId, tenantId),
            eq(subscriptions.status, 'active')
        ));

    // Create new subscription record
    const [newSub] = await db.insert(subscriptions).values({
        tenantId,
        plan: result.data.plan,
        billingCycle: result.data.billingCycle,
        status: 'active',
        startedAt: new Date(),
    }).returning();

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: c.get('userId') ?? 'system',
            actorType: 'human',
            action: 'subscription_updated',
            resource: 'subscription',
            resourceId: newSub.id,
            metadata: { plan: result.data.plan },
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    // Activate/deactivate agents based on new plan's agent limit
    try {
        const agentFeature = (await db.select().from(features).where(eq(features.key, 'agents')).limit(1))[0];
        if (agentFeature) {
            const entitlement = (await db.select().from(planEntitlements).where(
                and(eq(planEntitlements.featureId, agentFeature.id), eq(planEntitlements.plan, result.data.plan))
            ).limit(1))[0];
            const allAgents = await db.select({ id: agents.id }).from(agents)
                .where(and(eq(agents.tenantId, tenantId), eq(agents.isInternal, false)))
                .orderBy(asc(agents.createdAt));
            for (let i = 0; i < allAgents.length; i++) {
                const shouldBeActive = entitlement?.unlimited || i < (entitlement?.valueLimit ?? 1);
                await db.update(agents).set({ status: shouldBeActive ? 'active' : 'paused' }).where(eq(agents.id, allAgents[i].id));
            }
        }
    } catch (agentErr) {
        console.error('Agent activation sync failed:', agentErr);
    }

    // Invalidate entitlements cache so middleware picks up new limits immediately (ADR-013)
    // Direct DEL instead of Pub/Sub — no subscriber exists to handle the channel message
    try {
        await getCacheClient().del(`tenant:${tenantId}:entitlements`);
    } catch (cacheErr) {
        console.error('Entitlements cache invalidation failed:', cacheErr);
    }

    return c.json({ data: newSub }, 201);
};

// POST /billing/upgrade — change plan in DB (legacy name)
// TODO: wire payment provider (Stripe/Paddle) before going live
billingRoutes.post('/upgrade', upgradeHandler);

// POST /billing/subscription — change plan in DB (standard name used by frontend)
billingRoutes.post('/subscription', upgradeHandler);

// POST /billing/cancel — cancel active subscription
// TODO: wire payment provider cancellation before going live
billingRoutes.post('/cancel', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'billing', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const existing = (await db.select().from(subscriptions).where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.status, 'active')
    )).limit(1))[0];

    if (!existing) {
        return c.json({ error: 'No active subscription found' }, 404);
    }

    const [cancelled] = await db.update(subscriptions)
        .set({ status: 'cancelled', endedAt: new Date() })
        .where(eq(subscriptions.id, existing.id))
        .returning();

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: c.get('userId') ?? 'system',
            actorType: 'human',
            action: 'subscription_updated',
            resource: 'subscription',
            resourceId: cancelled.id,
            metadata: { plan: cancelled.plan },
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    // Invalidate entitlements cache
    // Direct DEL instead of Pub/Sub — no subscriber exists to handle the channel message
    try {
        await getCacheClient().del(`tenant:${tenantId}:entitlements`);
    } catch (cacheErr) {
        console.error('Entitlements cache invalidation failed:', cacheErr);
    }

    return c.json({ data: cancelled });
});

// GET /billing/invoices — list invoices for tenant
billingRoutes.get('/invoices', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'billing', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const data = await db.select().from(invoices).where(eq(invoices.tenantId, tenantId)).orderBy(desc(invoices.createdAt)).limit(50);

    return c.json({ data });
});
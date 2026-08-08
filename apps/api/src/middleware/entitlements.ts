import { createMiddleware } from 'hono/factory';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { planEntitlements, tenantFeatureOverrides } from '@serverless-saas/database/schema/entitlements';
import { getCacheClient } from '@serverless-saas/cache';
import type { AppEnv } from '../types';

// 15 minutes — same TTL as tenant context cache
// Invalidated via Redis Pub/Sub on plan upgrade/downgrade or override changes (ADR-013)
const ENTITLEMENTS_CACHE_TTL_SECONDS = 900;

export const entitlementsMiddleware = createMiddleware<AppEnv>(async (c, next) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    // No tenantId = onboarding flow (new user, no workspace yet) — skip entitlement checks. Agent requests always have a tenantId (resolved from the API key) and do run this path.
    if (!tenantId) return next();

    // Cache check — entitlements are expensive to compute (3 DB queries)
    // Key convention: tenant:{tenantId}:entitlements
    const cacheKey = `tenant:${tenantId}:entitlements`;
    const cached = await getCacheClient().get(cacheKey);

    if (cached) {
        if (!c.get('requestContext')) c.set('requestContext', {} as any);
        const requestContext = c.get('requestContext') as any;
        requestContext.entitlements = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return next();
    }

    // Load active subscription to determine current plan
    // Default to 'free' if no subscription found — new tenants always get free tier
    const [subscription] = await db.select().from(subscriptions).where(
        and(
            eq(subscriptions.tenantId, tenantId),
            eq(subscriptions.status, 'active')
        )
    ).limit(1);

    const plan = subscription?.plan ?? 'free';

    // Load all feature entitlements for this plan
    const planEntitlementRows = await db.select().from(planEntitlements).where(
        eq(planEntitlements.plan, plan)
    );

    // Load any tenant-specific overrides — "side deals" that override plan defaults
    // Only active overrides: not deleted, not revoked, not expired
    const overrides = await db.select().from(tenantFeatureOverrides).where(
        and(
            eq(tenantFeatureOverrides.tenantId, tenantId),
            isNull(tenantFeatureOverrides.deletedAt),
            isNull(tenantFeatureOverrides.revokedAt)
        )
    );

    // Build resolved entitlements map: featureId → { enabled, valueLimit, unlimited }
    // Plan entitlements are the baseline — overrides replace them entirely
    const resolved: Record<string, unknown> = {};

    for (const entitlement of planEntitlementRows) {
        resolved[entitlement.featureId] = {
            enabled: entitlement.enabled,
            valueLimit: entitlement.valueLimit,
            unlimited: entitlement.unlimited,
        };
    }

    // Second loop overwrites plan values — overrides always win (feature scoping ADR)
    for (const override of overrides) {
        resolved[override.featureId] = {
            enabled: override.enabled,
            valueLimit: override.valueLimit,
            unlimited: override.unlimited,
        };
    }

    // Cache for subsequent requests and attach to context
    await getCacheClient().set(cacheKey, JSON.stringify(resolved), { ex: ENTITLEMENTS_CACHE_TTL_SECONDS });

    if (!c.get('requestContext')) c.set('requestContext', {} as any);
    const updatedRequestContext = c.get('requestContext') as any;
    updatedRequestContext.entitlements = resolved;
    return next();
});
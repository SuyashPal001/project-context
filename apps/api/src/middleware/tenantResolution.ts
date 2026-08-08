import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { getCacheClient } from '@serverless-saas/cache';
import type { AppEnv } from '../types';

// Routes accessible before onboarding is complete (ADR-026)
// Everything else gets 403 ONBOARDING_REQUIRED until workspace is created
const ONBOARDING_ALLOWED_PATHS = [
    '/api/v1/onboarding/complete',
    '/api/v1/auth/me',
    '/api/v1/auth/tenants',
    '/api/v1/auth/check-email',
    '/api/v1/widget',
];

// 15 minutes — balances performance with freshness
// Tenant status changes (suspension, plan upgrade) reflect within this window
// Invalidated early via Redis Pub/Sub on critical changes (ADR-013)
const TENANT_CACHE_TTL_SECONDS = 900;

export const tenantResolutionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
    // tenantId is stamped into the JWT by the pre-token Lambda at login (ADR-008)
    // API Gateway validates the JWT signature upstream — we just read the claims
    const jwtPayload = c.get('jwtPayload');

    // Agent-authenticated requests never carry a JWT — apiKeyAuthMiddleware (which runs
    // before this middleware) already resolved and validated tenantId for them, via a
    // NOT NULL column, so apiKeyContext.tenantId is always a real value when present.
    const apiKeyContext = c.get('apiKeyContext' as never) as { tenantId?: string } | undefined;
    const tenantId = jwtPayload?.['custom:tenantId'] ?? apiKeyContext?.tenantId;

    // Empty tenantId = new user who hasn't created a workspace yet
    // Set onboarding flag and only allow specific routes through
    if (!tenantId) {
        c.set('requestContext', { needsOnboarding: true } as any);

        const path = c.req.path;
        if (!ONBOARDING_ALLOWED_PATHS.some(p => path.startsWith(p))) {
            console.log('403 reason: onboarding required', { path, tenantId, allowedPaths: ONBOARDING_ALLOWED_PATHS });
            return c.json({ error: 'Onboarding required', code: 'ONBOARDING_REQUIRED' }, 403);
        }

        return next();
    }

    // Cache check — avoid DB round trip on every request
    // Key convention: tenant:{tenantId}:context (from cache key ADR)
    const cacheKey = `tenant:${tenantId}:context`;
    const cached = await getCacheClient().get(cacheKey);

    if (cached) {
        // Upstash REST client auto-deserializes JSON on get — returns object, not string
        // ioredis always returns strings — so we handle both cases here
        // Calling JSON.parse on an already-deserialized object throws: "[object Object] is not valid JSON"
        const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
        const existingRequestContext = (c.get('requestContext') as any) ?? {};
        c.set('requestContext', { ...existingRequestContext, tenant: parsed } as any);
        return next();
    }

    // Cache miss — load from DB
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);

    if (!tenant) {
        console.log('404 reason: tenant not found', { tenantId, path: c.req.path });
        return c.json({ error: 'Tenant not found', code: 'TENANT_NOT_FOUND' }, 404);
    }

    // Suspended tenants are blocked before any business logic runs
    // 403 not 404 — tenant exists, it just isn't permitted (ADR-002)
    if (tenant.status === 'suspended') {
        console.log('403 reason: tenant suspended', { tenantId, slug: tenant.slug, status: tenant.status });
        return c.json({ error: 'Tenant is suspended', code: 'TENANT_SUSPENDED' }, 403);
    }

    // Only store what downstream middleware and routes actually need
    // Plan lives on subscriptions table — loaded separately in entitlements middleware
    const tenantContext = {
        id: tenant.id,
        slug: tenant.slug,
        status: tenant.status,
    };

    // Store in Redis for subsequent requests
    // JSON.stringify because ioredis only stores strings
    // Upstash will store as JSON and return already parsed on next get
    await getCacheClient().set(cacheKey, JSON.stringify(tenantContext), { ex: TENANT_CACHE_TTL_SECONDS });

    const existingRequestContext = (c.get('requestContext') as any) ?? {};
    c.set('requestContext', { ...existingRequestContext, tenant: tenantContext } as any);
    return next();
});

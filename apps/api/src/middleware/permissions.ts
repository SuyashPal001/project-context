import { createMiddleware } from 'hono/factory';
import { db } from '@serverless-saas/database';
import { getCacheClient, permissionSetKey, TTL } from '@serverless-saas/cache';
import { resolveUserPermissions } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

// 15 minutes — same TTL as tenant and entitlements cache.
// Invalidated explicitly on membership/role change by the routes that mutate
// them (workspaces.ts remove-member and delete-workspace, auth.account.ts
// account deletion). Those sites delete permissionSetKey(), so this middleware
// MUST read and write through the same helper — a hand-rolled key string here
// silently defeats every invalidation and leaves revoked permissions live for
// the full TTL.
const PERMISSIONS_CACHE_TTL_SECONDS = TTL.PERMISSION_SET;

export const permissionsMiddleware = createMiddleware<AppEnv>(async (c, next) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');

    // Skip if no tenantId (onboarding flow) or no userId (agent request)
    // Agents have permissions resolved in apiKeyAuthMiddleware already
    if (!tenantId || !userId) return next();

    // Cache check — avoid DB round trip on every request
    const cacheKey = permissionSetKey(tenantId, userId);
    const cached = await getCacheClient().get(cacheKey);

    if (cached) {
        if (!c.get('requestContext')) c.set('requestContext', {} as any);
        const requestContext = c.get('requestContext') as any;
        requestContext.permissions = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return next();
    }

    // Load membership + resolve the role's permission set (shared with any
    // other service that needs the same resolution — see @serverless-saas/permissions).
    const resolvedPermissions = await resolveUserPermissions(db, tenantId, userId);

    // No membership = pass through with no permissions set
    // Route handlers decide if a permission is required
    if (resolvedPermissions === null) return next();

    // Cache and attach to context for route handlers to read
    await getCacheClient().set(cacheKey, JSON.stringify(resolvedPermissions), { ex: PERMISSIONS_CACHE_TTL_SECONDS });

    if (!c.get('requestContext')) c.set('requestContext', {} as any);
    const updatedRequestContext = c.get('requestContext') as any;
    updatedRequestContext.permissions = resolvedPermissions;
    return next();
});

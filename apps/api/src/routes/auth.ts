import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { and, eq } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { users, sessions } from '@serverless-saas/database/schema/auth';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { roles } from '@serverless-saas/database/schema/authorization';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { getCacheClient } from '@serverless-saas/cache';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SignJWT } from 'jose';
import { desc } from 'drizzle-orm';
import { handleDeleteAccount } from './auth.account';
import { handleChangePassword } from './auth.password';

export { authPublicRoutes } from './auth.public';

export const authRoutes = new Hono<AppEnv>();

// WebSocket token secret (cached in-process)
let wsTokenSecret: Uint8Array | undefined;

async function getWsTokenSecret(): Promise<Uint8Array> {
    if (wsTokenSecret) return wsTokenSecret;

    const env = process.env.ENVIRONMENT ?? 'dev';
    const secretName = `/project-context/${env}/ws-token-secret`;
    const ssm = new SSMClient({});
    try {
        const output = await ssm.send(new GetParameterCommand({ Name: secretName, WithDecryption: true }));
        const secretValue = output.Parameter?.Value;
        if (!secretValue) throw new Error('SSM parameter value for ws-token-secret is empty.');
        wsTokenSecret = new TextEncoder().encode(secretValue);
        return wsTokenSecret;
    } catch (error) {
        console.error('Failed to fetch ws-token-secret from SSM:', error);
        throw new Error('Could not load WebSocket token secret.');
    }
}

// GET /auth/me
authRoutes.get('/me', (c) => {
    const requestContext = c.get('requestContext') as any;
    const userId = c.get('userId');
    const jwtPayload = c.get('jwtPayload') as any;

    const rawPermissions: any[] = requestContext?.permissions ?? [];
    const permissionStrings: string[] = rawPermissions.map((p: any) =>
        typeof p === 'string' ? p : `${p.resource}:${p.action}`
    );

    return c.json({
        userId, tenantId: requestContext?.tenant?.id, slug: requestContext?.tenant?.slug,
        status: requestContext?.tenant?.status, role: jwtPayload?.['custom:role'] ?? null,
        permissions: permissionStrings, needsOnboarding: requestContext?.needsOnboarding ?? false,
    });
});

// GET /auth/tenants
authRoutes.get('/tenants', async (c) => {
    const userId = c.get('userId');
    const currentTenantId = c.get('tenantId');
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const userMemberships = await db
        .select({ tenantId: tenants.id, name: tenants.name, slug: tenants.slug, role: roles.name, joinedAt: memberships.joinedAt })
        .from(memberships)
        .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
        .innerJoin(roles, eq(memberships.roleId, roles.id))
        .where(and(eq(memberships.userId, userId as string), eq(memberships.status, 'active')))
        .orderBy(desc(memberships.joinedAt));

    return c.json({
        tenants: userMemberships.map((m: typeof userMemberships[number]) => ({
            ...m, isCurrent: m.tenantId === currentTenantId,
        })),
    });
});

// GET /auth/ws-token
authRoutes.get('/ws-token', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const userId = c.get('userId');
    const tenantId = requestContext?.tenant?.id;

    if (!userId || !tenantId) return c.json({ error: 'User or tenant not found', code: 'UNAUTHORIZED' }, 401);

    try {
        const secret = await getWsTokenSecret();
        const token = await new SignJWT({ userId, tenantId, type: 'ws' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('30s')
            .sign(secret);
        return c.json({ token });
    } catch (error) {
        console.error('Failed to generate ws-token:', error);
        return c.json({ error: 'Failed to generate token', code: 'INTERNAL_ERROR' }, 500);
    }
});

// POST /auth/logout
authRoutes.post('/logout', async (c) => {
    const jwtPayload = c.get('jwtPayload') as any;
    const jti = jwtPayload?.jti;
    const exp = jwtPayload?.exp;

    if (!jti) return c.json({ error: 'No active session' }, 400);

    const now = Math.floor(Date.now() / 1000);
    const ttl = exp ? exp - now : 3600;

    await getCacheClient().set(`session:blacklist:${jti}`, '1', { ex: ttl > 0 ? ttl : 1 });

    const [invalidatedSession] = await db.update(sessions)
        .set({ status: 'invalidated', invalidatedAt: new Date(), invalidatedReason: 'logout' })
        .where(eq(sessions.jwtId, jti)).returning({ id: sessions.id });

    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    if (tenantId) {
        try {
            await db.insert(auditLog).values({
                tenantId, actorId: c.get('userId') ?? 'system', actorType: 'human',
                action: 'user_logged_out', resource: 'session', resourceId: invalidatedSession?.id ?? null,
                metadata: {}, traceId: c.get('traceId') ?? '', ipAddress: c.get('clientIp'),
            });
        } catch (auditErr) { console.error('Audit log write failed:', auditErr); }
    }

    return c.json({ success: true });
});

// POST /auth/switch-tenant
authRoutes.post('/switch-tenant', async (c) => {
    const jwtPayload = c.get('jwtPayload') as any;
    const userId = c.get('userId') as string;
    const jti = jwtPayload?.jti;
    const exp = jwtPayload?.exp;

    const body = await c.req.json();
    const targetTenantId = body?.tenantId;
    if (!targetTenantId) return c.json({ error: 'tenantId is required' }, 400);

    const membership = (await db.select().from(memberships).where(and(
        eq(memberships.userId, userId), eq(memberships.tenantId, targetTenantId), eq(memberships.status, 'active'),
    )).limit(1))[0];
    if (!membership) return c.json({ error: 'You do not belong to this tenant', code: 'TENANT_ACCESS_DENIED' }, 403);

    if (jti) {
        const now = Math.floor(Date.now() / 1000);
        const ttl = exp ? exp - now : 3600;
        await getCacheClient().set(`session:blacklist:${jti}`, '1', { ex: ttl > 0 ? ttl : 1 });
        await db.update(sessions).set({ status: 'invalidated', invalidatedAt: new Date(), invalidatedReason: null }).where(eq(sessions.jwtId, jti));
    }

    return c.json({ success: true, targetTenantId });
});

// POST /auth/set-pending-tenant
authRoutes.post('/set-pending-tenant', async (c) => {
    const userId = c.get('userId') as string;
    const body = await c.req.json();
    const tenantId = body?.tenantId;
    if (!tenantId) return c.json({ error: 'tenantId is required' }, 400);

    const [membership] = await db.select({ id: memberships.id }).from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId), eq(memberships.status, 'active'))).limit(1);
    if (!membership) return c.json({ error: 'No active membership in target tenant' }, 403);

    await db.update(users).set({ pendingTenantId: tenantId }).where(eq(users.id, userId));

    return c.json({ success: true });
});

// DELETE /auth/account
authRoutes.delete('/account', handleDeleteAccount);

// POST /auth/change-password
authRoutes.post('/change-password', handleChangePassword);

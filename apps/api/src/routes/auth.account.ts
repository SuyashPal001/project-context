import { and, eq, isNull, inArray, ne, count } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { users, sessions } from '@serverless-saas/database/schema/auth';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { roles } from '@serverless-saas/database/schema/authorization';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { agents, agentWorkflows } from '@serverless-saas/agent-schema/agents';
import { webhookEndpoints } from '@serverless-saas/database/schema/webhooks';
import { getCacheClient, permissionSetKey } from '@serverless-saas/cache';
import { deleteUser } from '@serverless-saas/auth';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

// DELETE /auth/account — permanently deletes the authenticated user's account
export async function handleDeleteAccount(c: Context<AppEnv>) {
    const userId = c.get('userId') as string;
    const jwtPayload = c.get('jwtPayload') as any;
    const jti = jwtPayload?.jti;
    const exp = jwtPayload?.exp;

    if (!userId) return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);

    try {
        const [user] = await db
            .select({ id: users.id, email: users.email }).from(users)
            .where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1);
        if (!user) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);

        const userMemberships = await db
            .select({ membershipId: memberships.id, tenantId: memberships.tenantId, roleId: memberships.roleId, roleName: roles.name })
            .from(memberships).innerJoin(roles, eq(memberships.roleId, roles.id))
            .where(and(eq(memberships.userId, userId), inArray(memberships.status, ['active', 'invited'])));

        const blockerTenantIds: string[] = [];
        const soloTenantIds: string[] = [];

        for (const m of userMemberships) {
            if (m.roleName !== 'owner') continue;

            const [{ totalMembers }] = await db
                .select({ totalMembers: count() }).from(memberships)
                .where(and(eq(memberships.tenantId, m.tenantId), inArray(memberships.status, ['active', 'invited']), ne(memberships.userId, userId)));

            if (totalMembers === 0) {
                soloTenantIds.push(m.tenantId);
            } else {
                const [{ otherOwners }] = await db
                    .select({ otherOwners: count() }).from(memberships)
                    .innerJoin(roles, eq(memberships.roleId, roles.id))
                    .where(and(eq(memberships.tenantId, m.tenantId), eq(roles.name, 'owner'), inArray(memberships.status, ['active']), ne(memberships.userId, userId)));
                if (otherOwners === 0) blockerTenantIds.push(m.tenantId);
            }
        }

        if (blockerTenantIds.length > 0) {
            const blockerTenants = await db
                .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
                .from(tenants).where(inArray(tenants.id, blockerTenantIds));
            return c.json({
                error: 'You are the sole owner of one or more workspaces that have other members. Transfer ownership or remove all members before deleting your account.',
                code: 'SOLE_OWNER_BLOCKER',
                workspaces: blockerTenants.map((t: { id: string; name: string; slug: string }) => ({ id: t.id, name: t.name, slug: t.slug })),
            }, 409);
        }

        if (soloTenantIds.length > 0) {
            const now = new Date();
            await db.update(tenants).set({ status: 'deleted', deletedAt: now }).where(inArray(tenants.id, soloTenantIds));
            await db.update(agents).set({ status: 'retired' }).where(inArray(agents.tenantId, soloTenantIds));
            await db.update(agentWorkflows).set({ status: 'archived' }).where(inArray(agentWorkflows.tenantId, soloTenantIds));
            await db.update(apiKeys).set({ status: 'revoked', revokedAt: now })
                .where(and(inArray(apiKeys.tenantId, soloTenantIds), eq(apiKeys.status, 'active')));
            await db.update(webhookEndpoints).set({ status: 'inactive', deletedAt: now })
                .where(and(inArray(webhookEndpoints.tenantId, soloTenantIds), eq(webhookEndpoints.status, 'active')));
        }

        if (userMemberships.length > 0) {
            await db.update(memberships).set({ status: 'suspended' })
                .where(inArray(memberships.id, userMemberships.map((m: { membershipId: string }) => m.membershipId)));
        }

        await db.update(apiKeys).set({ status: 'revoked', revokedAt: new Date() })
            .where(and(eq(apiKeys.createdBy, userId), eq(apiKeys.status, 'active')));

        await db.update(sessions).set({ status: 'invalidated', invalidatedAt: new Date(), invalidatedReason: 'logout' })
            .where(eq(sessions.userId, userId));

        try {
            const cache = await getCacheClient();
            if (jti) {
                const now = Math.floor(Date.now() / 1000);
                const ttl = exp ? exp - now : 3600;
                await cache.set(`session:blacklist:${jti}`, '1', { ex: ttl > 0 ? ttl : 1 });
            }
            for (const m of userMemberships) {
                await cache.del(permissionSetKey(m.tenantId, userId));
            }
        } catch (cacheErr) { console.error('Cache cleanup error during account deletion:', cacheErr); }

        await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, userId));

        const auditTenantId = userMemberships[0]?.tenantId ?? null;
        if (auditTenantId) {
            try {
                await db.insert(auditLog).values({
                    tenantId: auditTenantId, actorId: userId, actorType: 'human',
                    action: 'account_deleted', resource: 'user', resourceId: userId,
                    metadata: {
                        email: user.email, tenantsDeleted: soloTenantIds,
                        tenantsLeft: userMemberships.filter((m: { tenantId: string }) => !soloTenantIds.includes(m.tenantId)).map((m: { tenantId: string }) => m.tenantId),
                    },
                    traceId: c.get('traceId') ?? '',
                    ipAddress: c.get('clientIp'),
                });
            } catch (auditErr) { console.error('Audit log write failed during account deletion:', auditErr); }
        }

        try {
            await deleteUser(user.email);
        } catch (cognitoErr: any) {
            if (cognitoErr?.name !== 'UserNotFoundException') {
                console.error('Cognito delete failed:', cognitoErr);
            }
        }

        return c.json({ success: true });
    } catch (error) {
        console.error('Account deletion failed:', error);
        return c.json({ error: 'Failed to delete account', code: 'INTERNAL_ERROR' }, 500);
    }
}

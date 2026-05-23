import { and, eq, isNull, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { tenants, memberships, users, roles } from '@serverless-saas/database/schema';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { createUser, setUserPassword, disableUser } from '@serverless-saas/auth';
import { isPlatformAdmin } from './ops.guard';
import { getLogger } from '@serverless-saas/logger';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

const logger = getLogger({ serviceName: 'ops-api' });

// GET /ops/team
export async function handleListTeam(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const rows = await db
        .select({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .innerJoin(roles, eq(memberships.roleId, roles.id))
        .where(and(eq(roles.name, 'platform_admin'), eq(memberships.status, 'active'), isNull(users.deletedAt)))
        .orderBy(desc(memberships.createdAt));

    return c.json({ team: rows });
}

// POST /ops/team
export async function handleCreateTeamMember(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({ email: z.string().email(), name: z.string().min(1), password: z.string().min(8) })
        .safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const { email, name, password } = result.data;

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return c.json({ error: 'A user with this email already exists', code: 'EMAIL_TAKEN' }, 409);

    let cognitoId: string;
    try {
        cognitoId = await createUser({ email, name });
        await setUserPassword(email, password);
    } catch (err: any) {
        logger.error('ops_team_cognito_create_failed', { traceId: c.get('traceId') ?? 'unknown', email, error: err as Error });
        if (err?.name === 'UsernameExistsException') {
            return c.json({ error: 'A Cognito user with this email already exists', code: 'EMAIL_TAKEN' }, 409);
        }
        return c.json({ error: 'Failed to create user in Cognito', code: 'COGNITO_ERROR' }, 500);
    }

    const [newUser] = await db.insert(users).values({ cognitoId, email, name }).returning();

    let platformTenant = (await db.select().from(tenants).where(eq(tenants.slug, 'platform')).limit(1))[0];
    if (!platformTenant) {
        [platformTenant] = await db.insert(tenants).values({ name: 'Platform', slug: 'platform', type: 'enterprise', status: 'active' }).returning();
    }

    const [existingSub] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.tenantId, platformTenant.id)).limit(1);
    if (!existingSub) {
        await db.insert(subscriptions).values({ tenantId: platformTenant.id, plan: 'enterprise', status: 'active' });
    }

    const [platformAdminRole] = await db.select().from(roles)
        .where(and(eq(roles.name, 'platform_admin'), isNull(roles.tenantId))).limit(1);
    if (!platformAdminRole) return c.json({ error: 'platform_admin role not found — run db:seed', code: 'SEED_MISSING' }, 500);

    await db.insert(memberships).values({
        userId: newUser.id, tenantId: platformTenant.id, roleId: platformAdminRole.id,
        memberType: 'human', status: 'active', joinedAt: new Date(),
    });

    logger.info('ops_team_member_created', { traceId: c.get('traceId') ?? 'unknown', actorId: c.get('userId'), newUserId: newUser.id, email });
    return c.json({ data: { id: newUser.id, name: newUser.name, email: newUser.email, createdAt: newUser.createdAt } }, 201);
}

// DELETE /ops/team/:userId
export async function handleDeleteTeamMember(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const targetUserId = c.req.param('userId') as string;
    const requestingUserId = c.get('userId') as string;

    if (targetUserId === requestingUserId) return c.json({ error: 'You cannot remove yourself', code: 'SELF_REMOVE' }, 400);

    const [membership] = await db
        .select({ membershipId: memberships.id, userEmail: users.email })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .innerJoin(roles, eq(memberships.roleId, roles.id))
        .where(and(eq(memberships.userId, targetUserId), eq(roles.name, 'platform_admin'), eq(memberships.status, 'active')))
        .limit(1);

    if (!membership) return c.json({ error: 'User is not an active platform admin', code: 'NOT_FOUND' }, 404);

    await db.delete(memberships).where(eq(memberships.id, membership.membershipId));

    try {
        await disableUser(membership.userEmail);
    } catch (err: any) {
        logger.warn('ops_team_cognito_disable_failed', { traceId: c.get('traceId') ?? 'unknown', targetUserId, error: err as Error });
    }

    logger.info('ops_team_member_removed', { traceId: c.get('traceId') ?? 'unknown', actorId: requestingUserId, targetUserId });
    return c.json({ success: true });
}

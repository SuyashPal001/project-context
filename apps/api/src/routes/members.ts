import { Hono } from 'hono';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { tenants, memberships } from '@serverless-saas/database/schema/tenancy';
import { invitationTokens } from '@serverless-saas/database/schema/invitations';
import { users } from '@serverless-saas/database/schema/auth';
import { agents } from '@serverless-saas/database/schema/agents';
import { roles } from '@serverless-saas/database/schema/authorization';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { sendEmail } from '@serverless-saas/notifications';
import { createHash, randomBytes } from 'crypto';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const membersRoutes = new Hono<AppEnv>();

// GET /members
// Returns all active members in the tenant with their user and role details
membersRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'members', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    try {
        // Plain join — avoids Drizzle relational API (db.query...with) which requires
        // a fully resolved relations map that is broken by circular schema imports
        const members = await db
            .select({
                id: memberships.id,
                status: memberships.status,
                memberType: memberships.memberType,
                joinedAt: memberships.joinedAt,
                userId: memberships.userId,
                userEmail: users.email,
                userName: users.name,
                userAvatarUrl: users.avatarUrl,
                roleId: roles.id,
                roleName: roles.name,
                agentId: memberships.agentId,
                agentName: agents.name,
                agentType: agents.type,
                invitedEmail: sql<string | null>`(SELECT email FROM invitation_tokens WHERE membership_id = ${memberships.id} ORDER BY created_at DESC LIMIT 1)`,
            })
            .from(memberships)
            .leftJoin(users, and(eq(memberships.userId, users.id), isNull(users.deletedAt)))
            .leftJoin(roles, eq(memberships.roleId, roles.id))
            .leftJoin(agents, eq(memberships.agentId, agents.id))
            .where(and(
                eq(memberships.tenantId, tenantId),
                inArray(memberships.status, ['active', 'invited', 'suspended']),
            ));

        return c.json({ members });
    } catch (err: any) {
        console.error('Get members error:', err);
        const code = err.name || 'INTERNAL_ERROR';
        const message = err.message || 'Failed to fetch members';
        return c.json({ error: message, code }, 500);
    }
});

// PATCH /members/:id/role
// Changes a member's role within the tenant
membersRoutes.patch('/:id/role', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const memberId = c.req.param('id');
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'members', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const schema = z.object({
        roleId: z.string().uuid(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: result.error.errors[0].message }, 400);
    }

    const { roleId } = result.data;

    // Scope update to both id AND tenantId — prevents cross-tenant updates
    const [updated] = await db
        .update(memberships)
        .set({ roleId })
        .where(and(
            eq(memberships.id, memberId),
            eq(memberships.tenantId, tenantId)
        ))
        .returning();

    if (!updated) {
        return c.json({ error: 'Member not found' }, 404);
    }

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: c.get('userId') ?? 'system',
            actorType: 'human',
            action: 'member_role_changed',
            resource: 'membership',
            resourceId: updated.id,
            metadata: { roleId },
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ membership: updated });
});

// PATCH /members/:id/status
// Updates membership status — used to reactivate or suspend a member
membersRoutes.patch('/:id/status', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const memberId = c.req.param('id');
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'members', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const schema = z.object({
        status: z.enum(['active', 'suspended']),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: result.error.errors[0].message }, 400);
    }

    const status = result.data.status;

    // Fetch the membership, joinedAt, email, and tenantName
    const [target] = await db
        .select({
            id: memberships.id,
            status: memberships.status,
            joinedAt: memberships.joinedAt,
            roleId: memberships.roleId,
            userId: memberships.userId,
            email: users.email,
            tenantName: tenants.name,
        })
        .from(memberships)
        .leftJoin(users, eq(memberships.userId, users.id))
        .leftJoin(tenants, eq(memberships.tenantId, tenants.id))
        .where(and(
            eq(memberships.id, memberId),
            eq(memberships.tenantId, tenantId)
        ))
        .limit(1);

    if (!target) {
        return c.json({ error: 'Member not found' }, 404);
    }

    let nextStatus: 'active' | 'suspended' | 'invited' = status;
    let actionResponse = status === 'suspended' ? 'suspended' : 'reactivated';

    if (status === 'suspended') {
        // Suspend membership and revoke any pending tokens
        await db.update(memberships)
            .set({ status: 'suspended' })
            .where(eq(memberships.id, memberId));

        await db.update(invitationTokens)
            .set({ status: 'revoked', revokedAt: new Date(), revokedBy: c.get('userId') })
            .where(and(
                eq(invitationTokens.membershipId, memberId),
                eq(invitationTokens.status, 'pending')
            ));

        nextStatus = 'suspended';
    } else if (status === 'active') {
        if (!target.joinedAt) {
            // Never accepted invitation - resend it
            const rawToken = randomBytes(32).toString('hex');
            const tokenHash = createHash('sha256').update(rawToken).digest('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

            // Revoke any existing pending tokens
            await db.update(invitationTokens)
                .set({ status: 'revoked', revokedAt: new Date(), revokedBy: c.get('userId') })
                .where(and(
                    eq(invitationTokens.membershipId, memberId),
                    eq(invitationTokens.status, 'pending')
                ));

            // Insert new token and email
            if (target.email) {
                await db.insert(invitationTokens).values({
                    tenantId,
                    membershipId: memberId,
                    email: target.email,
                    tokenHash,
                    roleId: target.roleId,
                    invitedBy: c.get('userId') ?? target.userId,
                    status: 'pending',
                    expiresAt,
                });

                const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').trim();
                const inviteUrl = `${appUrl}/auth/invite/${rawToken}`;

                await sendEmail({
                    to: target.email,
                    subject: `You've been invited to ${target.tenantName}`,
                    html: `<p>You've been invited to join <strong>${target.tenantName}</strong>.</p><p><a href="${inviteUrl}">Click here to accept your invitation</a></p><p>This invitation expires in 7 days.</p>`,
                });
            }

            await db.update(memberships)
                .set({ status: 'invited' })
                .where(eq(memberships.id, memberId));

            nextStatus = 'invited';
            actionResponse = 'invite_resent';
        } else {
            // Previously active member - just activate
            await db.update(memberships)
                .set({ status: 'active' })
                .where(eq(memberships.id, memberId));

            nextStatus = 'active';
        }
    }

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: c.get('userId') ?? 'system',
            actorType: 'human',
            action: actionResponse === 'suspended' ? 'member_suspended' : (actionResponse === 'invite_resent' ? 'member_invite_resent' : 'member_reactivated'),
            resource: 'membership',
            resourceId: target.id,
            metadata: actionResponse === 'invite_resent' ? { email: target.email, reason: 'reactivation' } : {},
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ membership: { ...target, status: nextStatus }, success: true, action: actionResponse });
});

// DELETE /members/:id
// Soft deletes a member by suspending their membership (ADR-009)
// Row is preserved for audit trail — hard deleted after 30 day retention window
membersRoutes.delete('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const memberId = c.req.param('id');
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'members', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const userId = c.get('userId');

    // Prevent self-suspension — look up the membership first
    const target = (await db.select().from(memberships).where(and(
        eq(memberships.id, memberId),
        eq(memberships.tenantId, tenantId)
    )).limit(1))[0];

    if (!target) {
        return c.json({ error: 'Member not found' }, 404);
    }

    if (target.userId === userId) {
        return c.json({ error: 'Cannot suspend your own membership', code: 'SELF_SUSPEND_FORBIDDEN' }, 403);
    }

    // Revoke any pending invitation tokens so the invite link can no longer be accepted
    await db.update(invitationTokens)
        .set({ status: 'revoked', revokedAt: new Date(), revokedBy: userId })
        .where(and(
            eq(invitationTokens.membershipId, memberId),
            eq(invitationTokens.status, 'pending')
        ));

    // Soft delete — status: suspended, not a hard DELETE from DB
    const [removed] = await db
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(
            eq(memberships.id, memberId),
            eq(memberships.tenantId, tenantId)
        ))
        .returning();

    if (!removed) {
        return c.json({ error: 'Member not found' }, 404);
    }

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: userId ?? 'system',
            actorType: 'human',
            action: 'member_suspended',
            resource: 'membership',
            resourceId: removed.id,
            metadata: {},
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ success: true });
});

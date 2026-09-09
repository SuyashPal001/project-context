import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { users } from '@serverless-saas/database/schema/auth';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { storageService } from '@serverless-saas/storage';
import type { AppEnv } from '../types';

export const usersRoutes = new Hono<AppEnv>();

// Presigned GET URLs expire (1hr — see storageService.getDownloadUrl), so avatarUrl is
// never persisted; only the stable avatarFileId is. Resolve a fresh URL on every read,
// same pattern agents.avatarFileId already uses (products/agent-platform/packages/api/
// routes/agents.crud.ts). Swallows a missing/deleted file rather than failing the
// whole profile response.
async function resolveAvatarUrl(tenantId: string | undefined, avatarFileId: string | null): Promise<string | null> {
    if (!avatarFileId || !tenantId) return null;
    try {
        return await storageService.getDownloadUrl(tenantId, avatarFileId);
    } catch {
        return null;
    }
}

// GET /users/profile — return authenticated user's profile
usersRoutes.get('/profile', async (c) => {
    const userId = c.get('userId') as string;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email, avatarFileId: users.avatarFileId, personalIdentifier: users.personalIdentifier })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

    if (!user) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);

    const avatarUrl = await resolveAvatarUrl(tenantId, user.avatarFileId);
    return c.json({ user: { ...user, avatarUrl } });
});

// PATCH /users/profile — update authenticated user's display name or avatar
usersRoutes.patch('/profile', async (c) => {
    const userId = c.get('userId') as string;
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const schema = z.object({
        name: z.string().min(1).max(100).optional(),
        avatarFileId: z.string().uuid().nullable().optional(),
        personalIdentifier: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, 'Only letters, numbers, hyphens and underscores').optional().nullable(),
    });

    const body = await c.req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        return c.json({ error: parsed.error.errors[0].message, code: 'VALIDATION_ERROR' }, 400);
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.avatarFileId !== undefined) updateData.avatarFileId = parsed.data.avatarFileId || null;
    if (parsed.data.personalIdentifier !== undefined) updateData.personalIdentifier = parsed.data.personalIdentifier || null;

    const [updated] = await db
        .update(users)
        .set(updateData)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .returning({ id: users.id, name: users.name, email: users.email, avatarFileId: users.avatarFileId, personalIdentifier: users.personalIdentifier });

    if (!updated) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);

    if (tenantId) {
        try {
            await db.insert(auditLog).values({
                tenantId,
                actorId: userId,
                actorType: 'human',
                action: 'user_profile_updated',
                resource: 'user',
                resourceId: userId,
                metadata: { fields: Object.keys(parsed.data) },
                traceId: c.get('traceId') ?? '',
                ipAddress: c.get('clientIp'),
            });
        } catch (e) {
            console.error('Audit log write failed:', e);
        }
    }

    const avatarUrl = await resolveAvatarUrl(tenantId, updated.avatarFileId);
    return c.json({ user: { ...updated, avatarUrl } });
});

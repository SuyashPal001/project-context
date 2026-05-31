import { Hono } from 'hono';
import { and, eq, sql, count } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { features } from '@serverless-saas/database/schema/entitlements';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const apiKeysRoutes = new Hono<AppEnv>();

const generateApiKey = (prefix: 'sk' | 'mk' | 'ak'): string => {
    const random = randomBytes(32).toString('hex');
    return `${prefix}_${random}`;
};

const hashKey = (rawKey: string): string => {
    return createHash('sha256').update(rawKey).digest('hex');
};

// GET /api-keys — list all keys for tenant (metadata only, no raw key)
apiKeysRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'api_keys', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const data = await db.select({
        id: apiKeys.id,
        name: apiKeys.name,
        type: apiKeys.type,
        status: apiKeys.status,
        permissions: apiKeys.permissions,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        createdAt: apiKeys.createdAt,
    }).from(apiKeys).where(and(
        eq(apiKeys.tenantId, tenantId),
        eq(apiKeys.status, 'active')
    ));

    return c.json({ data });
});

// GET /api-keys/:id/usage — return usage for a specific API key
apiKeysRoutes.get('/:id/usage', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'api_keys', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const keyId = c.req.param('id');
    const period = c.req.query('period') === 'monthly' ? 'monthly' : 'daily';
    const startDateParam = c.req.query('startDate');
    const endDateParam = c.req.query('endDate');

    const apiKey = (await db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.tenantId, tenantId)
    )).limit(1))[0];

    if (!apiKey) {
        return c.json({ error: 'API key not found', code: 'NOT_FOUND' }, 404);
    }

    const now = new Date();
    const startDate = startDateParam ? new Date(startDateParam) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = endDateParam ? new Date(endDateParam) : now;

    try {
        const truncFn = period === 'monthly' ? 'month' : 'day';

        const result = await db.execute(sql`
            SELECT
                DATE_TRUNC(${sql.raw(`'${truncFn}'`)}, recorded_at)::text AS date,
                SUM(quantity)::int AS value
            FROM usage_records
            WHERE api_key_id = ${keyId}
              AND tenant_id = ${tenantId}
              AND recorded_at >= ${startDate}
              AND recorded_at <= ${endDate}
            GROUP BY DATE_TRUNC(${sql.raw(`'${truncFn}'`)}, recorded_at)
            ORDER BY DATE_TRUNC(${sql.raw(`'${truncFn}'`)}, recorded_at)
        `);

        const aggregatedData = result as unknown as { date: string; value: number }[];

        const total = aggregatedData.reduce((sum, row) => sum + (row.value || 0), 0);

        const formattedData = aggregatedData.map((row) => ({
            date: row.date.split(' ')[0],
            value: row.value || 0
        }));

        return c.json({
            data: formattedData,
            total,
            keyId: apiKey.id,
            keyName: apiKey.name,
            period
        });

    } catch (error) {
        console.error('Failed to fetch api key usage data:', error);
        return c.json({ error: 'Internal error fetching usage', code: 'INTERNAL_ERROR' }, 500);
    }
});

// POST /api-keys — create new key, return raw key ONCE
apiKeysRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'api_keys', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    // Check api_keys limit
    const entitlements = requestContext?.entitlements as Record<string, { valueLimit?: number; unlimited?: boolean }> | undefined;
    if (entitlements) {
        const [apiKeysFeature] = await db
            .select({ id: features.id })
            .from(features)
            .where(eq(features.key, 'api_keys'))
            .limit(1);

        if (apiKeysFeature) {
            const entitlement = entitlements[apiKeysFeature.id];
            if (entitlement && !entitlement.unlimited) {
                const [{ value: used }] = await db
                    .select({ value: count() })
                    .from(apiKeys)
                    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.status, 'active')));
                const limit = entitlement.valueLimit ?? 0;
                if (Number(used) >= limit) {
                    return c.json({
                        error: `Your plan allows a maximum of ${limit} API keys. Please upgrade to add more.`,
                        code: 'LIMIT_REACHED',
                    }, 403);
                }
            }
        }
    }

    const schema = z.object({
        name: z.string().min(1).max(100),
        type: z.enum(['rest', 'mcp', 'agent']),
        permissions: z.array(z.string()).min(1),
        expiresAt: z.string().datetime().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: result.error.errors[0].message }, 400);
    }

    const prefix = result.data.type === 'agent' ? 'ak' : result.data.type === 'mcp' ? 'mk' : 'sk';
    const rawKey = generateApiKey(prefix);
    const keyHash = hashKey(rawKey);

    const [created] = await db.insert(apiKeys).values({
        tenantId,
        name: result.data.name,
        type: result.data.type,
        keyHash,
        permissions: result.data.permissions,
        status: 'active',
        createdBy: userId,
        expiresAt: result.data.expiresAt ? new Date(result.data.expiresAt) : null,
    }).returning({
        id: apiKeys.id,
        name: apiKeys.name,
        type: apiKeys.type,
        permissions: apiKeys.permissions,
        expiresAt: apiKeys.expiresAt,
        createdAt: apiKeys.createdAt,
    });

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: userId ?? 'system',
            actorType: 'human',
            action: 'api_key_created',
            resource: 'api_key',
            resourceId: created.id,
            metadata: { type: result.data.type },
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    // rawKey returned ONCE here — never stored, never returned again
    return c.json({ data: { ...created, key: rawKey } }, 201);
});

// DELETE /api-keys/:id — revoke a key
apiKeysRoutes.delete('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'api_keys', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const keyId = c.req.param('id');

    const existing = (await db.select().from(apiKeys).where(and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.tenantId, tenantId)
    )).limit(1))[0];

    if (!existing) {
        return c.json({ error: 'API key not found' }, 404);
    }

    await db.update(apiKeys)
        .set({ status: 'revoked', revokedAt: new Date(), revokedBy: userId })
        .where(eq(apiKeys.id, keyId));

    try {
        await db.insert(auditLog).values({
            tenantId,
            actorId: userId ?? 'system',
            actorType: 'human',
            action: 'api_key_revoked',
            resource: 'api_key',
            resourceId: keyId,
            metadata: {},
            traceId: c.get('traceId') ?? '',
        });
    } catch (auditErr) {
        console.error('Audit log write failed:', auditErr);
    }

    return c.json({ success: true });
});
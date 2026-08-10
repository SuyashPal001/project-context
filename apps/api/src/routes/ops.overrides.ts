import { and, eq, desc, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { tenantFeatureOverrides } from '@serverless-saas/database/schema';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { isPlatformAdmin } from './ops.guard';
import { getLogger } from '@serverless-saas/logger';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

const logger = getLogger({ serviceName: 'ops-api' });

// GET /ops/overrides
export async function handleListOverrides(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const page = parseInt(c.req.query('page') ?? '1');
    const pageSize = parseInt(c.req.query('pageSize') ?? '20');

    const data = await db.select().from(tenantFeatureOverrides).where(and(
        isNull(tenantFeatureOverrides.deletedAt),
        isNull(tenantFeatureOverrides.revokedAt),
    )).orderBy(desc(tenantFeatureOverrides.createdAt)).limit(pageSize).offset((page - 1) * pageSize);

    return c.json({ overrides: data, page, pageSize });
}

// POST /ops/overrides
export async function handleCreateOverride(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const userId = c.get('userId');

    const schema = z.object({
        tenantId: z.string().uuid(), featureId: z.string().uuid(),
        enabled: z.boolean().optional(), valueLimit: z.number().int().optional(),
        unlimited: z.boolean().optional(), reason: z.string().min(1),
        expiresAt: z.string().datetime().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const [override] = await db.insert(tenantFeatureOverrides).values({
        tenantId: result.data.tenantId, featureId: result.data.featureId,
        enabled: result.data.enabled, valueLimit: result.data.valueLimit,
        unlimited: result.data.unlimited, reason: result.data.reason,
        grantedBy: userId!, expiresAt: result.data.expiresAt ? new Date(result.data.expiresAt) : null,
    }).returning();

    logger.info('ops_override_granted', { traceId: c.get('traceId') ?? 'unknown', tenantId: result.data.tenantId, featureId: result.data.featureId, overrideId: override.id, actorId: c.get('userId') });
    try {
        await db.insert(auditLog).values({
            tenantId: result.data.tenantId, actorId: c.get('userId') ?? 'system', actorType: 'human',
            action: 'override_granted', resource: 'tenant_feature_override', resourceId: override.id,
            metadata: { featureId: result.data.featureId, reason: result.data.reason },
            traceId: c.get('traceId') ?? '',
            ipAddress: c.get('clientIp'),
        });
    } catch (auditErr) {
        logger.warn('ops_audit_log_write_failed', { traceId: c.get('traceId') ?? 'unknown', action: 'override_granted', overrideId: override.id, error: auditErr as Error });
    }

    return c.json({ data: override }, 201);
}

// POST /ops/overrides/:id/revoke
export async function handleRevokeOverride(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const overrideId = c.req.param('id') as string;
    const userId = c.get('userId') as string;

    const existing = (await db.select().from(tenantFeatureOverrides).where(eq(tenantFeatureOverrides.id, overrideId)).limit(1))[0];
    if (!existing) return c.json({ error: 'Override not found' }, 404);

    const [updated] = await db.update(tenantFeatureOverrides)
        .set({ revokedAt: new Date(), revokedBy: userId })
        .where(eq(tenantFeatureOverrides.id, overrideId))
        .returning();

    logger.info('ops_override_revoked', { traceId: c.get('traceId') ?? 'unknown', tenantId: existing.tenantId, overrideId, actorId: userId });
    try {
        await db.insert(auditLog).values({
            tenantId: existing.tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'override_revoked', resource: 'tenant_feature_override', resourceId: overrideId,
            metadata: {}, traceId: c.get('traceId') ?? '', ipAddress: c.get('clientIp'),
        });
    } catch (auditErr) {
        logger.warn('ops_audit_log_write_failed', { traceId: c.get('traceId') ?? 'unknown', action: 'override_revoked', overrideId, error: auditErr as Error });
    }

    return c.json({ data: updated });
}

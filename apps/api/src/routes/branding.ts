import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { eq } from 'drizzle-orm';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

const brandingRoutes = new Hono<AppEnv>();

const hexColorSchema = z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color');

const brandingUpdateSchema = z.object({
  brandName: z.string().max(100).optional().nullable(),
  logoUrl: z.string().url().or(z.string().length(0)).optional().nullable(),
  brandColor: hexColorSchema.or(z.string().length(0)).optional().nullable(),
  agentDisplayName: z.string().max(100).optional().nullable(),
});

// GET /branding — returns current tenant branding
brandingRoutes.get('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'billing', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  try {
    const tenant = (await db.select({
      brandName: tenants.brandName,
      logoUrl: tenants.logoUrl,
      brandColor: tenants.brandColor,
      agentDisplayName: tenants.agentDisplayName,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1))[0];

    if (!tenant) {
      return c.json({ error: 'Tenant not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ data: tenant });
  } catch (error: any) {
    console.error('Get branding error:', error);
    return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /branding — updates branding fields
brandingRoutes.patch('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId') as string;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'billing', 'update')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  try {
    const body = await c.req.json();
    const parsed = brandingUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten(),
      }, 400);
    }

    const updateData = {
      ...parsed.data,
      updatedAt: new Date(),
    };

    const [updated] = await db.update(tenants)
      .set(updateData)
      .where(eq(tenants.id, tenantId))
      .returning({
        brandName: tenants.brandName,
        logoUrl: tenants.logoUrl,
        brandColor: tenants.brandColor,
        agentDisplayName: tenants.agentDisplayName,
      });

    // Write to audit log
    try {
      await db.insert(auditLog).values({
        tenantId,
        actorId: userId,
        actorType: 'human',
        action: 'tenant_updated',
        resource: 'tenant',
        resourceId: tenantId,
        metadata: { branding: parsed.data },
        traceId: c.get('traceId') ?? '',
        ipAddress: c.get('clientIp'),
      });
    } catch (auditErr) {
      console.error('Audit log write failed:', auditErr);
    }

    return c.json({ data: updated });
  } catch (error: any) {
    console.error('Update branding error:', error);
    return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
  }
});

export { brandingRoutes };

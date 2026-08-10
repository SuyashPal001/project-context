import { Hono } from 'hono';
import { and, eq, desc, isNull } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { webhookEndpoints, webhookDeliveryLog } from '@serverless-saas/database/schema/webhooks';
import { auditLog } from '@serverless-saas/database/schema';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const webhooksRoutes = new Hono<AppEnv>();

// GET /webhooks — list all webhook endpoints for tenant
webhooksRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    console.log('GET /webhooks - tenantId:', tenantId, 'permissions:', permissions);

    if (!hasPermission(permissions, 'webhooks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const data = await db
        .select({
            id: webhookEndpoints.id,
            url: webhookEndpoints.url,
            events: webhookEndpoints.events,
            status: webhookEndpoints.status,
            description: webhookEndpoints.description,
            createdAt: webhookEndpoints.createdAt,
            updatedAt: webhookEndpoints.updatedAt,
            // never return the secret here
        })
        .from(webhookEndpoints)
        .where(and(
            eq(webhookEndpoints.tenantId, tenantId),
            isNull(webhookEndpoints.deletedAt)
        ))
        .orderBy(desc(webhookEndpoints.createdAt));

    console.log('GET /webhooks - result count:', data.length);
    console.log('GET /webhooks - first result:', data[0]);

    return c.json({ data });
});

// GET /webhooks/:id — get specific endpoint details
webhooksRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'webhooks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [data] = await db
        .select({
            id: webhookEndpoints.id,
            url: webhookEndpoints.url,
            events: webhookEndpoints.events,
            status: webhookEndpoints.status,
            description: webhookEndpoints.description,
            createdAt: webhookEndpoints.createdAt,
            updatedAt: webhookEndpoints.updatedAt,
        })
        .from(webhookEndpoints)
        .where(and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.tenantId, tenantId),
            isNull(webhookEndpoints.deletedAt)
        ))
        .limit(1);

    if (!data) {
        return c.json({ error: 'Webhook endpoint not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ data });
});

// GET /webhooks/:id/deliveries — list recent deliveries for this endpoint
webhooksRoutes.get('/:id/deliveries', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'webhooks', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    // Verify endpoint belongs to tenant and exists
    const [endpoint] = await db
        .select()
        .from(webhookEndpoints)
        .where(and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.tenantId, tenantId)
        ))
        .limit(1);

    if (!endpoint) {
        return c.json({ error: 'Webhook endpoint not found', code: 'NOT_FOUND' }, 404);
    }

    const data = await db
        .select()
        .from(webhookDeliveryLog)
        .where(and(
            eq(webhookDeliveryLog.endpointId, id),
            eq(webhookDeliveryLog.tenantId, tenantId)
        ))
        .orderBy(desc(webhookDeliveryLog.createdAt))
        .limit(50);

    return c.json({ data });
});

// POST /webhooks — create new endpoint
webhooksRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'webhooks', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const schema = z.object({
        url: z.string().url().refine((val) => val.startsWith('https://') || val.startsWith('http://localhost') || val.startsWith('http://127.0.0.1'), {
            message: "URL must be https, or a localhost URL for development",
        }),
        events: z.array(z.string()).min(1),
        description: z.string().max(255).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const rawSecret = `whsec_${randomBytes(32).toString('hex')}`;

    try {
        const [created] = await db.insert(webhookEndpoints).values({
            tenantId,
            url: result.data.url,
            events: result.data.events,
            secret: rawSecret,
            status: 'active',
            description: result.data.description,
            createdBy: userId,
        }).returning({
            id: webhookEndpoints.id,
            url: webhookEndpoints.url,
            events: webhookEndpoints.events,
            status: webhookEndpoints.status,
            description: webhookEndpoints.description,
            createdAt: webhookEndpoints.createdAt,
        });

        await db.insert(auditLog).values({
            tenantId,
            actorId: userId ?? 'system',
            actorType: 'human',
            action: 'webhook_created',
            resource: 'webhook_endpoint',
            resourceId: created.id,
            metadata: { url: created.url, events: created.events },
            traceId: c.get('traceId') ?? '',
            ipAddress: c.get('clientIp'),
        }).catch((err: Error) => console.error('Audit log write failed:', err));

        // rawSecret returned ONCE at the top level — not inside data — so the frontend can read res.secret directly.
        // It is not hashed in the DB because it's used to sign payloads (HMAC). The tenant should save it securely.
        return c.json({ data: created, secret: rawSecret }, 201);
    } catch (err: any) {
        console.error('Failed to create webhook:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// PATCH /webhooks/:id — update endpoint (url, events, status, description)
webhooksRoutes.patch('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'webhooks', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const schema = z.object({
        url: z.string().url().refine((val) => val.startsWith('https://') || val.startsWith('http://localhost') || val.startsWith('http://127.0.0.1'), {
            message: "URL must be https, or a localhost URL for development",
        }).optional(),
        events: z.array(z.string()).min(1).optional(),
        status: z.enum(['active', 'inactive']).optional(),
        description: z.string().max(255).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    if (Object.keys(result.data).length === 0) {
        return c.json({ error: 'No fields provided for update', code: 'VALIDATION_ERROR' }, 400);
    }

    // Check existence & ownership
    const [existing] = await db
        .select()
        .from(webhookEndpoints)
        .where(and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.tenantId, tenantId),
            isNull(webhookEndpoints.deletedAt)
        ))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Webhook endpoint not found', code: 'NOT_FOUND' }, 404);
    }

    try {
        const [updated] = await db.update(webhookEndpoints)
            .set({ ...result.data, updatedAt: new Date() })
            .where(eq(webhookEndpoints.id, id))
            .returning({
                id: webhookEndpoints.id,
                url: webhookEndpoints.url,
                events: webhookEndpoints.events,
                status: webhookEndpoints.status,
                description: webhookEndpoints.description,
                updatedAt: webhookEndpoints.updatedAt,
            });

        await db.insert(auditLog).values({
            tenantId,
            actorId: userId ?? 'system',
            actorType: 'human',
            action: 'webhook_updated',
            resource: 'webhook_endpoint',
            resourceId: id,
            metadata: { updates: Object.keys(result.data) },
            traceId: c.get('traceId') ?? '',
            ipAddress: c.get('clientIp'),
        }).catch((err: Error) => console.error('Audit log write failed:', err));

        return c.json({ data: updated });
    } catch (err: any) {
        console.error('Failed to update webhook:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// DELETE /webhooks/:id — soft delete endpoint
webhooksRoutes.delete('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'webhooks', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [existing] = await db
        .select()
        .from(webhookEndpoints)
        .where(and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.tenantId, tenantId),
            isNull(webhookEndpoints.deletedAt)
        ))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Webhook endpoint not found', code: 'NOT_FOUND' }, 404);
    }

    try {
        await db.update(webhookEndpoints)
            .set({ deletedAt: new Date(), status: 'inactive' })
            .where(eq(webhookEndpoints.id, id));

        await db.insert(auditLog).values({
            tenantId,
            actorId: userId ?? 'system',
            actorType: 'human',
            action: 'webhook_deleted',
            resource: 'webhook_endpoint',
            resourceId: id,
            metadata: {},
            traceId: c.get('traceId') ?? '',
            ipAddress: c.get('clientIp'),
        }).catch((err: Error) => console.error('Audit log write failed:', err));

        return c.json({ success: true });
    } catch (err: any) {
        console.error('Failed to delete webhook:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});
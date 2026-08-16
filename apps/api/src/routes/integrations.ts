import { Hono, type Context } from 'hono';
import { and, eq, desc, count } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { integrations } from '@serverless-saas/database/schema/integrations';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { features } from '@serverless-saas/database/schema/entitlements';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import { UUID_RE } from './integrations.crypto';
import { syncToolsAndNotifyRelay } from './integrations.sync';
import { createNangoConnectSession } from './integrations.nango';
import type { AppEnv } from '../types';

export { googleOAuthCallbackRoute, jiraOAuthCallbackRoute, zohoOAuthCallbackRoute } from './integrations.callbacks';

export const integrationsRoutes = new Hono<AppEnv>();

// GET /integrations/providers — static list (must be before /:id)
integrationsRoutes.get('/providers', async (c) => {
    const requestContext = c.get('requestContext') as any;
    if (!hasPermission(requestContext?.permissions ?? [], 'integrations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const providers = [
        { id: 'gmail',    name: 'Gmail',           type: 'oauth', description: 'Read, search and send emails' },
        { id: 'drive',    name: 'Google Drive',    type: 'oauth', description: 'Search and read files from Drive' },
        { id: 'calendar', name: 'Google Calendar', type: 'oauth', description: 'View and create calendar events' },
        { id: 'zoho_crm',  name: 'Zoho CRM',  type: 'oauth', description: 'Manage contacts, leads and deals' },
        { id: 'zoho_mail', name: 'Zoho Mail', type: 'oauth', description: 'Read and send emails via Zoho Mail' },
        { id: 'zoho_cliq', name: 'Zoho Cliq', type: 'oauth', description: 'Send messages and read channels' },
        { id: 'jira',      name: 'Jira',      type: 'oauth', description: 'Read and write Jira issues and projects' },
        { id: 'github', name: 'GitHub', type: 'mcp' },
        { id: 'linear', name: 'Linear', type: 'mcp' },
        { id: 'slack',  name: 'Slack',  type: 'mcp' },
        { id: 'notion', name: 'Notion', type: 'mcp' },
        { id: 'hubspot', name: 'HubSpot', type: 'mcp' },
        { id: 'zapier', name: 'Zapier', type: 'mcp' },
    ];
    return c.json({ data: providers });
});

// ── Google per-service connect helper ─────────────────────────────────────────
async function googleConnectHandler(c: Context<AppEnv>, service: 'gmail' | 'drive' | 'calendar', scope: string) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id as string;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) return c.json({ error: 'Google OAuth not configured', code: 'CONFIGURATION_ERROR' }, 500);

    const tenantRow = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const slug = tenantRow[0]?.slug ?? '';
    const state = Buffer.from(JSON.stringify({ tenantId, userId, slug, service, ts: Date.now() })).toString('base64');
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, access_type: 'offline', prompt: 'consent', state });
    return c.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
}

integrationsRoutes.post('/google/gmail/connect', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    try {
        const { token } = await createNangoConnectSession(tenantId);
        return c.json({ token });
    } catch (err) {
        console.error('[google/gmail/connect] Nango session creation failed:', (err as Error).message);
        return c.json({ error: 'Failed to start Gmail connection', code: 'NANGO_ERROR' }, 502);
    }
});
integrationsRoutes.post('/google/drive/connect', (c) => googleConnectHandler(c, 'drive', 'https://www.googleapis.com/auth/drive'));
integrationsRoutes.post('/google/calendar/connect', (c) => googleConnectHandler(c, 'calendar', 'https://www.googleapis.com/auth/calendar'));

// ── Zoho connect helpers ──────────────────────────────────────────────────────
async function zohoConnectHandler(c: Context<AppEnv>, service: string, scope: string) {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id as string;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const clientId = process.env.ZOHO_CLIENT_ID;
    const redirectUri = process.env.ZOHO_REDIRECT_URI;
    if (!clientId || !redirectUri) return c.json({ error: 'Zoho OAuth not configured', code: 'CONFIGURATION_ERROR' }, 500);

    const tenantRow = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const slug = tenantRow[0]?.slug ?? '';
    const state = Buffer.from(JSON.stringify({ tenantId, userId, slug, service, ts: Date.now() })).toString('base64');
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, access_type: 'offline', prompt: 'consent', state });
    return c.json({ url: `https://accounts.zoho.in/oauth/v2/auth?${params.toString()}` });
}

integrationsRoutes.post('/zoho/crm/connect', (c) => zohoConnectHandler(c, 'zoho_crm', 'ZohoCRM.modules.ALL,ZohoCRM.settings.ALL'));
integrationsRoutes.post('/zoho/mail/connect', (c) => zohoConnectHandler(c, 'zoho_mail', 'ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE'));
integrationsRoutes.post('/zoho/cliq/connect', (c) => zohoConnectHandler(c, 'zoho_cliq', 'ZohoCliq.messages.ALL,ZohoCliq.channels.READ'));

// POST /integrations/jira/connect
integrationsRoutes.post('/jira/connect', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id as string;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const clientId = process.env.JIRA_CLIENT_ID;
    const redirectUri = process.env.JIRA_REDIRECT_URI;
    if (!clientId || !redirectUri) return c.json({ error: 'Jira OAuth not configured', code: 'CONFIGURATION_ERROR' }, 500);

    const tenantRow = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const slug = tenantRow[0]?.slug ?? '';
    const state = Buffer.from(JSON.stringify({ tenantId, userId, slug, service: 'jira', ts: Date.now() })).toString('base64');
    const params = new URLSearchParams({ audience: 'api.atlassian.com', client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'read:jira-work write:jira-work offline_access', prompt: 'consent', state });
    return c.json({ url: `https://auth.atlassian.com/authorize?${params.toString()}` });
});

// GET /integrations — list connected integrations
integrationsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    if (!hasPermission(requestContext?.permissions ?? [], 'integrations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const rows = await db
        .select({ id: integrations.id, provider: integrations.provider, status: integrations.status, permissions: integrations.permissions, createdAt: integrations.createdAt })
        .from(integrations)
        .where(and(eq(integrations.tenantId, tenantId), eq(integrations.status, 'active')))
        .orderBy(desc(integrations.createdAt));
    return c.json({ integrations: rows });
});

// GET /integrations/:id
integrationsRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    if (!hasPermission(requestContext?.permissions ?? [], 'integrations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    const id = c.req.param('id');
    const [data] = await db
        .select({ id: integrations.id, provider: integrations.provider, mcpServerUrl: integrations.mcpServerUrl, status: integrations.status, permissions: integrations.permissions, createdAt: integrations.createdAt, updatedAt: integrations.updatedAt })
        .from(integrations)
        .where(and(eq(integrations.id, id), eq(integrations.tenantId, tenantId)))
        .limit(1);
    if (!data) return c.json({ error: 'Integration not found', code: 'NOT_FOUND' }, 404);
    return c.json({ data });
});

// POST /integrations — create generic MCP integration
integrationsRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const entitlements = requestContext?.entitlements as Record<string, { valueLimit?: number; unlimited?: boolean }> | undefined;
    if (entitlements) {
        const [integrationsFeature] = await db.select({ id: features.id }).from(features).where(eq(features.key, 'integrations')).limit(1);
        if (integrationsFeature) {
            const entitlement = entitlements[integrationsFeature.id];
            if (entitlement && !entitlement.unlimited) {
                const [{ value: used }] = await db.select({ value: count() }).from(integrations)
                    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.status, 'active')));
                const limit = entitlement.valueLimit ?? 0;
                if (Number(used) >= limit) {
                    return c.json({ error: `Your plan allows a maximum of ${limit} integrations. Please upgrade to add more.`, code: 'LIMIT_REACHED' }, 403);
                }
            }
        }
    }

    const schema = z.object({
        provider: z.string().min(1).max(50),
        mcpServerUrl: z.string().url(),
        credentialsEnc: z.string().min(1),
        permissions: z.array(z.string()).optional().default([]),
    });
    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

    try {
        const [created] = await db.insert(integrations).values({
            tenantId, provider: result.data.provider, mcpServerUrl: result.data.mcpServerUrl,
            credentialsEnc: result.data.credentialsEnc, permissions: result.data.permissions,
            status: 'active', createdBy: userId,
        }).returning({ id: integrations.id, provider: integrations.provider, mcpServerUrl: integrations.mcpServerUrl, status: integrations.status, permissions: integrations.permissions, createdAt: integrations.createdAt });

        await db.insert(auditLog).values({
            tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'integration_connected', resource: 'integration', resourceId: created.id,
            metadata: { provider: created.provider }, traceId: c.get('traceId') ?? '', ipAddress: c.get('clientIp'),
        }).catch((err: Error) => console.error('Audit log write failed:', err));

        return c.json({ data: created }, 201);
    } catch (err: any) {
        console.error('Failed to create integration:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// PATCH /integrations/:id
integrationsRoutes.patch('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'integrations', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');
    const schema = z.object({
        status: z.enum(['active', 'disconnected', 'error']).optional(),
        permissions: z.array(z.string()).optional(),
        mcpServerUrl: z.string().url().optional(),
        credentialsEnc: z.string().min(1).optional(),
    });
    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    if (Object.keys(result.data).length === 0) return c.json({ error: 'No fields provided', code: 'VALIDATION_ERROR' }, 400);

    const [existing] = await db.select().from(integrations).where(and(eq(integrations.id, id), eq(integrations.tenantId, tenantId))).limit(1);
    if (!existing) return c.json({ error: 'Integration not found', code: 'NOT_FOUND' }, 404);

    try {
        const [updated] = await db.update(integrations)
            .set({ ...result.data, updatedAt: new Date() })
            .where(eq(integrations.id, id))
            .returning({ id: integrations.id, provider: integrations.provider, mcpServerUrl: integrations.mcpServerUrl, status: integrations.status, permissions: integrations.permissions, updatedAt: integrations.updatedAt });

        await db.insert(auditLog).values({
            tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'integration_updated', resource: 'integration', resourceId: id,
            metadata: { updates: Object.keys(result.data) }, traceId: c.get('traceId') ?? '', ipAddress: c.get('clientIp'),
        }).catch((err: Error) => console.error('Audit log write failed:', err));

        return c.json({ data: updated });
    } catch (err: any) {
        console.error('Failed to update integration:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// DELETE /integrations/:idOrProvider
integrationsRoutes.delete('/:idOrProvider', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'integrations', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const idOrProvider = c.req.param('idOrProvider');
    const isByUuid = UUID_RE.test(idOrProvider);
    const whereClause = isByUuid
        ? and(eq(integrations.id, idOrProvider), eq(integrations.tenantId, tenantId))
        : and(eq(integrations.provider, idOrProvider), eq(integrations.tenantId, tenantId));

    const [existing] = await db.select().from(integrations).where(whereClause).limit(1);
    if (!existing) return c.json({ error: 'Integration not found', code: 'NOT_FOUND' }, 404);

    try {
        if (isByUuid) {
            await db.delete(integrations).where(eq(integrations.id, idOrProvider));
        } else {
            await db.update(integrations).set({ status: 'disconnected', updatedAt: new Date() }).where(whereClause);
        }
        await db.insert(auditLog).values({
            tenantId, actorId: userId ?? 'system', actorType: 'human',
            action: 'integration_disconnected', resource: 'integration', resourceId: existing.id,
            metadata: { provider: existing.provider }, traceId: c.get('traceId') ?? '', ipAddress: c.get('clientIp'),
        }).catch((err: Error) => console.error('Audit log write failed:', err));

        void syncToolsAndNotifyRelay(tenantId, existing.provider, 'remove');
        return c.json({ ok: true });
    } catch (err: any) {
        console.error('Failed to disconnect integration:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

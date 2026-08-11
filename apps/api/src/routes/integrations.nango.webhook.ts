import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { syncToolsAndNotifyRelay } from './integrations.sync';
import type { AppEnv } from '../types';

export const nangoWebhookRoute = new Hono<AppEnv>();

function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
    if (!header) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    try { return timingSafeEqual(a, b); } catch { return false; }
}

// Maps Nango's provider_config_key back to this app's internal provider
// name used throughout the integrations table / PROVIDER_TOOLS_MAP.
// Gmail is the only entry during the pilot — see the design doc.
const NANGO_PROVIDER_TO_INTERNAL: Record<string, string> = {
    'google-mail': 'gmail',
};

nangoWebhookRoute.post('/webhooks/nango', async (c) => {
    const secret = process.env.NANGO_WEBHOOK_SECRET;
    if (!secret) {
        console.error('[nango/webhook] NANGO_WEBHOOK_SECRET not configured');
        return c.json({ error: 'not configured' }, 500);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header('x-nango-hmac-sha256');

    if (!verifySignature(rawBody, signature, secret)) {
        return c.json({ error: 'invalid signature' }, 401);
    }

    let payload: any;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return c.json({ error: 'invalid json' }, 400);
    }

    if (payload.type !== 'auth' || !payload.success) {
        return c.json({ received: true, skipped: 'not a successful auth event' });
    }

    const internalProvider = NANGO_PROVIDER_TO_INTERNAL[payload.providerConfigKey];
    if (!internalProvider) {
        return c.json({ received: true, skipped: `provider=${payload.providerConfigKey}` });
    }

    const tenantId = payload.connectionId as string;
    if (!tenantId) {
        return c.json({ error: 'missing connectionId' }, 400);
    }

    try {
        await db.execute(sql`
            INSERT INTO integrations (tenant_id, provider, credentials_enc, status, permissions, created_by)
            VALUES (${tenantId}, ${internalProvider}, NULL, 'active', ARRAY[${internalProvider}]::text[], NULL)
            ON CONFLICT (tenant_id, provider) DO UPDATE SET
                credentials_enc = NULL, status = 'active',
                permissions = EXCLUDED.permissions, updated_at = NOW()
        `);
    } catch (err) {
        console.error('[nango/webhook] DB upsert failed:', (err as Error).message);
        return c.json({ error: 'db_error' }, 500);
    }

    await db.insert(auditLog).values({
        tenantId, actorId: 'nango-webhook', actorType: 'system',
        action: 'integration_connected', resource: 'integration',
        metadata: { provider: internalProvider }, traceId: c.get('traceId') ?? '',
    }).catch((err: Error) => console.error('Audit log write failed:', err));

    void syncToolsAndNotifyRelay(tenantId, internalProvider, 'add');
    return c.json({ received: true });
});

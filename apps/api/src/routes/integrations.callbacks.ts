import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';

import { encryptCredentials } from './integrations.crypto';
import { syncToolsAndNotifyRelay } from './integrations.sync';
import type { AppEnv } from '../types';

// ── Google OAuth callback ─────────────────────────────────────────────────────

export const googleOAuthCallbackRoute = new Hono<AppEnv>();

googleOAuthCallbackRoute.get('/google/callback', async (c) => {
    const frontendUrl = process.env.FRONTEND_URL ?? '';
    let slug = '';
    const fail = (reason: string) =>
        c.redirect(slug ? `${frontendUrl}/${slug}/dashboard/integrations?error=${reason}` : `${frontendUrl}?error=${reason}`);

    const code = c.req.query('code');
    const stateB64 = c.req.query('state');
    const oauthErr = c.req.query('error');

    if (oauthErr || !code || !stateB64) return fail('google_denied');

    let tenantId: string, userId: string, service: 'drive' | 'calendar';
    try {
        const decoded = JSON.parse(Buffer.from(stateB64, 'base64').toString('utf8')) as {
            tenantId: string; userId: string; slug: string; service: 'drive' | 'calendar'; ts: number;
        };
        if (Date.now() - decoded.ts > 600_000) return fail('state_expired');
        if (!['drive', 'calendar'].includes(decoded.service)) return fail('invalid_state');
        tenantId = decoded.tenantId; userId = decoded.userId; slug = decoded.slug; service = decoded.service;
    } catch {
        return fail('invalid_state');
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return fail('configuration_error');

    let accessToken: string, refreshToken: string, expiresIn: number;
    try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        });
        if (!resp.ok) { console.error('[google/callback] token exchange failed:', resp.status); return fail('token_exchange_failed'); }
        const tokens = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number };
        if (!tokens.access_token || !tokens.refresh_token) { console.error('[google/callback] missing tokens'); return fail('token_exchange_failed'); }
        accessToken = tokens.access_token; refreshToken = tokens.refresh_token; expiresIn = tokens.expires_in;
    } catch (err) {
        console.error('[google/callback] fetch error:', (err as Error).message); return fail('token_exchange_failed');
    }

    const credentialsEnc = encryptCredentials({ accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }, tenantId);
    try {
        await db.execute(sql`
            INSERT INTO integrations (tenant_id, provider, credentials_enc, status, permissions, created_by)
            VALUES (${tenantId}, ${service}, ${credentialsEnc}, 'active', ARRAY[${service}]::text[], ${userId})
            ON CONFLICT (tenant_id, provider) DO UPDATE SET
                credentials_enc = EXCLUDED.credentials_enc, status = 'active',
                permissions = EXCLUDED.permissions, updated_at = NOW()
        `);
    } catch (err) {
        console.error('[google/callback] DB upsert failed:', (err as Error).message); return fail('db_error');
    }

    void syncToolsAndNotifyRelay(tenantId, service, 'add');
    return c.redirect(`${frontendUrl}/${slug}/dashboard/integrations?connected=${service}`);
});

// ── Jira OAuth callback ───────────────────────────────────────────────────────

export const jiraOAuthCallbackRoute = new Hono<AppEnv>();

jiraOAuthCallbackRoute.get('/jira/callback', async (c) => {
    const frontendUrl = process.env.FRONTEND_URL ?? '';
    let slug = '';
    const fail = (reason: string) =>
        c.redirect(slug ? `${frontendUrl}/${slug}/dashboard/integrations?error=${reason}` : `${frontendUrl}?error=${reason}`);

    const code = c.req.query('code');
    const stateB64 = c.req.query('state');
    if (c.req.query('error') || !code || !stateB64) return fail('jira_denied');

    let tenantId: string, userId: string;
    try {
        const decoded = JSON.parse(Buffer.from(stateB64, 'base64').toString('utf8')) as { tenantId: string; userId: string; slug: string; ts: number };
        if (Date.now() - decoded.ts > 600_000) return fail('state_expired');
        tenantId = decoded.tenantId; userId = decoded.userId; slug = decoded.slug;
    } catch {
        return fail('invalid_state');
    }

    const clientId = process.env.JIRA_CLIENT_ID;
    const clientSecret = process.env.JIRA_CLIENT_SECRET;
    const redirectUri = process.env.JIRA_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return fail('configuration_error');

    let accessToken: string, refreshToken: string, expiresIn: number;
    try {
        const resp = await fetch('https://auth.atlassian.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        });
        if (!resp.ok) { console.error('[jira/callback] token exchange failed:', resp.status); return fail('token_exchange_failed'); }
        const tokens = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number };
        if (!tokens.access_token || !tokens.refresh_token) { console.error('[jira/callback] missing tokens'); return fail('token_exchange_failed'); }
        accessToken = tokens.access_token; refreshToken = tokens.refresh_token; expiresIn = tokens.expires_in;
    } catch (err) {
        console.error('[jira/callback] fetch error:', (err as Error).message); return fail('token_exchange_failed');
    }

    const credentialsEnc = encryptCredentials({ accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }, tenantId);
    try {
        await db.execute(sql`
            INSERT INTO integrations (tenant_id, provider, credentials_enc, status, permissions, created_by)
            VALUES (${tenantId}, 'jira', ${credentialsEnc}, 'active', ARRAY['jira']::text[], ${userId})
            ON CONFLICT (tenant_id, provider) DO UPDATE SET
                credentials_enc = EXCLUDED.credentials_enc, status = 'active',
                permissions = EXCLUDED.permissions, updated_at = NOW()
        `);
    } catch (err) {
        console.error('[jira/callback] DB upsert failed:', (err as Error).message); return fail('db_error');
    }

    void syncToolsAndNotifyRelay(tenantId, 'jira', 'add');
    return c.redirect(`${frontendUrl}/${slug}/dashboard/integrations?connected=jira`);
});

// ── Zoho OAuth callback ───────────────────────────────────────────────────────

export const zohoOAuthCallbackRoute = new Hono<AppEnv>();

zohoOAuthCallbackRoute.get('/zoho/callback', async (c) => {
    const frontendUrl = process.env.FRONTEND_URL ?? '';
    let slug = '';
    const fail = (reason: string) =>
        c.redirect(slug ? `${frontendUrl}/${slug}/dashboard/integrations?error=${reason}` : `${frontendUrl}?error=${reason}`);

    const code = c.req.query('code');
    const stateB64 = c.req.query('state');
    if (c.req.query('error') || !code || !stateB64) return fail('zoho_denied');

    let tenantId: string, userId: string, service: string;
    try {
        const decoded = JSON.parse(Buffer.from(stateB64, 'base64').toString('utf8')) as { tenantId: string; userId: string; slug: string; service: string; ts: number };
        if (Date.now() - decoded.ts > 600_000) return fail('state_expired');
        tenantId = decoded.tenantId; userId = decoded.userId; slug = decoded.slug; service = decoded.service;
    } catch {
        return fail('invalid_state');
    }

    const clientId = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const redirectUri = process.env.ZOHO_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return fail('configuration_error');

    let accessToken: string, refreshToken: string, expiresIn: number;
    try {
        const resp = await fetch('https://accounts.zoho.in/oauth/v2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        });
        if (!resp.ok) { console.error('[zoho/callback] token exchange failed:', resp.status); return fail('token_exchange_failed'); }
        const tokens = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number };
        if (!tokens.access_token || !tokens.refresh_token) { console.error('[zoho/callback] missing tokens'); return fail('token_exchange_failed'); }
        accessToken = tokens.access_token; refreshToken = tokens.refresh_token; expiresIn = tokens.expires_in;
    } catch (err) {
        console.error('[zoho/callback] fetch error:', (err as Error).message); return fail('token_exchange_failed');
    }

    const zohoPermission: Record<string, string> = { zoho_crm: 'crm', zoho_mail: 'mail', zoho_cliq: 'cliq' };
    const permission = zohoPermission[service] ?? service;
    const credentialsEnc = encryptCredentials({ accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }, tenantId);

    try {
        await db.execute(sql`
            INSERT INTO integrations (tenant_id, provider, credentials_enc, status, permissions, created_by)
            VALUES (${tenantId}, ${service}, ${credentialsEnc}, 'active', ARRAY[${permission}]::text[], ${userId})
            ON CONFLICT (tenant_id, provider) DO UPDATE SET
                credentials_enc = EXCLUDED.credentials_enc, status = 'active',
                permissions = EXCLUDED.permissions, updated_at = NOW()
        `);
    } catch (err) {
        console.error('[zoho/callback] DB upsert failed:', (err as Error).message); return fail('db_error');
    }

    void syncToolsAndNotifyRelay(tenantId, service, 'add');
    return c.redirect(`${frontendUrl}/${slug}/dashboard/integrations?connected=${service}`);
});

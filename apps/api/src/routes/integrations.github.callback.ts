import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { createSign, createPrivateKey } from 'crypto';
import { db } from '@serverless-saas/database';
import { encryptCredentials } from './integrations.crypto';
import { syncToolsAndNotifyRelay } from './integrations.sync';
import { publishToQueue } from '@serverless-saas/queue';
import type { AppEnv } from '../types';

export const githubCallbackRoute = new Hono<AppEnv>();

// ── App JWT + installation token helpers ──────────────────────────────────────

function base64url(buf: Buffer | string): string {
    return Buffer.from(buf).toString('base64url');
}

function generateAppJwt(): string {
    const appId = process.env.GITHUB_APP_ID;
    const pemRaw = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !pemRaw) throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured');
    const pem = pemRaw.replace(/\\n/g, '\n');
    const key = createPrivateKey(pem);
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(key).toString('base64url')}`;
}

async function ghGet<T>(url: string, token: string, scheme: 'Bearer' | 'token'): Promise<T> {
    const res = await fetch(url, {
        headers: { Authorization: `${scheme} ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub ${url} → ${res.status}: ${await res.text().catch(() => '')}`);
    return res.json() as Promise<T>;
}

async function ghPost<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub ${url} → ${res.status}`);
    return res.json() as Promise<T>;
}

interface GhInstallation { id: number; account: { login: string; type: string } }
interface GhRepo { owner: { login: string }; name: string; full_name: string; default_branch: string }
interface GhRepoList { repositories: GhRepo[] }
interface GhInstallationToken { token: string }

// ── Callback route ────────────────────────────────────────────────────────────

githubCallbackRoute.get('/github/callback', async (c) => {
    const frontendUrl = process.env.FRONTEND_URL ?? '';
    let slug = '';
    const fail = (reason: string) =>
        c.redirect(slug ? `${frontendUrl}/${slug}/dashboard/integrations?error=${reason}` : `${frontendUrl}?error=${reason}`);

    const installationIdRaw = c.req.query('installation_id');
    const setupAction = c.req.query('setup_action');
    const stateB64 = c.req.query('state');
    if (!installationIdRaw || !stateB64) return fail('github_denied');

    const installationId = Number(installationIdRaw);
    if (!Number.isFinite(installationId)) return fail('invalid_installation_id');

    let tenantId: string, userId: string;
    try {
        const decoded = JSON.parse(Buffer.from(stateB64, 'base64').toString('utf8')) as {
            tenantId: string; userId: string; slug: string; service: string; ts: number;
        };
        if (Date.now() - decoded.ts > 600_000) return fail('state_expired');
        if (decoded.service !== 'github') return fail('invalid_state');
        tenantId = decoded.tenantId; userId = decoded.userId; slug = decoded.slug;
    } catch {
        return fail('invalid_state');
    }

    if (setupAction && setupAction !== 'install' && setupAction !== 'update') {
        return fail(`unexpected_setup_action_${setupAction}`);
    }

    // Fetch installation + repos using app JWT and installation token.
    let installation: GhInstallation;
    let repos: GhRepo[];
    try {
        const appJwt = generateAppJwt();
        installation = await ghGet<GhInstallation>(`https://api.github.com/app/installations/${installationId}`, appJwt, 'Bearer');
        const tokenResp = await ghPost<GhInstallationToken>(`https://api.github.com/app/installations/${installationId}/access_tokens`, appJwt);
        const repoList = await ghGet<GhRepoList>('https://api.github.com/installation/repositories?per_page=100', tokenResp.token, 'token');
        repos = repoList.repositories ?? [];
    } catch (err) {
        console.error('[github/callback] GitHub API error:', (err as Error).message);
        return fail('github_api_error');
    }

    try {
        await db.execute(sql`
            INSERT INTO github_installations (tenant_id, installation_id, account_login, account_type)
            VALUES (${tenantId}, ${installationId}, ${installation.account.login}, ${installation.account.type})
            ON CONFLICT (installation_id) DO UPDATE SET
                tenant_id = EXCLUDED.tenant_id,
                account_login = EXCLUDED.account_login,
                account_type = EXCLUDED.account_type,
                deleted_at = NULL,
                updated_at = NOW()
        `);

        for (const repo of repos) {
            await db.execute(sql`
                INSERT INTO github_repos
                    (tenant_id, installation_id, repo_owner, repo_name, repo_full_name, default_branch, status)
                VALUES
                    (${tenantId}, ${installationId}, ${repo.owner.login}, ${repo.name}, ${repo.full_name}, ${repo.default_branch}, 'active')
                ON CONFLICT (tenant_id, repo_full_name) DO UPDATE SET
                    status = 'active',
                    default_branch = EXCLUDED.default_branch,
                    deleted_at = NULL
            `);
        }

        const credentialsEnc = encryptCredentials({ installationId }, tenantId);
        await db.execute(sql`
            INSERT INTO integrations (tenant_id, provider, credentials_enc, status, permissions, created_by)
            VALUES (${tenantId}, 'github', ${credentialsEnc}, 'active', ARRAY['github']::text[], ${userId})
            ON CONFLICT (tenant_id, provider) DO UPDATE SET
                credentials_enc = EXCLUDED.credentials_enc,
                status = 'active',
                permissions = EXCLUDED.permissions,
                updated_at = NOW()
        `);
    } catch (err) {
        console.error('[github/callback] DB upsert failed:', (err as Error).message);
        return fail('db_error');
    }

    const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
    if (queueUrl) {
        for (const repo of repos) {
            publishToQueue(queueUrl, {
                type: 'knowledge.initial_index',
                tenantId,
                installationId,
                repoOwner: repo.owner.login,
                repoName: repo.name,
                defaultBranch: repo.default_branch,
                timestamp: new Date().toISOString(),
            }).catch((e: Error) => console.warn('[github/callback] enqueue failed:', e.message));
        }
    }

    void syncToolsAndNotifyRelay(tenantId, 'github', 'add');
    return c.redirect(`${frontendUrl}/${slug}/dashboard/integrations?connected=github`);
});

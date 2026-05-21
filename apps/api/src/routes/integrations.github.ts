import { Hono } from 'hono';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { githubRepos } from '@serverless-saas/database/schema/github';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const githubIntegrationRoute = new Hono<AppEnv>();

// POST /github/connect
// Returns the GitHub App installation URL with a signed state token.
// Frontend redirects the user's browser there. After installing, GitHub
// will redirect back to GITHUB_REDIRECT_URI (handled by the callback route).
githubIntegrationRoute.post('/github/connect', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id as string;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const appSlug = process.env.GITHUB_APP_SLUG;
    if (!appSlug) {
        return c.json({ error: 'GitHub App not configured', code: 'CONFIGURATION_ERROR' }, 500);
    }

    const [tenantRow] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const slug = tenantRow?.slug ?? '';

    const state = Buffer.from(JSON.stringify({
        tenantId, userId, slug, service: 'github', ts: Date.now(),
    })).toString('base64');

    const url = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
    return c.json({ url });
});

// GET /github/repos — connected repos for the current tenant
githubIntegrationRoute.get('/github/repos', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'integrations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const rows = await db
        .select({
            id:            githubRepos.id,
            repoOwner:     githubRepos.repoOwner,
            repoName:      githubRepos.repoName,
            repoFullName:  githubRepos.repoFullName,
            defaultBranch: githubRepos.defaultBranch,
            lastSyncedAt:  githubRepos.lastSyncedAt,
            createdAt:     githubRepos.createdAt,
        })
        .from(githubRepos)
        .where(and(
            eq(githubRepos.tenantId, tenantId),
            eq(githubRepos.status, 'active'),
            isNull(githubRepos.deletedAt),
        ))
        .orderBy(desc(githubRepos.createdAt));

    return c.json({ repos: rows });
});

import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { githubInstallations, githubRepos } from '@serverless-saas/database/schema/github';
import { integrations } from '@serverless-saas/database/schema/integrations';
import { publishToQueue } from '../lib/sqs';
import type { AppEnv } from '../types';

export const githubWebhookRoute = new Hono<AppEnv>();

function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
    if (!header) return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    try { return timingSafeEqual(a, b); } catch { return false; }
}

githubWebhookRoute.post('/github/webhook', async (c) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
        console.error('[github/webhook] GITHUB_WEBHOOK_SECRET not configured');
        return c.json({ error: 'not configured' }, 500);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header('x-hub-signature-256');

    if (!verifySignature(rawBody, signature, secret)) {
        return c.json({ error: 'invalid signature' }, 401);
    }

    const event = c.req.header('x-github-event');
    let payload: any;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return c.json({ error: 'invalid json' }, 400);
    }

    // GitHub fires a ping event when the webhook is first registered.
    if (event === 'ping') return c.json({ received: true, pong: true });

    // ── installation lifecycle ────────────────────────────────────────────────
    if (event === 'installation') {
        const installationId = payload?.installation?.id as number | undefined;
        if (!installationId) return c.json({ received: true, skipped: 'no installation id' });

        if (payload.action === 'deleted' || payload.action === 'suspend') {
            const [row] = await db.select({ tenantId: githubInstallations.tenantId })
                .from(githubInstallations)
                .where(eq(githubInstallations.installationId, installationId))
                .limit(1);

            await db.update(githubInstallations)
                .set({ deletedAt: new Date(), updatedAt: new Date() })
                .where(eq(githubInstallations.installationId, installationId));

            await db.update(githubRepos)
                .set({ deletedAt: new Date(), status: 'disconnected' })
                .where(and(eq(githubRepos.installationId, installationId), isNull(githubRepos.deletedAt)));

            if (row?.tenantId) {
                await db.update(integrations)
                    .set({ status: 'disconnected', updatedAt: new Date() })
                    .where(and(eq(integrations.tenantId, row.tenantId), eq(integrations.provider, 'github')));
            }
        }
        return c.json({ received: true });
    }

    // ── pull_request merge → trigger knowledge sync ───────────────────────────
    if (event !== 'pull_request') {
        return c.json({ received: true, skipped: `event=${event}` });
    }
    if (payload.action !== 'closed') {
        return c.json({ received: true, skipped: 'pr not closed' });
    }
    if (!payload.pull_request?.merged) {
        return c.json({ received: true, skipped: 'pr not merged' });
    }

    const installationId = payload?.installation?.id as number | undefined;
    if (!installationId) return c.json({ error: 'no installation id' }, 400);

    const [installation] = await db.select({ tenantId: githubInstallations.tenantId })
        .from(githubInstallations)
        .where(and(eq(githubInstallations.installationId, installationId), isNull(githubInstallations.deletedAt)))
        .limit(1);

    if (!installation) {
        return c.json({ received: true, skipped: 'unknown installation' });
    }

    const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
    if (!queueUrl) {
        console.warn('[github/webhook] SQS_PROCESSING_QUEUE_URL not set — dropping');
        return c.json({ received: true, queued: false });
    }

    // Mark repo as recently synced for status visibility (best-effort).
    void db.execute(sql`
        UPDATE github_repos SET last_synced_at = NOW()
        WHERE installation_id = ${installationId}
          AND repo_full_name = ${payload.repository.full_name}
    `).catch(() => {});

    await publishToQueue(queueUrl, {
        type: 'knowledge.sync',
        tenantId: installation.tenantId,
        installationId,
        repoOwner: payload.repository.owner.login,
        repoName: payload.repository.name,
        prNumber: payload.pull_request.number,
        commitSha: payload.pull_request.merge_commit_sha,
        timestamp: new Date().toISOString(),
    });

    return c.json({ received: true, queued: true });
});

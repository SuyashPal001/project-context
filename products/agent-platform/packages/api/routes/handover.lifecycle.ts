import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db';
import { handoverPacks, packSections, packItems } from '@serverless-saas/agent-schema/handover';
import { hasPermission } from '@serverless-saas/permissions';
import { publishToQueue } from '@serverless-saas/queue';
import { mintToken, hashToken } from '../lib/pack-token';
import { computeReadiness } from '../lib/handover-readiness';
import { assertEditable } from '../lib/pack-status';
import type { AppEnv } from '@serverless-saas/types';

export const handoverLifecycleRoutes = new Hono<AppEnv>();

function portalUrl(token: string): string {
    const root = process.env.NEXT_PUBLIC_APP_URL ?? 'https://projectcontext.co';
    return `${root.replace(/\/$/, '')}/p/${token}`;
}

// POST /handover/packs/:packId/send
handoverLifecycleRoutes.post('/packs/:packId/send', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const packId = c.req.param('packId');
    const [pack] = await db.select().from(handoverPacks)
        .where(and(eq(handoverPacks.id, packId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    // Blocks signed AND revoked. Re-sending a `sent` pack stays legal — that
    // re-mints the token and kills the previously shared link.
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const sections = await db.select().from(packSections)
        .where(and(eq(packSections.packId, pack.id), eq(packSections.tenantId, tenantId)));
    const items = await db.select({ sectionId: packItems.sectionId }).from(packItems)
        .where(and(eq(packItems.packId, pack.id), eq(packItems.tenantId, tenantId)));
    const readiness = computeReadiness(pack, sections, items);
    if (readiness.complete < readiness.total) {
        return c.json({ error: 'Pack is not ready to send', code: 'NOT_READY', details: readiness }, 422);
    }

    // A fresh token on every send invalidates any previously shared link.
    const token = mintToken();
    await db.update(handoverPacks)
        .set({ status: 'sent', tokenHash: hashToken(token), sentAt: new Date(), updatedAt: new Date() })
        .where(and(eq(handoverPacks.id, pack.id), eq(handoverPacks.tenantId, tenantId)));

    const url = portalUrl(token);

    try {
        await publishToQueue(process.env.SQS_PROCESSING_QUEUE_URL!, {
            type: 'email.send',
            payload: {
                tenantId,
                to: pack.recipientEmail,
                subject: `${pack.title} — project handover`,
                html: `<p>Your handover pack is ready.</p><p><a href="${url}">${url}</a></p><p>This link is private. Please do not forward it.</p>`,
            },
        } as any);
    } catch (err) {
        // The link is already valid; a failed email must not lose it.
        console.error('Handover email dispatch failed (non-fatal):', err);
    }

    // The only time the raw token is ever returned.
    return c.json({ data: { url, sentAt: new Date().toISOString() } });
});

// POST /handover/packs/:packId/revoke
handoverLifecycleRoutes.post('/packs/:packId/revoke', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    // Revoke is gated on 'update', the same action as send. Anyone who can put a
    // private link in front of a client must be able to kill it — revocation is
    // the only mitigation for a mis-sent or forwarded token.
    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const packId = c.req.param('packId');
    const [pack] = await db.select().from(handoverPacks)
        .where(and(eq(handoverPacks.id, packId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    // A signed pack keeps its record; an already-revoked one is a no-op.
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [updated] = await db.update(handoverPacks)
        .set({ status: 'revoked', tokenHash: null, updatedAt: new Date() })
        .where(and(
            eq(handoverPacks.id, pack.id),
            eq(handoverPacks.tenantId, tenantId),
            isNull(handoverPacks.deletedAt),
        ))
        .returning({ id: handoverPacks.id, status: handoverPacks.status });
    if (!updated) return c.json({ error: 'Pack not found' }, 404);

    return c.json({ data: updated });
});

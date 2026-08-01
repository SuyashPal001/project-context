import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, asc, isNull, inArray } from 'drizzle-orm';
import { db } from '../db';
import { handoverPacks, packSections, packItems } from '@serverless-saas/agent-schema/handover';
import { hashToken } from '../lib/pack-token';
import type { AppEnv } from '@serverless-saas/types';

export const publicPackRoutes = new Hono<AppEnv>();

/**
 * Build the client-facing view of a pack.
 *
 * This is a whitelist, not the internal row with a few fields deleted. Adding
 * a column to handover_packs must never silently publish it. Everything the
 * client does not need — tenant/plan/client/user ids, the token digest, the
 * recipient address, and all workspace provenance — is left out by
 * construction, and the accompanying test asserts their absence.
 */
export function toPublicProjection(
    pack: Record<string, any>,
    sections: Record<string, any>[],
    items: Record<string, any>[],
) {
    const visible = sections.filter((section) => section.isVisible);

    return {
        title: pack.title as string,
        scopeSummary: (pack.scopeSummary ?? null) as string | null,
        deliveryDate: (pack.deliveryDate ?? null) as Date | null,
        status: pack.status as string,
        signedAt: (pack.signedAt ?? null) as Date | null,
        signedByName: (pack.signedByName ?? null) as string | null,
        sections: visible
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((section) => ({
                kind: section.kind as string,
                title: section.title as string,
                subtitle: (section.subtitle ?? null) as string | null,
                eyebrow: (section.eyebrow ?? null) as string | null,
                items: items
                    .filter((item) => item.sectionId === section.id)
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((item) => ({
                        title: item.title as string,
                        description: (item.description ?? null) as string | null,
                        statusLabel: (item.statusLabel ?? null) as string | null,
                        categoryLabel: (item.categoryLabel ?? null) as string | null,
                        url: (item.url ?? null) as string | null,
                    })),
            })),
    };
}

/**
 * Resolve a pack by its portal token. Returns null for anything the caller is
 * not entitled to see — wrong token, draft, revoked, or deleted — so every
 * failure produces an identical 404 and the response cannot be used to probe
 * for pack existence.
 */
async function resolveByToken(token: string) {
    if (typeof token !== 'string' || token.length !== 43) return null;

    const [pack] = await db
        .select()
        .from(handoverPacks)
        .where(and(eq(handoverPacks.tokenHash, hashToken(token)), isNull(handoverPacks.deletedAt)))
        .limit(1);

    if (!pack) return null;
    if (pack.status !== 'sent' && pack.status !== 'signed') return null;
    return pack;
}

// GET /packs/:token
publicPackRoutes.get('/:token', async (c) => {
    const pack = await resolveByToken(c.req.param('token'));
    if (!pack) return c.json({ error: 'Not found' }, 404);

    const sections = await db.select().from(packSections)
        .where(eq(packSections.packId, pack.id))
        .orderBy(asc(packSections.sortOrder));
    const visibleIds = sections.filter((s) => s.isVisible).map((s) => s.id);
    const items = visibleIds.length === 0 ? [] : await db.select().from(packItems)
        .where(inArray(packItems.sectionId, visibleIds))
        .orderBy(asc(packItems.sortOrder));

    return c.json({ data: toPublicProjection(pack, sections, items) });
});

// POST /packs/:token/sign
publicPackRoutes.post('/:token/sign', async (c) => {
    const result = z.object({
        name: z.string().min(1).max(200),
        email: z.string().email(),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await resolveByToken(c.req.param('token'));
    if (!pack) return c.json({ error: 'Not found' }, 404);
    if (pack.status === 'signed') return c.json({ error: 'This pack has already been signed', code: 'ALREADY_SIGNED' }, 409);

    // The pre-check above is racy on its own: two concurrent signs both pass it.
    // Making 'sent' part of the update predicate means only one write can win,
    // and the loser is told the pack is already signed rather than silently
    // overwriting a legal record.
    const signed = await db.update(handoverPacks)
        .set({
            status: 'signed',
            signedAt: new Date(),
            signedByName: result.data.name,
            signedByEmail: result.data.email,
            updatedAt: new Date(),
        })
        .where(and(eq(handoverPacks.id, pack.id), eq(handoverPacks.status, 'sent')))
        .returning({ id: handoverPacks.id });
    if (signed.length === 0) return c.json({ error: 'This pack has already been signed', code: 'ALREADY_SIGNED' }, 409);

    return c.json({ data: { status: 'signed' } });
});

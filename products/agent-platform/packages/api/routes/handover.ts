import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, asc, isNull } from 'drizzle-orm';
import { db } from '../db';
import { handoverPacks, packSections, packItems } from '@serverless-saas/agent-schema/handover';
import { projectPlans } from '@serverless-saas/agent-schema/pm';
import { files } from '@serverless-saas/database/schema/storage';
import { hasPermission } from '@serverless-saas/permissions';
import { seedSections } from '../lib/handover-template';
import { computeReadiness } from '../lib/handover-readiness';
import { generateDeliveredItems } from '../lib/handover-generate';
import { isSafeHttpUrl, SAFE_URL_MESSAGE } from '../lib/safe-url';
import { assertEditable } from '../lib/pack-status';
import { handoverLifecycleRoutes } from './handover.lifecycle';
import type { AppEnv } from '@serverless-saas/types';

export const handoverRoutes = new Hono<AppEnv>();

// Re-exported so existing importers of this module keep working; the single
// implementation now lives in ../lib/pack-status so the lifecycle router can
// share it without a circular import.
export { assertEditable };

async function loadPack(packId: string, tenantId: string) {
    const [pack] = await db
        .select()
        .from(handoverPacks)
        .where(and(eq(handoverPacks.id, packId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);
    return pack ?? null;
}

// POST /handover/packs
handoverRoutes.post('/packs', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        planId: z.string().uuid(),
        title: z.string().min(1).max(200),
        scopeSummary: z.string().max(2000).optional(),
        deliveryDate: z.string().datetime().optional(),
        recipientName: z.string().max(200).optional(),
        recipientEmail: z.string().email().optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const { planId, title, scopeSummary, deliveryDate, recipientName, recipientEmail } = result.data;

    const [plan] = await db
        .select({ id: projectPlans.id, clientId: projectPlans.clientId })
        .from(projectPlans)
        .where(and(eq(projectPlans.id, planId), eq(projectPlans.tenantId, tenantId), isNull(projectPlans.deletedAt)))
        .limit(1);
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const [existing] = await db
        .select({ id: handoverPacks.id })
        .from(handoverPacks)
        .where(and(eq(handoverPacks.planId, planId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);
    if (existing) return c.json({ error: 'This project already has a handover pack', code: 'PACK_EXISTS' }, 409);

    const [pack] = await db.insert(handoverPacks).values({
        tenantId,
        planId,
        clientId: plan.clientId,
        title,
        scopeSummary: scopeSummary ?? null,
        deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
        recipientName: recipientName ?? null,
        recipientEmail: recipientEmail ?? null,
        preparedBy: userId,
        status: 'draft',
    }).returning();

    const insertedSections = await db.insert(packSections).values(
        seedSections().map((section) => ({ ...section, tenantId, packId: pack.id })),
    ).returning();

    const deliveredSection = insertedSections.find((section) => section.kind === 'delivered');
    if (deliveredSection) {
        await generateDeliveredItems(tenantId, planId, pack.id, deliveredSection.id);
    }

    return c.json({ data: pack }, 201);
});

// POST /handover/packs/:packId/sync — re-run generation against this plan's
// current state. Additive only (see generateDeliveredItems) so it is always
// safe to call again after new tasks complete.
handoverRoutes.post('/packs/:packId/sync', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [deliveredSection] = await db.select({ id: packSections.id }).from(packSections)
        .where(and(eq(packSections.packId, pack.id), eq(packSections.tenantId, tenantId), eq(packSections.kind, 'delivered')))
        .limit(1);
    if (!deliveredSection) return c.json({ data: { added: 0 } });

    const added = await generateDeliveredItems(tenantId, pack.planId, pack.id, deliveredSection.id);

    return c.json({ data: { added } });
});

// GET /handover/packs/:packId
handoverRoutes.get('/packs/:packId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);

    const sections = await db.select().from(packSections)
        .where(and(eq(packSections.packId, pack.id), eq(packSections.tenantId, tenantId)))
        .orderBy(asc(packSections.sortOrder));
    const items = await db.select().from(packItems)
        .where(and(eq(packItems.packId, pack.id), eq(packItems.tenantId, tenantId)))
        .orderBy(asc(packItems.sortOrder));

    // tokenHash is a stored secret digest and never leaves the server.
    const { tokenHash, ...safePack } = pack;
    return c.json({ data: { pack: safePack, sections, items } });
});

// GET /handover/packs/:packId/readiness
handoverRoutes.get('/packs/:packId/readiness', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);

    const sections = await db.select().from(packSections)
        .where(and(eq(packSections.packId, pack.id), eq(packSections.tenantId, tenantId)));
    const items = await db.select({ sectionId: packItems.sectionId }).from(packItems)
        .where(and(eq(packItems.packId, pack.id), eq(packItems.tenantId, tenantId)));

    return c.json({ data: computeReadiness(pack, sections, items) });
});

// PATCH /handover/packs/:packId
handoverRoutes.patch('/packs/:packId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        title: z.string().min(1).max(200).optional(),
        scopeSummary: z.string().max(2000).nullable().optional(),
        deliveryDate: z.string().datetime().nullable().optional(),
        recipientName: z.string().max(200).nullable().optional(),
        recipientEmail: z.string().email().nullable().optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const { deliveryDate, ...rest } = result.data;
    const [updated] = await db.update(handoverPacks)
        .set({
            ...rest,
            ...(deliveryDate !== undefined ? { deliveryDate: deliveryDate ? new Date(deliveryDate) : null } : {}),
            updatedAt: new Date(),
        })
        .where(and(eq(handoverPacks.id, pack.id), eq(handoverPacks.tenantId, tenantId)))
        .returning();

    const { tokenHash, ...safePack } = updated;
    return c.json({ data: safePack });
});

// PATCH /handover/packs/:packId/sections/:sectionId
handoverRoutes.patch('/packs/:packId/sections/:sectionId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        title: z.string().min(1).max(200).optional(),
        subtitle: z.string().max(500).nullable().optional(),
        eyebrow: z.string().max(100).nullable().optional(),
        sortOrder: z.number().int().min(0).optional(),
        isVisible: z.boolean().optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [updated] = await db.update(packSections)
        .set({ ...result.data, updatedAt: new Date() })
        .where(and(eq(packSections.id, c.req.param('sectionId')), eq(packSections.packId, pack.id), eq(packSections.tenantId, tenantId)))
        .returning();
    if (!updated) return c.json({ error: 'Section not found' }, 404);

    return c.json({ data: updated });
});

// POST /handover/packs/:packId/items
handoverRoutes.post('/packs/:packId/items', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        sectionId: z.string().uuid(),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        statusLabel: z.string().max(50).optional(),
        categoryLabel: z.string().max(50).optional(),
        sourceType: z.enum(['manual', 'task', 'milestone', 'file']).optional(),
        sourceId: z.string().uuid().optional(),
        fileId: z.string().uuid().optional(),
        url: z.string().url().optional().refine(isSafeHttpUrl, { message: SAFE_URL_MESSAGE }),
        sortOrder: z.number().int().min(0).optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [section] = await db.select({ id: packSections.id }).from(packSections)
        .where(and(eq(packSections.id, result.data.sectionId), eq(packSections.packId, pack.id), eq(packSections.tenantId, tenantId)))
        .limit(1);
    if (!section) return c.json({ error: 'Section not found' }, 404);

    // fileId is a foreign id supplied by the caller. Without this check a pack
    // item could point at another tenant's file row.
    if (result.data.fileId) {
        const [file] = await db.select({ id: files.id }).from(files)
            .where(and(eq(files.id, result.data.fileId), eq(files.tenantId, tenantId), isNull(files.deletedAt)))
            .limit(1);
        if (!file) return c.json({ error: 'File not found' }, 404);
    }

    const [item] = await db.insert(packItems).values({
        ...result.data,
        tenantId,
        packId: pack.id,
        sourceType: result.data.sourceType ?? 'manual',
    }).returning();

    return c.json({ data: item }, 201);
});

// PATCH /handover/packs/:packId/items/:itemId
handoverRoutes.patch('/packs/:packId/items/:itemId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        statusLabel: z.string().max(50).nullable().optional(),
        categoryLabel: z.string().max(50).nullable().optional(),
        url: z.string().url().nullable().optional().refine(isSafeHttpUrl, { message: SAFE_URL_MESSAGE }),
        sortOrder: z.number().int().min(0).optional(),
    }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const [updated] = await db.update(packItems)
        .set({ ...result.data, updatedAt: new Date() })
        .where(and(eq(packItems.id, c.req.param('itemId')), eq(packItems.packId, pack.id), eq(packItems.tenantId, tenantId)))
        .returning();
    if (!updated) return c.json({ error: 'Item not found' }, 404);

    return c.json({ data: updated });
});

// DELETE /handover/packs/:packId/items/:itemId
handoverRoutes.delete('/packs/:packId/items/:itemId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    const locked = assertEditable(pack);
    if (locked) return c.json({ error: locked, code: 'PACK_LOCKED' }, 409);

    const deleted = await db.delete(packItems)
        .where(and(eq(packItems.id, c.req.param('itemId')), eq(packItems.packId, pack.id), eq(packItems.tenantId, tenantId)))
        .returning({ id: packItems.id });
    if (deleted.length === 0) return c.json({ error: 'Item not found' }, 404);

    return c.json({ data: { id: deleted[0].id } });
});

// DELETE /handover/packs/:packId — soft-delete a pack.
// Without this, deleted_at is never written: a mistakenly created pack can
// never be removed, and handover_packs_plan_live_uniq then blocks the project
// from ever getting another one. A signed pack is refused — the client holds a
// link to what they signed, and resolveByToken filters on deleted_at, so
// deleting it would revoke their copy of a completed legal record. Revoke the
// link instead if access needs to end.
handoverRoutes.delete('/packs/:packId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'delete')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const pack = await loadPack(c.req.param('packId'), tenantId);
    if (!pack) return c.json({ error: 'Pack not found' }, 404);
    if (pack.status === 'signed') {
        return c.json({ error: 'This pack has been signed and cannot be deleted', code: 'PACK_LOCKED' }, 409);
    }

    // Clear the token in the same write: a soft-deleted pack must not stay
    // resolvable, and leaving the hash behind would also collide with the
    // unique index if the same token were ever minted again.
    const [deleted] = await db.update(handoverPacks)
        .set({ deletedAt: new Date(), tokenHash: null, updatedAt: new Date() })
        .where(and(
            eq(handoverPacks.id, pack.id),
            eq(handoverPacks.tenantId, tenantId),
            isNull(handoverPacks.deletedAt),
        ))
        .returning({ id: handoverPacks.id });
    if (!deleted) return c.json({ error: 'Pack not found' }, 404);

    return c.json({ data: { id: deleted.id } });
});

// GET /handover/packs?planId=... — resolve the pack for a project.
// The builder page needs this: plan_id is unique among live packs, so a
// project has zero or one pack, and the UI must be able to tell which
// without attempting a create.
handoverRoutes.get('/packs', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'handover_packs', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const planId = c.req.query('planId');
    if (!planId) return c.json({ error: 'planId is required' }, 400);

    const [pack] = await db.select().from(handoverPacks)
        .where(and(eq(handoverPacks.planId, planId), eq(handoverPacks.tenantId, tenantId), isNull(handoverPacks.deletedAt)))
        .limit(1);

    if (!pack) return c.json({ data: null });

    const { tokenHash, ...safePack } = pack;
    return c.json({ data: safePack });
});

handoverRoutes.route('/', handoverLifecycleRoutes);

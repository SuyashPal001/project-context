import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { personas, personaCategoryEnum } from '@serverless-saas/agent-schema/personas';

const CATEGORY_VALUES = personaCategoryEnum.enumValues;
import { isPlatformAdmin } from './ops.guard';
import type { AppEnv } from '@serverless-saas/types';

export const personasRoutes = new Hono<AppEnv>();

// GET /ops/personas — list all personas, newest first
personasRoutes.get('/', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const data = await db.select().from(personas).orderBy(desc(personas.createdAt));
    return c.json({ personas: data });
});

// GET /ops/personas/:id
personasRoutes.get('/:id', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const id = c.req.param('id');
    const [persona] = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
    if (!persona) return c.json({ error: 'Persona not found', code: 'NOT_FOUND' }, 404);
    return c.json({ persona });
});

// POST /ops/personas — create a new draft persona
personasRoutes.post('/', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const schema = z.object({
        slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
        name: z.string().min(1).max(100),
        tagline: z.string().min(1).max(200),
        basePersonality: z.string().min(1),
        category: z.enum(CATEGORY_VALUES),
        skillTags: z.array(z.string()).optional(),
        exampleAssetUrl: z.string().url().optional(),
        exampleCaption: z.string().max(200).optional(),
        exampleAssetUrl2: z.string().url().optional(),
        exampleCaption2: z.string().max(200).optional(),
        isOfficial: z.boolean().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

    const { slug, name, tagline, basePersonality, category, skillTags, exampleAssetUrl, exampleCaption, exampleAssetUrl2, exampleCaption2, isOfficial } = result.data;

    const [existing] = await db.select({ id: personas.id }).from(personas).where(eq(personas.slug, slug)).limit(1);
    if (existing) return c.json({ error: 'Slug already in use', code: 'DUPLICATE_SLUG' }, 409);

    const [created] = await db
        .insert(personas)
        .values({
            slug, name, tagline, basePersonality, category,
            skillTags: skillTags ?? [],
            exampleAssetUrl: exampleAssetUrl ?? null,
            exampleCaption: exampleCaption ?? null,
            exampleAssetUrl2: exampleAssetUrl2 ?? null,
            exampleCaption2: exampleCaption2 ?? null,
            isOfficial: isOfficial ?? true,
            status: 'draft',
            createdBy: userId,
        })
        .returning();

    return c.json({ persona: created }, 201);
});

// PUT /ops/personas/:id — update a draft persona only
personasRoutes.put('/:id', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const id = c.req.param('id');
    const [existing] = await db.select({ id: personas.id, status: personas.status }).from(personas).where(eq(personas.id, id)).limit(1);
    if (!existing) return c.json({ error: 'Persona not found', code: 'NOT_FOUND' }, 404);
    if (existing.status !== 'draft') return c.json({ error: 'Only draft personas can be edited', code: 'INVALID_STATE' }, 409);

    const schema = z.object({
        name: z.string().min(1).max(100).optional(),
        tagline: z.string().min(1).max(200).optional(),
        basePersonality: z.string().min(1).optional(),
        category: z.enum(CATEGORY_VALUES).optional(),
        skillTags: z.array(z.string()).optional(),
        exampleAssetUrl: z.string().url().optional(),
        exampleCaption: z.string().max(200).optional(),
        exampleAssetUrl2: z.string().url().optional(),
        exampleCaption2: z.string().max(200).optional(),
        isOfficial: z.boolean().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    if (Object.keys(result.data).length === 0) return c.json({ error: 'No fields provided for update', code: 'VALIDATION_ERROR' }, 400);

    const [updated] = await db.update(personas).set({ ...result.data, updatedAt: new Date() }).where(eq(personas.id, id)).returning();
    return c.json({ persona: updated });
});

// POST /ops/personas/:id/publish — a persona needs a preview image (exampleAssetUrl)
// before it can go live in Explore. Avatar motion no longer depends on persona-specific
// art (see PersonaAvatar.tsx / globals.css — motion is CSS applied to whichever image
// is showing), so there's no per-state asset requirement anymore, just this one.
personasRoutes.post('/:id/publish', async (c) => {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const id = c.req.param('id');
    const [existing] = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
    if (!existing) return c.json({ error: 'Persona not found', code: 'NOT_FOUND' }, 404);

    if (!existing.exampleAssetUrl) {
        return c.json({ error: 'Persona needs a preview image (exampleAssetUrl) before publishing', code: 'INCOMPLETE_ASSETS' }, 409);
    }

    const [published] = await db.update(personas).set({ status: 'published', updatedAt: new Date() }).where(eq(personas.id, id)).returning();
    return c.json({ persona: published });
});

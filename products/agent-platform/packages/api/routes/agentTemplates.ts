import { Hono } from 'hono';
import { and, eq, desc, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agentTemplates } from '@serverless-saas/agent-schema/agents';
import type { AppEnv } from '@serverless-saas/types';

export const agentTemplatesRoutes = new Hono<AppEnv>();

// Platform admin guard — same pattern as ops.ts
const isPlatformAdmin = (c: any): boolean => {
    const jwtPayload = c.get('jwtPayload') as any;
    return jwtPayload?.['custom:role'] === 'platform_admin';
};

// GET /ops/agent-templates — list all templates ordered by version desc
agentTemplatesRoutes.get('/', async (c) => {
    if (!isPlatformAdmin(c)) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const data = await db
        .select({
            id: agentTemplates.id,
            name: agentTemplates.name,
            description: agentTemplates.description,
            status: agentTemplates.status,
            version: agentTemplates.version,
            model: agentTemplates.model,
            publishedAt: agentTemplates.publishedAt,
            createdAt: agentTemplates.createdAt,
        })
        .from(agentTemplates)
        .orderBy(desc(agentTemplates.version));

    return c.json({ templates: data });
});

// GET /ops/agent-templates/:id — get single template with full systemPrompt
agentTemplatesRoutes.get('/:id', async (c) => {
    if (!isPlatformAdmin(c)) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');
    const [template] = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .limit(1);

    if (!template) {
        return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ template });
});

// POST /ops/agent-templates — create new draft template
agentTemplatesRoutes.post('/', async (c) => {
    if (!isPlatformAdmin(c)) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const userId = c.get('userId');
    if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const schema = z.object({
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        systemPrompt: z.string().min(1),
        tools: z.array(z.string()).optional(),
        model: z.string().optional(),
        config: z.record(z.unknown()).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const { name, description, systemPrompt, tools, model, config } = result.data;

    const [created] = await db
        .insert(agentTemplates)
        .values({
            name,
            description: description ?? null,
            systemPrompt,
            tools: tools ?? null,
            model: model ?? null,
            config: config ?? null,
            version: 1,
            status: 'draft',
            createdBy: userId,
        })
        .returning();

    return c.json({ template: created }, 201);
});

// PUT /ops/agent-templates/:id — update draft template only
agentTemplatesRoutes.put('/:id', async (c) => {
    if (!isPlatformAdmin(c)) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [existing] = await db
        .select({ id: agentTemplates.id, status: agentTemplates.status })
        .from(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }

    if (existing.status !== 'draft') {
        return c.json({ error: 'Only draft templates can be edited', code: 'INVALID_STATE' }, 409);
    }

    const schema = z.object({
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        systemPrompt: z.string().min(1).optional(),
        tools: z.array(z.string()).optional(),
        model: z.string().optional(),
        config: z.record(z.unknown()).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    if (Object.keys(result.data).length === 0) {
        return c.json({ error: 'No fields provided for update', code: 'VALIDATION_ERROR' }, 400);
    }

    const [updated] = await db
        .update(agentTemplates)
        .set({ ...result.data, updatedAt: new Date() })
        .where(eq(agentTemplates.id, id))
        .returning();

    return c.json({ template: updated });
});

// POST /ops/agent-templates/:id/publish — publish template, archive all others
agentTemplatesRoutes.post('/:id/publish', async (c) => {
    if (!isPlatformAdmin(c)) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');

    const [existing] = await db
        .select({ id: agentTemplates.id, status: agentTemplates.status })
        .from(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }

    if (existing.status === 'archived') {
        return c.json({ error: 'Cannot publish an archived template', code: 'INVALID_STATE' }, 409);
    }

    // Archive all currently published templates
    await db
        .update(agentTemplates)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(and(eq(agentTemplates.status, 'published'), ne(agentTemplates.id, id)));

    // Publish this template
    const now = new Date();
    const [published] = await db
        .update(agentTemplates)
        .set({ status: 'published', publishedAt: now, updatedAt: now })
        .where(eq(agentTemplates.id, id))
        .returning();

    return c.json({ template: published });
});

// POST /ops/agent-templates/:id/new-version — clone as new draft with version + 1
agentTemplatesRoutes.post('/:id/new-version', async (c) => {
    if (!isPlatformAdmin(c)) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const id = c.req.param('id');
    const userId = c.get('userId');
    if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const [source] = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .limit(1);

    if (!source) {
        return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }

    const [created] = await db
        .insert(agentTemplates)
        .values({
            name: source.name,
            description: source.description,
            systemPrompt: source.systemPrompt,
            tools: source.tools,
            model: source.model,
            config: source.config,
            version: source.version + 1,
            status: 'draft',
            createdBy: userId,
        })
        .returning();

    return c.json({ template: created }, 201);
});

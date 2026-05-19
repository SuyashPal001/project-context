import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { agents } from '@serverless-saas/database/schema/agents';
import { agentSkills } from '@serverless-saas/database/schema/conversations';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const agentSkillsRoutes = new Hono<AppEnv>();

// Verify agent belongs to tenant — used before every operation
async function resolveAgent(agentId: string, tenantId: string) {
    const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
        .limit(1);
    return agent ?? null;
}

// GET /agents/:agentId/skills — list all active skills for agent
agentSkillsRoutes.get('/:agentId/skills', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    console.log('SKILLS ROUTE HIT', { agentId: c.req.param('agentId'), tenantId });

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const data = await db
        .select()
        .from(agentSkills)
        .where(and(
            eq(agentSkills.agentId, agentId),
            eq(agentSkills.tenantId, tenantId),
        ))
        .orderBy(desc(agentSkills.createdAt));

    return c.json({ data });
});

// POST /agents/:agentId/skills — create a new skill
agentSkillsRoutes.post('/:agentId/skills', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const schema = z.object({
        name: z.string().min(1).max(100),
        systemPrompt: z.string().min(1),
        tools: z.array(z.string()).optional().default([]),
        config: z.record(z.unknown()).optional(),
        version: z.number().int().positive().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    try {
        const [created] = await db.insert(agentSkills).values({
            agentId,
            tenantId,
            name: result.data.name,
            systemPrompt: result.data.systemPrompt,
            tools: result.data.tools,
            config: result.data.config ?? null,
            version: result.data.version ?? 1,
            status: 'active',
        }).returning();

        return c.json({ data: created }, 201);
    } catch (err: any) {
        // Unique constraint on [agentId, tenantId, name, version]
        if (err?.code === '23505') {
            return c.json({ error: 'A skill with this name and version already exists', code: 'CONFLICT' }, 409);
        }
        console.error('Failed to create skill:', err);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// GET /agents/:agentId/skills/:skillId — get single skill
agentSkillsRoutes.get('/:agentId/skills/:skillId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');
    const skillId = c.req.param('skillId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const [data] = await db
        .select()
        .from(agentSkills)
        .where(and(
            eq(agentSkills.id, skillId),
            eq(agentSkills.agentId, agentId),
            eq(agentSkills.tenantId, tenantId),
        ))
        .limit(1);

    if (!data) {
        return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ data });
});

// PUT /agents/:agentId/skills/:skillId — update skill
agentSkillsRoutes.put('/:agentId/skills/:skillId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');
    const skillId = c.req.param('skillId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const [existing] = await db
        .select({ id: agentSkills.id })
        .from(agentSkills)
        .where(and(
            eq(agentSkills.id, skillId),
            eq(agentSkills.agentId, agentId),
            eq(agentSkills.tenantId, tenantId),
        ))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }

    const schema = z.object({
        name: z.string().min(1).max(100).optional(),
        systemPrompt: z.string().min(1).optional(),
        tools: z.array(z.string()).optional(),
        config: z.record(z.unknown()).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    if (Object.keys(result.data).length === 0) {
        return c.json({ error: 'No fields provided for update', code: 'VALIDATION_ERROR' }, 400);
    }

    const [updated] = await db.update(agentSkills)
        .set({ ...result.data, updatedAt: new Date() })
        .where(and(
            eq(agentSkills.id, skillId),
            eq(agentSkills.agentId, agentId),
            eq(agentSkills.tenantId, tenantId),
        ))
        .returning();

    return c.json({ data: updated });
});

// DELETE /agents/:agentId/skills/:skillId — soft delete (archive)
agentSkillsRoutes.delete('/:agentId/skills/:skillId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');
    const skillId = c.req.param('skillId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const [existing] = await db
        .select({ id: agentSkills.id })
        .from(agentSkills)
        .where(and(
            eq(agentSkills.id, skillId),
            eq(agentSkills.agentId, agentId),
            eq(agentSkills.tenantId, tenantId),
        ))
        .limit(1);

    if (!existing) {
        return c.json({ error: 'Skill not found', code: 'NOT_FOUND' }, 404);
    }

    await db.update(agentSkills)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(and(
            eq(agentSkills.id, skillId),
            eq(agentSkills.agentId, agentId),
            eq(agentSkills.tenantId, tenantId),
        ));

    return c.json({ success: true });
});

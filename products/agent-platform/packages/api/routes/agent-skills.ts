import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { skillInstalls, skillVersions } from '@serverless-saas/agent-schema/skills';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

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

// An installId names a skill_installs row, which is tenant-scoped. Writing a
// foreign tenant's install id would be a silent cross-tenant reference, so the
// lookup is scoped to this tenant and to active installs only. The row also
// carries the pinned version, which is what the system prompt is read from.
async function resolveInstall(installId: string, tenantId: string) {
    const [install] = await db
        .select({
            id: skillInstalls.id,
            skillId: skillInstalls.skillId,
            installedVersion: skillInstalls.installedVersion,
        })
        .from(skillInstalls)
        .where(and(
            eq(skillInstalls.id, installId),
            eq(skillInstalls.tenantId, tenantId),
            eq(skillInstalls.status, 'active'),
        ))
        .limit(1);
    return install ?? null;
}

// The body of the *pinned* version, not the latest — an install is npm-style
// pinned, so the agent must receive the content the tenant actually installed.
// Only a 'ready' row's manifest was written by a completed import; a
// pending/failed row's manifest is whatever the previous version left behind.
async function resolveInstalledSkillBody(skillId: string, version: number): Promise<string | null> {
    const [row] = await db
        .select({ manifest: skillVersions.manifest, status: skillVersions.status })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
        .limit(1);
    if (!row || row.status !== 'ready' || !row.manifest || typeof row.manifest !== 'object') return null;
    const body = (row.manifest as Record<string, unknown>).body;
    return typeof body === 'string' && body.length > 0 ? body : null;
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
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agents', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const agentId = c.req.param('agentId');

    if (!await resolveAgent(agentId, tenantId)) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const schema = z.object({
        name: z.string().min(1).max(100),
        // Optional because an installed skill's prompt is derived server-side
        // from its manifest body — the client must not be able to supply (or
        // stale-cache) the content the agent runs on.
        systemPrompt: z.string().min(1).optional(),
        tools: z.array(z.string()).optional().default([]),
        config: z.record(z.unknown()).optional(),
        version: z.number().int().positive().optional(),
        installId: z.string().uuid().optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    try {
        let systemPrompt: string;
        if (result.data.installId) {
            const install = await resolveInstall(result.data.installId, tenantId);
            if (!install) {
                return c.json({ error: 'Skill install not found', code: 'NOT_FOUND' }, 404);
            }
            const body = await resolveInstalledSkillBody(install.skillId, install.installedVersion);
            if (!body) {
                return c.json({ error: 'Skill version has no readable content yet', code: 'NOT_READY' }, 409);
            }
            systemPrompt = body;
        } else {
            if (!result.data.systemPrompt) {
                return c.json({ error: 'systemPrompt is required when installId is omitted', code: 'VALIDATION_ERROR' }, 400);
            }
            systemPrompt = result.data.systemPrompt;
        }

        const [created] = await db.insert(agentSkills).values({
            agentId,
            tenantId,
            name: result.data.name,
            systemPrompt,
            tools: result.data.tools,
            config: result.data.config ?? null,
            version: result.data.version ?? 1,
            status: 'active',
            installId: result.data.installId ?? null,
        }).returning();

        db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_created', resource: 'agent_skill', resourceId: created.id, metadata: { agentId, name: result.data.name }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
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
    const userId = c.get('userId') as string;

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

    db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_updated', resource: 'agent_skill', resourceId: skillId, metadata: { agentId, fields: Object.keys(result.data) }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    return c.json({ data: updated });
});

// DELETE /agents/:agentId/skills/:skillId — soft delete (archive)
agentSkillsRoutes.delete('/:agentId/skills/:skillId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

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

    db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_deleted', resource: 'agent_skill', resourceId: skillId, metadata: { agentId }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
    return c.json({ success: true });
});

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

// Mirrors MAX_ATTACHED_SKILLS / MAX_COMPOSED_SKILL_CHARS in the orchestrator's
// usage.ts. Deliberately duplicated rather than shared: the orchestrator is not
// a dependency of this Lambda, and a shared package for two integers would cost
// more than it saves. If either number changes, change both.
const MAX_ATTACHED_SKILLS = 8;
const MAX_COMPOSED_SKILL_CHARS = 24_000;

// Verify agent belongs to tenant — used before every operation.
// Exported so the in-conversation create path (routes/internal/skills.ts) runs
// the same check: agent_skills' agent_id and tenant_id are independent foreign
// keys, so an unvalidated pair is a cross-tenant write.
export async function resolveAgent(agentId: string, tenantId: string) {
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

    // Declared outside the try block so the catch block's 23505 reconciliation
    // path can reuse the freshly-resolved value instead of re-deriving it.
    // Stays undefined only if the try block throws before it's assigned —
    // the reconciliation path below guards on that explicitly.
    let systemPrompt: string | undefined;
    try {
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

        const active = await db.select({ name: agentSkills.name, systemPrompt: agentSkills.systemPrompt, version: agentSkills.version })
            .from(agentSkills)
            .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.tenantId, tenantId), eq(agentSkills.status, 'active')));

        // Exclude only the row(s) this attach actually supersedes — same name,
        // version <= the incoming version. Two active rows can share a name at
        // different versions (agent_skills is unique on
        // [agentId, tenantId, name, version], and a re-attach at a new version
        // doesn't deactivate the old one); the orchestrator dedupes to the
        // *highest* version per name when composing (usage.ts:82-87), so a
        // same-name row at a version higher than this attach's will still
        // compose regardless of what this attach does, and must stay counted.
        // Only a same-name row at <= this version is what this attach
        // replaces (via the 23505 -> UPDATE reconcile, or a stale lower
        // version that no longer matters). Excluding anything more would let
        // a low-version re-attach hide an existing high-version row's real
        // composed cost.
        const incomingVersion = result.data.version ?? 1;
        const others = active.filter((s) => s.name !== result.data.name || (s.version ?? 1) > incomingVersion);

        // Mirrors the orchestrator's per-skill cost (usage.ts:101): the
        // composed prompt wraps each skill's trimmed body in a
        // "## Skill: <name>\n\n" header, so the raw body length under-counts
        // by name.length + 15. Refused rather than truncated: the prompt
        // budget is real, and half a skill in the prompt is worse than none.
        // Failing here makes it visible to whoever is attaching instead of
        // surfacing later as bad output.
        const cost = (p: string, n: string) => (p?.trim().length ?? 0) + n.length + 15;
        const composedChars = others.reduce((n, s) => n + cost(s.systemPrompt ?? '', s.name), 0);
        if (others.length >= MAX_ATTACHED_SKILLS) {
            return c.json({
                error: `This agent already has the maximum of ${MAX_ATTACHED_SKILLS} skills attached. Detach one first.`,
                code: 'SKILL_BUDGET_EXCEEDED',
            }, 409);
        }
        if (composedChars + cost(systemPrompt, result.data.name) > MAX_COMPOSED_SKILL_CHARS) {
            return c.json({
                error: `Attaching this skill would exceed the agent's prompt budget of ${MAX_COMPOSED_SKILL_CHARS} characters. Detach a skill first.`,
                code: 'SKILL_BUDGET_EXCEEDED',
            }, 409);
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
            // An installed skill can be re-attached after its pinned install
            // version was upgraded server-side (v1 -> v3): the client still
            // writes the same `version` (it's a display/order field, not a
            // reflection of the install's version), so the insert collides
            // with the prior attach's row. That row's systemPrompt is now
            // stale — reconcile it to the freshly-resolved content computed
            // above rather than reporting a conflict for something the
            // caller can't actually resolve. Hand-authored skills (no
            // installId) have no "current version" to reconcile to, so they
            // keep the original 409 behavior.
            if (result.data.installId && systemPrompt !== undefined) {
                const version = result.data.version ?? 1;
                const [updated] = await db.update(agentSkills)
                    .set({
                        systemPrompt,
                        tools: result.data.tools,
                        config: result.data.config ?? null,
                        updatedAt: new Date(),
                    })
                    .where(and(
                        eq(agentSkills.agentId, agentId),
                        eq(agentSkills.tenantId, tenantId),
                        eq(agentSkills.name, result.data.name),
                        eq(agentSkills.version, version),
                    ))
                    .returning();

                if (updated) {
                    db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_updated', resource: 'agent_skill', resourceId: updated.id, metadata: { agentId, name: result.data.name, reason: 'reattach_after_upgrade' }, traceId: c.get('traceId') ?? '' }).catch((auditErr: unknown) => console.error('Audit log write failed:', auditErr));
                    return c.json({ data: updated }, 200);
                }
                // Race: the conflicting row vanished between the insert
                // failing and the update running. Fall through to 409.
            }
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

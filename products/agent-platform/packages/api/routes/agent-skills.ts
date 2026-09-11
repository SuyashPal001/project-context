import { Hono } from 'hono';
import { and, eq, desc, sql, or, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { skillInstalls, skillVersions } from '@serverless-saas/agent-schema/skills';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const agentSkillsRoutes = new Hono<AppEnv>();

// Abuse ceiling, not a prompt budget: native Mastra skills are listed by name
// and description and loaded on demand, so an attached skill no longer costs
// its full body in every prompt. The import worker enforces the same cap.
const MAX_ATTACHED_SKILLS = 8;

// The partial unique index from migration 0091. A 23505 naming it means the
// same install is already attached; any other 23505 is a name collision.
const ACTIVE_INSTALL_UNIQUE = 'agent_skills_agent_install_active_unique';

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

// The *pinned* version's manifest, not the latest: an install is npm-style
// pinned. Only a 'ready' row's manifest was written by a completed import.
// Returns the body the agent runs on and the manifest's own name, which is
// the one name an installed skill's row carries. Two writers used to name the
// same install differently (display name vs manifest name) and both rows got in.
async function resolveInstalledSkillManifest(
    skillId: string,
    version: number,
): Promise<{ body: string; name: string | null } | null> {
    const [row] = await db
        .select({ manifest: skillVersions.manifest, status: skillVersions.status })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
        .limit(1);
    if (!row || row.status !== 'ready' || !row.manifest || typeof row.manifest !== 'object') return null;
    const manifest = row.manifest as Record<string, unknown>;
    const body = typeof manifest.body === 'string' && manifest.body.length > 0 ? manifest.body : null;
    if (!body) return null;
    const name = typeof manifest.name === 'string' && manifest.name.trim().length > 0 ? manifest.name.trim().slice(0, 100) : null;
    return { body, name };
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

    // Uninstalling a skill (DELETE /skills/:id/install) leaves the agent's
    // agent_skills row active — the runtime already skips it because it only
    // loads active installs, but this list must too. Left-join skill_installs,
    // tenant-scoped, and keep rows with no install (hand-authored) or whose
    // install is still active.
    const data = await db
        .select({
            id: agentSkills.id,
            agentId: agentSkills.agentId,
            tenantId: agentSkills.tenantId,
            name: agentSkills.name,
            systemPrompt: agentSkills.systemPrompt,
            tools: agentSkills.tools,
            config: agentSkills.config,
            installId: agentSkills.installId,
            version: agentSkills.version,
            status: agentSkills.status,
            createdAt: agentSkills.createdAt,
            updatedAt: agentSkills.updatedAt,
        })
        .from(agentSkills)
        .leftJoin(skillInstalls, and(
            eq(skillInstalls.id, agentSkills.installId),
            eq(skillInstalls.tenantId, tenantId),
        ))
        .where(and(
            eq(agentSkills.agentId, agentId),
            eq(agentSkills.tenantId, tenantId),
            eq(agentSkills.status, 'active'),
            or(isNull(agentSkills.installId), eq(skillInstalls.status, 'active')),
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
        // Accepted for compatibility; not stored — nothing reads agent_skills.tools.
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
        // Resolved before the cap check so the cap compares against the
        // canonical (lowercase, DB-verified) install id — zod's .uuid()
        // accepts an uppercase UUID, Postgres always returns lowercase, and
        // comparing against the raw client value would let a re-attach at
        // the cap double-count itself. Resolving first also means a foreign
        // install id at the cap correctly 404s instead of reporting the cap.
        let install: { id: string; skillId: string; installedVersion: number } | null = null;
        let manifest: { body: string; name: string | null } | null = null;
        if (result.data.installId) {
            install = await resolveInstall(result.data.installId, tenantId);
            if (!install) {
                return c.json({ error: 'Skill install not found', code: 'NOT_FOUND' }, 404);
            }
            manifest = await resolveInstalledSkillManifest(install.skillId, install.installedVersion);
            if (!manifest) {
                return c.json({ error: 'Skill version has no readable content yet', code: 'NOT_READY' }, 409);
            }
        }

        // The cap counts the agent's *other* attached skills, excluding rows
        // whose install has been uninstalled (dead installs don't count
        // against the cap), and a re-attach never counts the row it
        // reactivates.
        const active = await db.select({ name: agentSkills.name, installId: agentSkills.installId })
            .from(agentSkills)
            .leftJoin(skillInstalls, and(
                eq(skillInstalls.id, agentSkills.installId),
                eq(skillInstalls.tenantId, tenantId),
            ))
            .where(and(
                eq(agentSkills.agentId, agentId),
                eq(agentSkills.tenantId, tenantId),
                eq(agentSkills.status, 'active'),
                or(isNull(agentSkills.installId), eq(skillInstalls.status, 'active')),
            ));
        const others = active.filter((s) => install ? s.installId !== install.id : s.name !== result.data.name);
        if (others.length >= MAX_ATTACHED_SKILLS) {
            return c.json({
                error: `This agent already has the maximum of ${MAX_ATTACHED_SKILLS} skills attached. Detach one first.`,
                code: 'SKILL_BUDGET_EXCEEDED',
            }, 409);
        }

        if (install && manifest) {
            // An install is attached at most once per agent. Reuse its row,
            // active or archived, so a re-attach after a detach reactivates
            // the same row instead of colliding with it. The name is NOT
            // touched here: the old [agentId, tenantId, name, version] unique
            // constraint still covers archived rows, and renaming this row
            // could collide with an unrelated archived row sitting on the
            // manifest's name. An installed row is identified by installId
            // now, so the name is cosmetic until a later migration
            // normalises it after dropping that constraint.
            const [existing] = await db.select({ id: agentSkills.id })
                .from(agentSkills)
                .where(and(
                    eq(agentSkills.agentId, agentId),
                    eq(agentSkills.tenantId, tenantId),
                    eq(agentSkills.installId, install.id),
                ))
                .orderBy(sql`(${agentSkills.status} = 'active') desc`, agentSkills.createdAt)
                .limit(1);

            if (existing) {
                const [updated] = await db.update(agentSkills)
                    .set({ systemPrompt: manifest.body, status: 'active', updatedAt: new Date() })
                    .where(and(eq(agentSkills.id, existing.id), eq(agentSkills.tenantId, tenantId)))
                    .returning();
                // If the row vanished between the lookup and the update (a
                // concurrent detach-and-purge), fall through to the insert
                // path below instead of dereferencing `undefined.id`.
                if (updated) {
                    db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_updated', resource: 'agent_skill', resourceId: updated.id, metadata: { agentId, reason: 'reattach' }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
                    return c.json({ data: updated }, 200);
                }
            }
        }

        if (!install && !result.data.systemPrompt) {
            return c.json({ error: 'systemPrompt is required when installId is omitted', code: 'VALIDATION_ERROR' }, 400);
        }

        const name = install ? (manifest!.name ?? result.data.name) : result.data.name;
        const systemPrompt = install ? manifest!.body : result.data.systemPrompt!;
        const version = result.data.version ?? 1;

        // The old [agentId, tenantId, name, version] unique constraint still
        // covers archived rows. POST /skills/:id/install upserts on
        // (tenant_id, skill_id), so a reinstall keeps the same install id and
        // the skill_installs row simply comes back live — it does not mint a
        // fresh installId. This path guards two cases: a hand-authored skill (no
        // install) detached and re-created under the same name/version, and an
        // installed skill whose earlier row sat under another (or no) install id.
        // Either would otherwise insert, collide with the row the earlier attach
        // left archived, and report NAME_CONFLICT forever. Reactivate that
        // row instead — relinking it to the current install (or null for a
        // hand-authored skill).
        const [archived] = await db.select({ id: agentSkills.id })
            .from(agentSkills)
            .where(and(
                eq(agentSkills.agentId, agentId),
                eq(agentSkills.tenantId, tenantId),
                eq(agentSkills.name, name),
                eq(agentSkills.version, version),
                eq(agentSkills.status, 'archived'),
            ))
            .limit(1);

        if (archived) {
            const [reactivated] = await db.update(agentSkills)
                .set({ installId: install ? install.id : null, systemPrompt, status: 'active', updatedAt: new Date() })
                .where(and(eq(agentSkills.id, archived.id), eq(agentSkills.tenantId, tenantId)))
                .returning();
            if (reactivated) {
                db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_updated', resource: 'agent_skill', resourceId: reactivated.id, metadata: { agentId, name, reason: 'reattach' }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
                return c.json({ data: reactivated }, 200);
            }
            // Race: the archived row vanished between the lookup and the
            // update. Fall through to the insert below.
        }

        const [created] = await db.insert(agentSkills).values({
            agentId,
            tenantId,
            name,
            systemPrompt,
            tools: [],
            config: result.data.config ?? null,
            version,
            status: 'active',
            installId: install ? install.id : null,
        }).returning();
        db.insert(auditLog).values({ tenantId, actorId: userId ?? 'system', actorType: 'human', action: 'agent_skill_created', resource: 'agent_skill', resourceId: created.id, metadata: { agentId, name }, traceId: c.get('traceId') ?? '' }).catch((err: unknown) => console.error('Audit log write failed:', err));
        return c.json({ data: created }, 201);
    } catch (err: any) {
        // The driver (postgres.js) wraps the pg error under `.cause` (same
        // shape as userUpsertMiddleware): `err.code` is undefined,
        // `err.cause.code` is '23505'. postgres.js reports the violated
        // index as `constraint_name`, not `constraint` (node-postgres' key,
        // and the one this route used to read — which meant the constraint
        // check below never matched, and a real race always fell through to
        // NAME_CONFLICT). See apps/api/src/middleware/userUpsert.ts:102-104
        // for the same fix applied earlier.
        const pgErr = err?.cause ?? err;
        if (pgErr?.code === '23505') {
            if (pgErr.constraint_name === ACTIVE_INSTALL_UNIQUE) {
                // A concurrent attach of the same install won. The desired end
                // state already holds, and attachSkillToAgent treats CONFLICT
                // as success.
                return c.json({ error: 'This skill is already attached to this agent', code: 'CONFLICT' }, 409);
            }
            return c.json({ error: 'Another skill with this name is already attached to this agent', code: 'NAME_CONFLICT' }, 409);
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

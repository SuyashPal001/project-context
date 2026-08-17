import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { agents } from '@serverless-saas/agent-schema/agents';
import { teams, teamMembers } from '@serverless-saas/agent-schema/teams';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const teamsRoutes = new Hono<AppEnv>();

async function resolveTeam(teamId: string, tenantId: string) {
    const [team] = await db.select({ id: teams.id, tenantId: teams.tenantId }).from(teams).where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId))).limit(1);
    return team ?? null;
}

async function resolveAgent(agentId: string, tenantId: string) {
    const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1);
    return agent ?? null;
}

// GET /teams — this tenant's teams
teamsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const data = await db.select().from(teams).where(eq(teams.tenantId, tenantId));
    return c.json({ data });
});

// POST /teams — create a team
teamsRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;
    if (!hasPermission(permissions, 'agents', 'create')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const result = z.object({ name: z.string().min(1).max(100) }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

    const [created] = await db.insert(teams).values({ tenantId, name: result.data.name, createdBy: userId }).returning();
    return c.json({ data: created }, 201);
});

// GET /teams/:teamId — team + member agent ids
teamsRoutes.get('/:teamId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const teamId = c.req.param('teamId');
    const team = await resolveTeam(teamId, tenantId);
    if (!team) return c.json({ error: 'Team not found', code: 'NOT_FOUND' }, 404);

    const members = await db.select({ agentId: teamMembers.agentId }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
    return c.json({ data: { ...team, memberAgentIds: members.map((m) => m.agentId) } });
});

// PATCH /teams/:teamId — rename
teamsRoutes.patch('/:teamId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'agents', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const teamId = c.req.param('teamId');
    if (!await resolveTeam(teamId, tenantId)) return c.json({ error: 'Team not found', code: 'NOT_FOUND' }, 404);

    const result = z.object({ name: z.string().min(1).max(100) }).safeParse(await c.req.json());
    if (!result.success) return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);

    const [updated] = await db.update(teams).set({ name: result.data.name, updatedAt: new Date() }).where(eq(teams.id, teamId)).returning();
    return c.json({ data: updated });
});

// DELETE /teams/:teamId
teamsRoutes.delete('/:teamId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'agents', 'delete')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const teamId = c.req.param('teamId');
    if (!await resolveTeam(teamId, tenantId)) return c.json({ error: 'Team not found', code: 'NOT_FOUND' }, 404);

    await db.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
    await db.delete(teams).where(eq(teams.id, teamId));
    return c.json({ success: true });
});

// POST /teams/:teamId/members/:agentId — add an agent to the team
teamsRoutes.post('/:teamId/members/:agentId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'agents', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const teamId = c.req.param('teamId');
    const agentId = c.req.param('agentId');
    if (!await resolveTeam(teamId, tenantId)) return c.json({ error: 'Team not found', code: 'NOT_FOUND' }, 404);
    if (!await resolveAgent(agentId, tenantId)) return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);

    await db.insert(teamMembers).values({ teamId, agentId }).onConflictDoNothing();
    return c.json({ success: true });
});

// DELETE /teams/:teamId/members/:agentId — remove an agent from the team
teamsRoutes.delete('/:teamId/members/:agentId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'agents', 'update')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const teamId = c.req.param('teamId');
    const agentId = c.req.param('agentId');
    if (!await resolveTeam(teamId, tenantId)) return c.json({ error: 'Team not found', code: 'NOT_FOUND' }, 404);

    await db.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentId, agentId)));
    return c.json({ success: true });
});

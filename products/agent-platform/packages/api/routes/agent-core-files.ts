import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agents } from '@serverless-saas/agent-schema/agents';
import { personas } from '@serverless-saas/agent-schema/personas';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const agentCoreFilesRoutes = new Hono<AppEnv>();

// The 4 locked sections + the always-locked identity summary. Their content
// is composed into the runtime prompt server-side (see agent-orchestrator's
// fetchAgentPersonality) but is never sent to the tenant-facing client —
// official personas keep their prompt authorship proprietary. Only
// MEMORY.md (agentMemories, via ./agent-memory.ts) is tenant-visible.
const LOCKED_FILE_NAMES = ['AGENTS.md', 'BOOTSTRAP.md', 'IDENTITY.md', 'SOUL.md', 'USER.md'] as const;

// GET /agents/:agentId/core-files — locked file list, no content ever returned
agentCoreFilesRoutes.get('/:agentId/core-files', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const agentId = c.req.param('agentId');
    const [row] = await db
        .select({ id: agents.id, isOfficial: personas.isOfficial })
        .from(agents)
        .leftJoin(personas, eq(agents.personaId, personas.id))
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
        .limit(1);

    if (!row) return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);

    const data = LOCKED_FILE_NAMES.map((name) => ({ name, locked: true }));

    return c.json({ data });
});

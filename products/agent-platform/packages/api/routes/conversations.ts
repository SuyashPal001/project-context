import { Hono } from 'hono';
import { and, eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database/client';
import { storageService } from '@serverless-saas/storage';
import { conversations, messages } from '@serverless-saas/agent-schema/conversations';
import { agents } from '@serverless-saas/agent-schema/agents';
import { personas } from '@serverless-saas/agent-schema/personas';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

// A grant prefix is a Drive path segment, not a path expression. It must end in
// "/" so `key LIKE prefix || '%'` cannot reach a sibling folder whose name merely
// starts with the same letters ("new" would match "newer/"), and it must not
// traverse or be absolute. This is the outer edge of what the agent can read, so
// it is validated on the way in rather than trusted at query time.
const folderPrefix = z.string().min(1).max(512)
    .refine(p => p.endsWith('/'), 'prefix must end with "/"')
    .refine(p => !p.startsWith('/') && !p.includes('..'), 'prefix must not traverse');

export const conversationsRoutes = new Hono<AppEnv>();

// Presigned GET URLs expire (1hr — see storageService.getDownloadUrl), so avatarUrl is
// never persisted on agents; only the stable avatarFileId is. Resolve a fresh URL on
// every read here too, mirroring agents.crud.ts's resolveAvatarUrl.
async function resolveConversationAgentAvatar<T extends { tenantId: string; agent: { avatarFileId: string | null } }>(row: T) {
    const { avatarFileId, ...agentRest } = row.agent;
    let avatarUrl: string | null = null;
    if (avatarFileId) {
        try { avatarUrl = await storageService.getDownloadUrl(row.tenantId, avatarFileId); } catch { /* file missing/deleted */ }
    }
    // Cast: TS can't narrow the generic `agent` shape after the Omit/spread — same
    // type-only escape hatch as the `as any` on conversationSelect.agent.persona above.
    return { ...row, agent: { ...agentRest, avatarUrl } } as Omit<T, 'agent'> & { agent: Omit<T['agent'], 'avatarFileId'> & { avatarUrl: string | null } };
}

// Drizzle's left-join null-collapsing only nullifies a nested selected object
// when its field path has length === 2 (e.g. `agent: { persona: { id } }` in
// agents.crud.ts). The `agent.persona` shape here is nested three levels deep
// (row -> agent -> persona), so a persona-less agent (left join returns no
// matching persona row) comes back as `agent.persona = { id: null, name: null,
// tagline: null }` instead of `agent.persona = null`.
// Collapse that all-null sub-object back to null to match the `PersonaSummary
// | null` contract the frontend (and any future `if (conversation.agent.persona)`
// check) expects.
const normalizeAgentPersona = <T extends { agent: { persona: { id: string | null } | null } }>(row: T): T => {
    if (row.agent?.persona && row.agent.persona.id == null) {
        return { ...row, agent: { ...row.agent, persona: null } };
    }
    return row;
};

const conversationSelect = {
    id: conversations.id,
    tenantId: conversations.tenantId,
    agentId: conversations.agentId,
    userId: conversations.userId,
    externalUserId: conversations.externalUserId,
    title: conversations.title,
    status: conversations.status,
    needsHuman: conversations.needsHuman,
    metadata: conversations.metadata,
    createdAt: conversations.createdAt,
    updatedAt: conversations.updatedAt,
    agent: {
        id: agents.id, name: agents.name, type: agents.type,
        avatarFileId: agents.avatarFileId,
        // Cast to `any`: drizzle's SelectedFields type only supports one level of
        // nested-object selection, but this shape nests persona inside agent (two
        // levels) to match the API response contract. Runtime flattening handles
        // arbitrary depth fine — this is a type-only escape hatch, narrowed to just
        // the nested object so sibling columns above (id, name, type, ...) still
        // get type-checked.
        persona: {
            id: personas.id, name: personas.name, tagline: personas.tagline,
        } as any,
    },
};

// GET /conversations — list conversations strictly scoped to the calling member
conversationsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const { agentId, status } = c.req.query();

    const filters = [
        eq(conversations.tenantId, tenantId),
        eq(conversations.userId, userId),
    ];
    if (agentId) filters.push(eq(conversations.agentId, agentId));
    if (status) filters.push(eq(conversations.status, status as 'active' | 'archived' | 'escalated'));

    try {
        const data = await db
            .select({
                id: conversations.id,
                tenantId: conversations.tenantId,
                agentId: conversations.agentId,
                title: conversations.title,
                status: conversations.status,
                metadata: conversations.metadata,
                createdAt: conversations.createdAt,
                updatedAt: conversations.updatedAt,
                // Titles are auto-promoted from the opening message, so two chats
                // with one agent routinely read "hey" and "hey". Where they went is
                // the only thing that separates them. Truncated here rather than in
                // the client so a long message never rides the list payload; system
                // and tool rows are skipped because they are not what the user said
                // or was told, and empty rows are the streaming placeholders.
                lastMessage: sql<{ role: string; content: string; createdAt: string } | null>`(
                    select json_build_object('role', m.role, 'content', left(m.content, 160), 'createdAt', m.created_at)
                    from ${messages} m
                    where m.conversation_id = ${conversations.id}
                      and m.tenant_id = ${conversations.tenantId}
                      and m.role in ('user', 'assistant')
                      and m.content <> ''
                    order by m.created_at desc
                    limit 1
                )`,
                agent: {
                    id: agents.id, name: agents.name, type: agents.type,
                    avatarFileId: agents.avatarFileId,
                    // Cast to `any`: drizzle's SelectedFields type only supports one level
                    // of nested-object selection, but this shape nests persona inside
                    // agent (two levels) to match the API response contract. Runtime
                    // flattening handles arbitrary depth fine — this is a type-only escape
                    // hatch, narrowed to just the nested object so sibling columns above
                    // (id, name, type, ...) still get type-checked.
                    persona: {
                        id: personas.id, name: personas.name, tagline: personas.tagline,
                    } as any,
                },
            })
            .from(conversations)
            .innerJoin(agents, eq(conversations.agentId, agents.id))
            .leftJoin(personas, eq(agents.personaId, personas.id))
            .where(and(...filters))
            .orderBy(desc(conversations.createdAt));

        const normalized = await Promise.all(data.map(normalizeAgentPersona).map(resolveConversationAgentAvatar));
        return c.json({ data: normalized });
    } catch (error) {
        console.error('Fetch conversations failed:', error);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// POST /conversations — create conversation (userId stamped from JWT)
conversationsRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const schema = z.object({
        agentId: z.string().uuid(),
        externalUserId: z.string().optional(),
        title: z.string().max(255).optional(),
        metadata: z.record(z.unknown()).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const [agent] = await db.select().from(agents)
        .where(and(eq(agents.id, result.data.agentId), eq(agents.tenantId, tenantId)))
        .limit(1);

    if (!agent) return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);

    const [created] = await db.insert(conversations).values({
        tenantId,
        agentId: result.data.agentId,
        userId,
        externalUserId: result.data.externalUserId ?? null,
        title: result.data.title ?? null,
        metadata: result.data.metadata ?? null,
        status: 'active',
        needsHuman: false,
    }).returning();

    return c.json({ data: created }, 201);
});

// GET /conversations/:id — get single conversation (strictly member-scoped)
conversationsRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const id = c.req.param('id');

    try {
        const [data] = await db.select(conversationSelect)
            .from(conversations)
            .innerJoin(agents, eq(conversations.agentId, agents.id))
            .leftJoin(personas, eq(agents.personaId, personas.id))
            .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
            .limit(1);

        if (!data) return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
        return c.json({ data: await resolveConversationAgentAvatar(normalizeAgentPersona(data)) });
    } catch (error) {
        console.error('Fetch conversation failed:', error);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// PATCH /conversations/:id — update title, status, or needsHuman (strictly member-scoped)
conversationsRoutes.patch('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const id = c.req.param('id');
    const scope = and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId));

    try {
        // metadata comes back on the ownership check so a folderScope patch can
        // merge into it without a second round trip.
        const [existing] = await db.select({ id: conversations.id, metadata: conversations.metadata })
            .from(conversations).where(scope).limit(1);
        if (!existing) return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);

        const schema = z.object({
            title: z.string().max(255).optional(),
            status: z.enum(['active', 'archived', 'escalated']).optional(),
            needsHuman: z.boolean().optional(),
            folderScope: z.object({ prefix: folderPrefix }).nullable().optional(),
            // 'ask' (default): the composer's ApproveCost card gates every generation
            // tool call. 'auto': confirmGenerationOrDecline skips the card entirely and
            // runs — see apps/agent-orchestrator/src/mastra/tools/confirmGeneration.ts.
            allowMode: z.enum(['ask', 'auto']).nullable().optional(),
        });

        const result = schema.safeParse(await c.req.json());
        if (!result.success) {
            return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
        }
        if (Object.keys(result.data).length === 0) {
            return c.json({ error: 'No fields provided for update', code: 'VALIDATION_ERROR' }, 400);
        }

        const { folderScope, allowMode, ...rest } = result.data;
        const patch: Record<string, unknown> = { ...rest };
        if (folderScope !== undefined || allowMode !== undefined) {
            // Merge, never overwrite: metadata is shared with whatever else the
            // product stores on a conversation.
            const current = { ...((existing.metadata ?? {}) as Record<string, unknown>) };
            if (folderScope !== undefined) {
                if (folderScope === null) delete current.folderScope;
                else current.folderScope = folderScope;
            }
            if (allowMode !== undefined) {
                if (allowMode === null) delete current.allowMode;
                else current.allowMode = allowMode;
            }
            patch.metadata = current;
        }

        await db.update(conversations).set({ ...patch, updatedAt: new Date() }).where(scope);

        const [updated] = await db.select(conversationSelect)
            .from(conversations)
            .innerJoin(agents, eq(conversations.agentId, agents.id))
            .leftJoin(personas, eq(agents.personaId, personas.id))
            .where(scope)
            .limit(1);

        return c.json({ data: updated ? await resolveConversationAgentAvatar(normalizeAgentPersona(updated)) : updated });
    } catch (error) {
        console.error('Update conversation failed:', error);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// DELETE /conversations/:id — soft delete / archive (strictly member-scoped)
conversationsRoutes.delete('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const id = c.req.param('id');
    const scope = and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId));

    try {
        const [existing] = await db.select({ id: conversations.id }).from(conversations).where(scope).limit(1);
        if (!existing) return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);

        await db.update(conversations).set({ status: 'archived', updatedAt: new Date() }).where(scope);
        return c.json({ success: true });
    } catch (error) {
        console.error('Delete conversation failed:', error);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

// DELETE /conversations/:id/permanent — hard delete (strictly member-scoped)
conversationsRoutes.delete('/:id/permanent', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const id = c.req.param('id');
    const scope = and(eq(conversations.id, id), eq(conversations.tenantId, tenantId), eq(conversations.userId, userId));

    try {
        const [existing] = await db.select({ id: conversations.id }).from(conversations).where(scope).limit(1);
        if (!existing) return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);

        await db.delete(conversations).where(scope);
        return c.json({ success: true });
    } catch (error) {
        console.error('Hard delete conversation failed:', error);
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
});

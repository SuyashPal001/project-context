import { Hono } from 'hono';
import { and, eq, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { conversations, messages } from '@serverless-saas/agent-schema/conversations';
import { agents } from '@serverless-saas/agent-schema/agents';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { runMessageRelay, RelayError } from './_relay';
import type { AppEnv } from '../types';

export const widgetRoutes = new Hono<AppEnv>();

// Validate tenant is active
async function resolveTenant(tenantId: string) {
    const [tenant] = await db
        .select({ id: tenants.id, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
    return tenant ?? null;
}

// Validate agent exists, belongs to tenant, and is active
async function resolveAgent(agentId: string, tenantId: string) {
    const [agent] = await db
        .select({ id: agents.id, tenantId: agents.tenantId, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
        .limit(1);
    return agent ?? null;
}

// Validate conversation belongs to tenant
async function resolveConversation(conversationId: string, tenantId: string) {
    const [conversation] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
        .limit(1);
    return conversation ?? null;
}

// POST /widget/:tenantId/:agentId/conversations — create conversation
widgetRoutes.post('/:tenantId/:agentId/conversations', async (c) => {
    const { tenantId, agentId } = c.req.param();

    const schema = z.object({
        externalUserId: z.string().optional(),
        title: z.string().optional(),
    });

    const body = await c.req.json().catch(() => ({}));
    const result = schema.safeParse(body);
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const tenant = await resolveTenant(tenantId);
    if (!tenant) {
        return c.json({ error: 'Tenant not found', code: 'NOT_FOUND' }, 404);
    }
    if (tenant.status !== 'active') {
        return c.json({ error: 'Tenant is not active', code: 'TENANT_INACTIVE' }, 403);
    }

    const agent = await resolveAgent(agentId, tenantId);
    if (!agent) {
        return c.json({ error: 'Agent not found', code: 'NOT_FOUND' }, 404);
    }

    const [conversation] = await db
        .insert(conversations)
        .values({
            tenantId,
            agentId,
            externalUserId: result.data.externalUserId ?? null,
            title: result.data.title ?? null,
        })
        .returning({ conversationId: conversations.id });

    return c.json({ conversationId: conversation.conversationId }, 201);
});

// GET /widget/:tenantId/conversations/:conversationId/messages — get message history
widgetRoutes.get('/:tenantId/conversations/:conversationId/messages', async (c) => {
    const { tenantId, conversationId } = c.req.param();

    const tenant = await resolveTenant(tenantId);
    if (!tenant) {
        return c.json({ error: 'Tenant not found', code: 'NOT_FOUND' }, 404);
    }
    if (tenant.status !== 'active') {
        return c.json({ error: 'Tenant is not active', code: 'TENANT_INACTIVE' }, 403);
    }

    const conversation = await resolveConversation(conversationId, tenantId);
    if (!conversation) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    const data = await db
        .select()
        .from(messages)
        .where(and(
            eq(messages.conversationId, conversationId),
            eq(messages.tenantId, tenantId),
        ))
        .orderBy(asc(messages.createdAt));

    return c.json({ data });
});

// POST /widget/:tenantId/conversations/:conversationId/messages — send message (full relay)
widgetRoutes.post('/:tenantId/conversations/:conversationId/messages', async (c) => {
    const { tenantId, conversationId } = c.req.param();

    const schema = z.object({ content: z.string().min(1) });
    const result = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const tenant = await resolveTenant(tenantId);
    if (!tenant) {
        return c.json({ error: 'Tenant not found', code: 'NOT_FOUND' }, 404);
    }
    if (tenant.status !== 'active') {
        return c.json({ error: 'Tenant is not active', code: 'TENANT_INACTIVE' }, 403);
    }

    const conversation = await resolveConversation(conversationId, tenantId);
    if (!conversation) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    // Widget conversations may have no authenticated user — use externalUserId as a fallback
    // so the relay and bundler receive a non-null identifier.
    const userId = conversation.userId ?? conversation.externalUserId ?? 'widget';

    try {
        const assistantMessage = await runMessageRelay(
            conversationId,
            tenantId,
            conversation.agentId,
            userId,
            result.data.content,
        );
        return c.json({ data: assistantMessage }, 201);
    } catch (err: unknown) {
        if (err instanceof RelayError) {
            return c.json({ error: err.message, code: err.code }, err.status);
        }
        throw err;
    }
});

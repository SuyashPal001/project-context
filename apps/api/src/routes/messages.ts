import { Hono } from 'hono';
import { and, eq, asc, gte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { conversations, messages } from '@serverless-saas/database/schema/conversations';
import { usageRecords } from '@serverless-saas/database/schema/billing';
import { runMessageRelay, RelayError } from './_relay';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const messagesRoutes = new Hono<AppEnv>();

// Verify conversation belongs to tenant and return full row
async function resolveConversation(conversationId: string, tenantId: string) {
    const [conversation] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
        .limit(1);
    return conversation ?? null;
}

// GET /conversations/:conversationId/messages — list messages for conversation
messagesRoutes.get('/:conversationId/messages', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const conversationId = c.req.param('conversationId');

    if (!await resolveConversation(conversationId, tenantId)) {
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

// POST /conversations/:conversationId/messages — relay user message to AI and return assistant response
messagesRoutes.post('/:conversationId/messages', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const conversationId = c.req.param('conversationId');

    const schema = z.object({ content: z.string().min(1) });
    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const conversation = await resolveConversation(conversationId, tenantId);
    if (!conversation) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    try {
        const assistantMessage = await runMessageRelay(
            conversationId,
            tenantId,
            conversation.agentId,
            userId,
            result.data.content,
        );

        db.insert(usageRecords).values({
            tenantId,
            metric: 'messages',
            quantity: 1,
            actorId: userId,
            actorType: 'user',
            recordedAt: new Date(),
        }).catch((err: unknown) => console.error('usage record failed:', err));

        return c.json({ data: assistantMessage }, 201);
    } catch (err: unknown) {
        if (err instanceof RelayError) {
            return c.json({ error: err.message, code: err.code }, err.status);
        }
        throw err;
    }
});

// POST /conversations/:conversationId/messages/save — internal route for relay to save messages
messagesRoutes.post('/:conversationId/messages/save', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    const conversationId = c.req.param('conversationId');

    // Quick check that conversation exists and belongs to the tenant
    if (!await resolveConversation(conversationId, tenantId)) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    const schema = z.object({
        id: z.string().uuid().optional(),
        content: z.string().min(0),
        role: z.enum(['user', 'assistant']),
        attachments: z.array(z.object({
            fileId: z.string().optional(),
            name: z.string(),
            type: z.string(),
            size: z.number().optional(),
        })).nullish(),
        artifactRef: z.object({
            type: z.enum(['prd', 'roadmap', 'tasks']),
            entityId: z.string(),
            title: z.string(),
        }).nullish(),
        createdAt: z.string().datetime().optional(),
    });

    const body = await c.req.json();
    const result = schema.safeParse(body);

    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    // For user messages: deduplicate within a 60-second window by (conversationId, content).
    // The frontend pre-saves with fileId; the GCP relay also saves (without fileId).
    // Whichever arrives first wins the INSERT; the second caller merges fileId if available.
    if (result.data.role === 'user') {
        const windowStart = new Date(Date.now() - 60_000);
        const [existing] = await db
            .select()
            .from(messages)
            .where(and(
                eq(messages.conversationId, conversationId),
                eq(messages.tenantId, tenantId),
                eq(messages.role, 'user'),
                eq(messages.content, result.data.content),
                gte(messages.createdAt, windowStart),
            ))
            .limit(1);

        if (existing) {
            const incomingAttachments = result.data.attachments as Array<{ fileId?: string; name: string; type: string; size?: number }> | null;
            const existingAttachments = existing.attachments as Array<{ fileId?: string; name: string; type: string; size?: number }> | null;
            const incomingHasFileId = incomingAttachments?.some(a => a.fileId);
            const existingHasFileId = existingAttachments?.some(a => a.fileId);

            if (incomingHasFileId && !existingHasFileId) {
                const [updated] = await db
                    .update(messages)
                    .set({ attachments: incomingAttachments })
                    .where(eq(messages.id, existing.id))
                    .returning();
                return c.json({ data: updated }, 200);
            }
            return c.json({ data: existing }, 200);
        }
    }

    const [message] = await db
        .insert(messages)
        .values({
            ...(result.data.id ? { id: result.data.id } : {}),
            conversationId: conversationId || (null as any),
            tenantId: tenantId || (null as any),
            role: result.data.role,
            content: result.data.content,
            attachments: result.data.attachments ?? null,
            artifactRef: result.data.artifactRef ?? null,
            createdAt: result.data.createdAt ? new Date(result.data.createdAt) : undefined,
        })
        .returning();

    return c.json({ data: message }, 201);
});

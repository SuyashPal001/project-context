import { Hono } from 'hono';
import { and, eq, asc, gte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { conversations, messages } from '@serverless-saas/agent-schema/conversations';
import { usageRecords } from '@serverless-saas/database/schema/billing';
import { runMessageRelay, RelayError } from './_orchestrator';
import { hasPermission } from '@serverless-saas/permissions';
import { isAuthorized } from './internal/tasks.auth';
import type { AppEnv } from '@serverless-saas/types';

const AGENT_ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL ?? '';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY ?? '';

export const messagesRoutes = new Hono<AppEnv>();

// Verify conversation belongs strictly to this tenant+user (no cross-member bleed)
async function resolveConversation(conversationId: string, tenantId: string, userId: string) {
    const [conversation] = await db
        .select()
        .from(conversations)
        .where(and(
            eq(conversations.id, conversationId),
            eq(conversations.tenantId, tenantId),
            eq(conversations.userId, userId),
        ))
        .limit(1);
    return conversation ?? null;
}

// GET /conversations/:conversationId/messages — list messages for conversation (member-scoped)
messagesRoutes.get('/:conversationId/messages', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const conversationId = c.req.param('conversationId');

    if (!await resolveConversation(conversationId, tenantId, userId)) {
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
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const conversationId = c.req.param('conversationId');

    const schema = z.object({ content: z.string().min(1) });
    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const conversation = await resolveConversation(conversationId, tenantId, userId);
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
            quantity: '1',
            actorId: userId,
            actorType: 'human',
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
//
// Infrastructure-only. Without this gate any tenant member could POST directly
// with role: 'assistant' and forge AI output the model never produced, and — because
// the legitimate POST /messages route is the one that writes usageRecords —
// route around metering entirely. A user JWT is not sufficient here: the caller
// must prove it is the relay, not merely that it owns the conversation.
messagesRoutes.post('/:conversationId/messages/save', async (c) => {
    if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
        return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;

    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const conversationId = c.req.param('conversationId');

    // Quick check that conversation exists and belongs strictly to this tenant+user
    if (!await resolveConversation(conversationId, tenantId, userId)) {
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
            generation: z.object({
                creditsUsedMicro: z.string(),
                model: z.string(),
            }).optional(),
        })).nullish(),
        artifactRef: z.object({
            type: z.enum(['prd', 'roadmap', 'tasks']),
            entityId: z.string(),
            title: z.string(),
        }).nullish(),
        completedTrace: z.object({
            elapsedSec: z.number(),
            toolCallCount: z.number(),
            reasoningText: z.string().optional(),
            reasoningElapsedSec: z.number().optional(),
        }).nullish(),
        clarificationRequest: z.object({
            id: z.string(),
            questions: z.array(z.any()),
            status: z.enum(['pending', 'answered', 'skipped']),
            answers: z.record(z.string(), z.any()).optional(),
            answeredAt: z.string().optional(),
        }).nullish(),
        approvalRequest: z.object({
            id: z.string(),
            toolName: z.string(),
            arguments: z.record(z.string(), z.any()),
            description: z.string(),
            status: z.enum(['pending', 'approved', 'dismissed']),
            decisionAt: z.string().optional(),
        }).nullish(),
        generationConfirmRequest: z.object({
            id: z.string(),
            resourceType: z.string(),
            subject: z.string(),
            label: z.string(),
            status: z.enum(['pending', 'approved', 'declined']),
            decisionAt: z.string().optional(),
            declineReason: z.string().max(500).optional(),
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
            completedTrace: result.data.completedTrace ?? null,
            clarificationRequest: result.data.clarificationRequest ?? null,
            approvalRequest: result.data.approvalRequest ?? null,
            generationConfirmRequest: result.data.generationConfirmRequest ?? null,
            createdAt: result.data.createdAt ? new Date(result.data.createdAt) : undefined,
        })
        .returning();

    return c.json({ data: message }, 201);
});

// PATCH /conversations/:conversationId/messages/:messageId/clarification — update clarification status
// Internal only: called by the orchestrator when the user finishes answering.
messagesRoutes.patch('/:conversationId/messages/:messageId/clarification', async (c) => {
    if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
        return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');

    const schema = z.object({
        clarificationRequest: z.object({
            status: z.enum(['pending', 'answered', 'skipped']),
            answers: z.record(z.string(), z.any()).optional(),
            answeredAt: z.string().optional(),
        }),
    });

    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const [existing] = await db
        .select({ clarificationRequest: messages.clarificationRequest })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .limit(1);

    if (!existing) return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);

    const merged = { ...(existing.clarificationRequest as object ?? {}), ...result.data.clarificationRequest };

    const [updated] = await db
        .update(messages)
        .set({ clarificationRequest: merged })
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .returning();

    return c.json({ data: updated }, 200);
});

// DELETE /conversations/:conversationId/messages/truncate
// Deletes all messages in this conversation at or after fromTimestamp from both the
// app DB and Mastra memory. Used by Regenerate and Edit & Resubmit on the frontend.
messagesRoutes.delete('/:conversationId/messages/truncate', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const conversationId = c.req.param('conversationId');

    const schema = z.object({ fromTimestamp: z.string().datetime() });
    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);
    if (!result.success) {
        return c.json({ error: 'fromTimestamp (ISO datetime) is required', code: 'VALIDATION_ERROR' }, 400);
    }

    if (!await resolveConversation(conversationId, tenantId, userId)) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    const fromDate = new Date(result.data.fromTimestamp);

    // Delete from app DB
    await db
        .delete(messages)
        .where(and(
            eq(messages.conversationId, conversationId),
            eq(messages.tenantId, tenantId),
            gte(messages.createdAt, fromDate),
        ));

    // Delete from Mastra memory (fire-and-forget — app DB is source of truth for UI)
    if (AGENT_ORCHESTRATOR_URL) {
        fetch(`${AGENT_ORCHESTRATOR_URL}/thread/truncate`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': INTERNAL_SERVICE_KEY },
            body: JSON.stringify({ conversationId, fromTimestamp: result.data.fromTimestamp }),
        }).catch(err => console.warn('[truncate] Mastra call failed:', err.message));
    }

    return c.json({ ok: true });
});

// PATCH /conversations/:conversationId/messages/:messageId/approval — update approval status
// Internal only: called by the orchestrator when the user approves or dismisses.
messagesRoutes.patch('/:conversationId/messages/:messageId/approval', async (c) => {
    if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
        return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');

    const schema = z.object({
        approvalRequest: z.object({
            status: z.enum(['pending', 'approved', 'dismissed']),
            decisionAt: z.string().optional(),
        }),
    });

    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const [existing] = await db
        .select({ approvalRequest: messages.approvalRequest })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .limit(1);

    if (!existing) return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);

    const merged = { ...(existing.approvalRequest as object ?? {}), ...result.data.approvalRequest };

    const [updated] = await db
        .update(messages)
        .set({ approvalRequest: merged })
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .returning();

    return c.json({ data: updated }, 200);
});

// PATCH /conversations/:conversationId/messages/:messageId/generation-confirm — update generation confirm status
// Internal only: called by the orchestrator when the user confirms or declines a generation.
messagesRoutes.patch('/:conversationId/messages/:messageId/generation-confirm', async (c) => {
    if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
        return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);

    const conversationId = c.req.param('conversationId');
    const messageId = c.req.param('messageId');

    const schema = z.object({
        generationConfirmRequest: z.object({
            status: z.enum(['pending', 'approved', 'declined']),
            decisionAt: z.string().optional(),
            declineReason: z.string().max(500).optional(),
        }),
    });

    const body = await c.req.json().catch(() => null);
    const result = schema.safeParse(body);
    if (!result.success) {
        return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() }, 400);
    }

    const [existing] = await db
        .select({ generationConfirmRequest: messages.generationConfirmRequest })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .limit(1);

    if (!existing) return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);

    const merged = { ...(existing.generationConfirmRequest as object ?? {}), ...result.data.generationConfirmRequest };

    const [updated] = await db
        .update(messages)
        .set({ generationConfirmRequest: merged })
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
        .returning();

    return c.json({ data: updated }, 200);
});

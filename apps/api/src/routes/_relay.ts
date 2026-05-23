import { eq } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { conversations, messages } from '@serverless-saas/agent-schema/conversations';
import { bundleAgentConfig } from '@serverless-saas/ai/src/config/bundler';
import { getRuntime } from '@serverless-saas/ai/src/runtime/factory';
import { createEventHandler } from '@serverless-saas/ai/src/events/handler';
import { createSession, touchSession, endSession, clearSession } from '@serverless-saas/ai/src/sessions/manager';
import { recordAgentUsage, recordSessionStart, type UsageContext } from '@serverless-saas/ai/src/usage/recorder';
import type { AgentEvent } from '@serverless-saas/ai/src/runtime/types';
import { pushToConnectedClients } from '@serverless-saas/cache/src/websocket-push';

export class RelayError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly status: 400 | 404 | 500,
    ) {
        super(message);
        this.name = 'RelayError';
    }
}

function bundleErrorStatus(code: string): 400 | 404 | 500 {
    if (code === 'AGENT_NOT_FOUND' || code === 'CONVERSATION_NOT_FOUND') return 404;
    return 400;
}

/**
 * Core AI relay: sends a user message through the agent runtime, streams events
 * to the frontend via WebSocket, saves the assistant response, and meters tokens.
 *
 * Sessions are tracked in Redis for visibility and TTL management.
 * Each Lambda invocation starts a fresh VM session (WebSocket connections
 * are per-instance; cross-instance session reuse requires a proxy layer).
 *
 * Throws RelayError on known failure modes; unknown errors propagate as-is.
 */
export async function runMessageRelay(
    conversationId: string,
    tenantId: string,
    agentId: string,
    userId: string,
    content: string,
): Promise<typeof messages.$inferSelect> {
    // 1. Bundle config — loads conversation history BEFORE saving the user message
    //    so history and sendMessage don't contain the same message twice
    const configResult = await bundleAgentConfig({
        tenantId,
        userId,
        agentId,
        conversationId,
        historyLimit: 20,
    });

    if (!configResult.success) {
        throw new RelayError(
            configResult.error,
            configResult.code,
            bundleErrorStatus(configResult.code),
        );
    }

    // 2. Save user message to DB
    await db.insert(messages).values({
        conversationId: conversationId || (null as any),
        tenantId: tenantId || (null as any),
        role: 'user',
        content,
    });

    // 3. Allocate a session ID and register it in Redis
    //    createSession() returns an existing session if one is already tracked
    //    for this conversation, otherwise stores the new ID
    const sessionId = configResult.config.sessionId;
    await createSession({
        sessionId,
        conversationId,
        tenantId,
        agentId,
        userId,
    });

    // Usage context — shared by recordSessionStart and recordAgentUsage below
    const usageContext: UsageContext = {
        tenantId,
        agentId: agentId || (null as any),
        userId: userId || (null as any),
        conversationId: conversationId || (null as any),
        sessionId: sessionId || (null as any),
    };

    // Record session start for analytics (one record per new session)
    try {
        await recordSessionStart(usageContext);
    } catch (err) {
        console.error('[Relay] Failed to record session start:', err);
    }

    // 4. Create event handler — accumulates response content and pushes events to frontend
    const { handler, getResult } = createEventHandler({
        tenantId,
        userId,
        conversationId,
        pushToFrontend: (event: AgentEvent) =>
            pushToConnectedClients(tenantId, userId, {
                type: 'agent.event',
                payload: event as unknown as Record<string, unknown>,
            }),
    });

    try {
        // 5. Start VM session — sends full config (skill, policy, LLM creds, history)
        const runtime = getRuntime();
        const sessionResult = await runtime.startSession(configResult.config, handler);

        if (sessionResult.status === 'error') {
            throw new RelayError(
                sessionResult.error ?? 'Failed to start agent session',
                'SESSION_ERROR',
                500,
            );
        }

        // 6. Send user message — VM streams events back via handler
        await runtime.sendMessage(sessionResult.sessionId, content, handler);

        // 7. Extend session TTL now that we've had a successful exchange
        await touchSession(sessionId);

        // 8. End VM session and collect final usage
        const usageReport = await runtime.endSession(sessionResult.sessionId, 'completed');

        // 9. Mark session as completed in Redis
        await endSession(sessionId, 'completed');

        // 10. Read accumulated result
        const { accumulatedContent, usage, errors } = getResult();
        const finalUsage = usageReport ?? usage;

        if (!accumulatedContent) {
            throw new RelayError('No response received from agent', 'EMPTY_RESPONSE', 500);
        }

        // 11. Save assistant message
        const [assistantMessage] = await db
            .insert(messages)
            .values({
                conversationId: conversationId || (null as any),
                tenantId: tenantId || (null as any),
                role: 'assistant',
                content: accumulatedContent,
                tokenCount: finalUsage?.totalTokens ?? null,
                model: finalUsage?.model ?? null,
            })
            .returning();

        // 12. Record usage for billing metering (non-fatal — don't block the response)
        if (finalUsage) {
            try {
                await recordAgentUsage(usageContext, finalUsage);
            } catch (err) {
                console.error('[Relay] Failed to record usage:', err);
            }
        }

        // 13. Escalate conversation if the runtime reported unrecoverable errors
        if (errors.length > 0) {
            await db
                .update(conversations)
                .set({ needsHuman: true })
                .where(eq(conversations.id, conversationId));
        }

        return assistantMessage;

    } catch (err: unknown) {
        // Clear session tracking on error so the next request starts fresh
        await clearSession(conversationId);

        if (err instanceof RelayError) throw err;
        throw err;
    }
}

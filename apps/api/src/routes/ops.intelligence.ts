import { and, eq, desc, count, avg, sql, countDistinct } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { tenants } from '@serverless-saas/database/schema';
import { conversations } from '@serverless-saas/agent-schema';
import { toolCallLogs } from '@serverless-saas/agent-schema/intelligence';
import { conversationMetrics, evalResults, conversationFeedback, messages } from '@serverless-saas/agent-schema/conversations';
import { isPlatformAdmin } from './ops.guard';
import { getLogger } from '@serverless-saas/logger';
import type { Context } from 'hono';
import type { AppEnv } from '../types';

const logger = getLogger({ serviceName: 'ops-api' });

// GET /ops/agent-intelligence/knowledge-gaps
export async function handleKnowledgeGaps(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const page = parseInt(c.req.query('page') ?? '1');
    const pageSize = parseInt(c.req.query('pageSize') ?? '50');

    try {
        const rows = await db
            .select({
                tenantId: conversations.tenantId, tenantName: tenants.name,
                question: conversations.title,
                lastSeen: sql<string>`MAX(${conversationMetrics.createdAt})`,
                timesAsked: sql<number>`COUNT(*)`,
            })
            .from(conversationMetrics)
            .innerJoin(conversations, eq(conversationMetrics.conversationId, conversations.id))
            .leftJoin(tenants, eq(conversations.tenantId, tenants.id))
            .where(and(eq(conversationMetrics.ragFired, true), eq(conversationMetrics.ragChunksRetrieved, 0)))
            .groupBy(conversations.tenantId, tenants.name, conversations.title)
            .orderBy(desc(sql`COUNT(*)`))
            .limit(pageSize).offset((page - 1) * pageSize);

        const [totalRow] = await db
            .select({ value: countDistinct(conversations.title) })
            .from(conversationMetrics)
            .innerJoin(conversations, eq(conversationMetrics.conversationId, conversations.id))
            .where(and(eq(conversationMetrics.ragFired, true), eq(conversationMetrics.ragChunksRetrieved, 0)));

        return c.json({
            gaps: rows.map((r: typeof rows[number]) => ({ ...r, status: 'open' as const })),
            total: totalRow?.value ?? 0, page,
            totalPages: Math.ceil((totalRow?.value ?? 0) / pageSize),
        });
    } catch (err) {
        logger.error('ops_knowledge_gaps_failed', { traceId: c.get('traceId') ?? 'unknown', error: err as Error });
        return c.json({ gaps: [], total: 0, page, totalPages: 0 });
    }
}

// GET /ops/agent-intelligence/eval-scores
export async function handleEvalScores(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    try {
        const scoreRows = await db
            .select({ tenantId: evalResults.tenantId, tenantName: tenants.name, avgScore: avg(evalResults.score), evalCount: count() })
            .from(evalResults).leftJoin(tenants, eq(evalResults.tenantId, tenants.id))
            .groupBy(evalResults.tenantId, tenants.name).orderBy(desc(avg(evalResults.score)));

        const feedbackRows = await db
            .select({ tenantId: conversationFeedback.tenantId, total: count(), thumbsUp: sql<number>`SUM(CASE WHEN ${conversationFeedback.rating} = 'up' THEN 1 ELSE 0 END)` })
            .from(conversationFeedback).groupBy(conversationFeedback.tenantId);

        const ragRows = await db
            .select({ tenantId: conversations.tenantId, total: count(), ragHits: sql<number>`SUM(CASE WHEN ${conversationMetrics.ragFired} = true AND ${conversationMetrics.ragChunksRetrieved} > 0 THEN 1 ELSE 0 END)` })
            .from(conversationMetrics).innerJoin(conversations, eq(conversationMetrics.conversationId, conversations.id))
            .groupBy(conversations.tenantId);

        const fbMap = Object.fromEntries(feedbackRows.map((r: typeof feedbackRows[number]) => [r.tenantId, r]));
        const ragMap = Object.fromEntries(ragRows.map((r: typeof ragRows[number]) => [r.tenantId, r]));

        const scores = scoreRows.map((r: typeof scoreRows[number]) => {
            const fb = fbMap[r.tenantId];
            const rag = ragMap[r.tenantId];
            return {
                tenantId: r.tenantId, tenantName: r.tenantName ?? '—',
                avgScore: r.avgScore !== null ? parseFloat(String(r.avgScore)).toFixed(2) : null,
                evalCount: r.evalCount,
                thumbsUpPct: fb && fb.total > 0 ? Math.round((Number(fb.thumbsUp) / Number(fb.total)) * 100) : null,
                ragHitRate: rag && rag.total > 0 ? Math.round((Number(rag.ragHits) / Number(rag.total)) * 100) : null,
            };
        });

        return c.json({ scores });
    } catch (err) {
        logger.error('ops_eval_scores_failed', { traceId: c.get('traceId') ?? 'unknown', error: err as Error });
        return c.json({ scores: [] });
    }
}

// GET /ops/agent-intelligence/tool-performance
export async function handleToolPerformance(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    try {
        const rows = await db
            .select({
                toolName: toolCallLogs.toolName, tenantId: toolCallLogs.tenantId, tenantName: tenants.name,
                callCount: count(),
                successCount: sql<number>`SUM(CASE WHEN ${toolCallLogs.success} = true THEN 1 ELSE 0 END)`,
                avgLatencyMs: sql<number>`AVG(${toolCallLogs.latencyMs})`,
                lastError: sql<string>`MAX(CASE WHEN ${toolCallLogs.success} = false THEN ${toolCallLogs.errorMessage} END)`,
                lastSeen: sql<string>`MAX(${toolCallLogs.createdAt})`,
            })
            .from(toolCallLogs).leftJoin(tenants, eq(toolCallLogs.tenantId, tenants.id))
            .groupBy(toolCallLogs.toolName, toolCallLogs.tenantId, tenants.name)
            .orderBy(desc(count()));

        return c.json({
            tools: rows.map((r: typeof rows[number]) => ({
                toolName: r.toolName, tenantId: r.tenantId, tenantName: r.tenantName ?? '—',
                callCount: r.callCount,
                successRate: r.callCount > 0 ? Math.round((Number(r.successCount) / r.callCount) * 100) : null,
                avgLatencyMs: r.avgLatencyMs !== null ? Math.round(Number(r.avgLatencyMs)) : null,
                lastError: r.lastError ?? null, lastSeen: r.lastSeen ?? null,
            })),
        });
    } catch (err) {
        logger.error('ops_tool_performance_failed', { traceId: c.get('traceId') ?? 'unknown', error: err as Error });
        return c.json({ tools: [] });
    }
}

// GET /ops/evals/results
export async function handleEvalsResults(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const page = parseInt(c.req.query('page') ?? '1');
    const pageSize = 50;
    const filterTenantId = c.req.query('tenantId');
    const filterDimension = c.req.query('dimension');
    const maxScoreParam = c.req.query('maxScore');
    const maxScore = maxScoreParam ? parseFloat(maxScoreParam) : null;

    const conditions: any[] = [];
    if (filterTenantId) conditions.push(eq(evalResults.tenantId, filterTenantId));
    if (filterDimension) conditions.push(eq(evalResults.evalType, filterDimension));
    if (maxScore !== null) conditions.push(sql`${evalResults.score} <= ${maxScore}`);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
        .select({
            id: evalResults.id, tenantId: evalResults.tenantId, tenantName: tenants.name,
            messageContent: messages.content, dimension: evalResults.evalType,
            score: evalResults.score, reasoning: evalResults.reasoning,
            model: evalResults.model, createdAt: evalResults.createdAt,
        })
        .from(evalResults)
        .leftJoin(tenants, eq(evalResults.tenantId, tenants.id))
        .leftJoin(messages, eq(evalResults.messageId, messages.id))
        .where(where).orderBy(desc(evalResults.createdAt)).limit(pageSize).offset((page - 1) * pageSize);

    const [totalRow] = await db.select({ value: count() }).from(evalResults).where(where);

    return c.json({
        results: rows.map((r: typeof rows[number]) => ({
            id: r.id, tenantId: r.tenantId, tenantName: r.tenantName ?? null,
            messagePreview: r.messageContent ? r.messageContent.slice(0, 80) : null,
            dimension: r.dimension, score: r.score !== null ? parseFloat(String(r.score)) : null,
            reasoning: r.reasoning ?? null, model: r.model ?? null,
            createdAt: r.createdAt?.toISOString() ?? null,
        })),
        total: totalRow?.value ?? 0, page, totalPages: Math.ceil((totalRow?.value ?? 0) / pageSize),
    });
}

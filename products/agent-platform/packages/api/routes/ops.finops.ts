import { and, eq, desc, count, sum, avg, gte, countDistinct } from 'drizzle-orm';
import { db } from '../db';
import { tenants } from '@serverless-saas/database/schema';
import { conversationMetrics, evalResults } from '@serverless-saas/agent-schema/conversations';
import { isPlatformAdmin } from './ops.guard';
import { getLogger } from '@serverless-saas/logger';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const logger = getLogger({ serviceName: 'ops-api' });

// GET /ops/finops
export async function handleFinops(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const traceId = c.get('traceId') ?? 'unknown';
    const periodParam = c.req.query('period') ?? '30d';
    const now = new Date();
    let start: Date;
    if (periodParam === 'today') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (periodParam === '7d') {
        start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
        start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    try {
        const [summary] = await db.select({
            totalCost: sum(conversationMetrics.totalCost),
            totalInputTokens: sum(conversationMetrics.inputTokens),
            totalOutputTokens: sum(conversationMetrics.outputTokens),
            conversationCount: count(),
            tenantsWithSpend: countDistinct(conversationMetrics.tenantId),
        }).from(conversationMetrics).where(gte(conversationMetrics.createdAt, start));

        const byTenant = await db.select({
            tenantId: conversationMetrics.tenantId, tenantName: tenants.name,
            cost: sum(conversationMetrics.totalCost), inputTokens: sum(conversationMetrics.inputTokens),
            outputTokens: sum(conversationMetrics.outputTokens), conversationCount: count(),
        }).from(conversationMetrics)
            .leftJoin(tenants, eq(conversationMetrics.tenantId, tenants.id))
            .where(gte(conversationMetrics.createdAt, start))
            .groupBy(conversationMetrics.tenantId, tenants.name)
            .orderBy(desc(sum(conversationMetrics.totalCost)));

        const topConversations = await db.select({
            conversationId: conversationMetrics.conversationId, tenantId: conversationMetrics.tenantId,
            tenantName: tenants.name, cost: conversationMetrics.totalCost,
            inputTokens: conversationMetrics.inputTokens, outputTokens: conversationMetrics.outputTokens,
            createdAt: conversationMetrics.createdAt,
        }).from(conversationMetrics)
            .leftJoin(tenants, eq(conversationMetrics.tenantId, tenants.id))
            .where(gte(conversationMetrics.createdAt, start))
            .orderBy(desc(conversationMetrics.totalCost)).limit(20);

        const totalCost = parseFloat(String(summary?.totalCost ?? '0'));
        const conversationCount = Number(summary?.conversationCount ?? 0);

        return c.json({
            totalCost,
            totalInputTokens: parseInt(String(summary?.totalInputTokens ?? '0'), 10),
            totalOutputTokens: parseInt(String(summary?.totalOutputTokens ?? '0'), 10),
            avgCostPerConversation: conversationCount > 0 ? totalCost / conversationCount : 0,
            activeTenantsWithSpend: Number(summary?.tenantsWithSpend ?? 0),
            byTenant: byTenant.map((r: typeof byTenant[number]) => ({
                tenantId: r.tenantId, tenantName: r.tenantName ?? null,
                cost: parseFloat(String(r.cost ?? '0')),
                inputTokens: parseInt(String(r.inputTokens ?? '0'), 10),
                outputTokens: parseInt(String(r.outputTokens ?? '0'), 10),
                conversationCount: Number(r.conversationCount),
            })),
            topConversations: topConversations.map((r: typeof topConversations[number]) => ({
                conversationId: r.conversationId, tenantId: r.tenantId, tenantName: r.tenantName ?? null,
                cost: parseFloat(String(r.cost ?? '0')),
                inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0,
                createdAt: r.createdAt?.toISOString() ?? null,
            })),
        });
    } catch (err) {
        logger.error('ops_finops_failed', { traceId, period: periodParam, error: err as Error });
        return c.json({ error: 'Failed to load FinOps data', code: 'QUERY_ERROR' }, 500);
    }
}

// GET /ops/overview
export async function handleOverview(c: Context<AppEnv>) {
    if (!isPlatformAdmin(c)) return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);

    const traceId = c.get('traceId') ?? 'unknown';
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    try {
        const [[tenantCountRow], [avgScoreRow], [gapCountRow], [costRow]] = await Promise.all([
            db.select({ value: count() }).from(tenants).where(eq(tenants.status, 'active')),
            db.select({ value: avg(evalResults.score) }).from(evalResults).catch(() => [{ value: null }]),
            db.select({ value: countDistinct(conversationMetrics.conversationId) })
                .from(conversationMetrics)
                .where(and(eq(conversationMetrics.ragFired, true), eq(conversationMetrics.ragChunksRetrieved, 0)))
                .catch(() => [{ value: 0 }]),
            db.select({ value: sum(conversationMetrics.totalCost) })
                .from(conversationMetrics).where(gte(conversationMetrics.createdAt, monthStart))
                .catch(() => [{ value: null }]),
        ]);

        return c.json({
            activeTenants: tenantCountRow?.value ?? 0,
            avgEvalScore: avgScoreRow?.value !== null ? parseFloat(String(avgScoreRow?.value ?? 0)).toFixed(2) : null,
            openKnowledgeGaps: gapCountRow?.value ?? 0,
            totalCostThisMonth: costRow?.value !== null ? parseFloat(String(costRow?.value ?? 0)).toFixed(4) : null,
        });
    } catch (err) {
        logger.error('ops_overview_failed', { traceId, error: err as Error });
        return c.json({ error: 'Failed to load overview', code: 'QUERY_ERROR' }, 500);
    }
}

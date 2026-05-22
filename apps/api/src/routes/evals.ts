import { Hono } from 'hono';
import { and, eq, sql, desc, gte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import {
  conversations,
  messages,
  conversationFeedback,
  conversationMetrics,
} from '@serverless-saas/database/schema/conversations';
import { agents } from '@serverless-saas/database/schema/agents';
import { toolCallLogs } from '@serverless-saas/database/schema/intelligence';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

// ── Feedback route — mounted at /conversations ────────────────────────────────
// POST /conversations/:conversationId/messages/:messageId/feedback

export const evalsFeedbackRoutes = new Hono<AppEnv>();

evalsFeedbackRoutes.post('/:conversationId/messages/:messageId/feedback', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  const userId = c.get('userId') as string | undefined;

  if (!hasPermission(permissions, 'conversations', 'update')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const { conversationId, messageId } = c.req.param();

  const schema = z.object({
    rating: z.enum(['up', 'down']),
    comment: z.string().max(200).optional(),
  });

  const result = schema.safeParse(await c.req.json());
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  await db
    .insert(conversationFeedback)
    .values({
      messageId,
      conversationId,
      tenantId,
      userId: userId ?? null,
      rating: result.data.rating,
      comment: result.data.comment ?? null,
    })
    .onConflictDoNothing(); // unique(messageId, userId) — no re-rating

  return c.json({ success: true }, 201);
});

// ── Analytics routes — mounted at /evals ─────────────────────────────────────

export const evalsRoutes = new Hono<AppEnv>();

// GET /evals/summary
evalsRoutes.get('/summary', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'analytics', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const [{ totalConversations }] = await db
    .select({ totalConversations: sql<number>`COUNT(*)::int` })
    .from(conversations)
    .where(eq(conversations.tenantId, tenantId));

  const [feedbackAgg] = await db
    .select({
      ratedMessages: sql<number>`COUNT(*)::int`,
      thumbsUp: sql<number>`SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END)::int`,
      thumbsDown: sql<number>`SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END)::int`,
    })
    .from(conversationFeedback)
    .where(eq(conversationFeedback.tenantId, tenantId));

  const [metricsAgg] = await db
    .select({
      totalMetrics: sql<number>`COUNT(*)::int`,
      ragFiredCount: sql<number>`SUM(CASE WHEN rag_fired THEN 1 ELSE 0 END)::int`,
      avgResponseTimeMs: sql<number>`COALESCE(AVG(response_time_ms), 0)::int`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(total_cost_cents), 0)::int`,
    })
    .from(conversationMetrics)
    .where(eq(conversationMetrics.tenantId, tenantId));

  const ratedMessages = feedbackAgg?.ratedMessages ?? 0;
  const thumbsUp = feedbackAgg?.thumbsUp ?? 0;
  const thumbsDown = feedbackAgg?.thumbsDown ?? 0;
  const totalMetrics = metricsAgg?.totalMetrics ?? 0;
  const ragFiredCount = metricsAgg?.ragFiredCount ?? 0;

  return c.json({
    totalConversations: totalConversations ?? 0,
    avgQualityScore: ratedMessages > 0 ? Math.round((thumbsUp / ratedMessages) * 100) : 0,
    ragHitRate: totalMetrics > 0 ? Math.round((ragFiredCount / totalMetrics) * 100) : 0,
    avgResponseTimeMs: metricsAgg?.avgResponseTimeMs ?? 0,
    totalTokens: metricsAgg?.totalTokens ?? 0,
    totalCost: ((metricsAgg?.totalCostCents ?? 0) / 100),
    ratedMessages,
    thumbsUp,
    thumbsDown,
  });
});

// GET /evals/messages?rating=up|down&limit=20&offset=0
evalsRoutes.get('/messages', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'analytics', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const ratingFilter = c.req.query('rating') as 'up' | 'down' | undefined;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const conditions = [eq(conversationFeedback.tenantId, tenantId)];
  if (ratingFilter === 'up' || ratingFilter === 'down') {
    conditions.push(eq(conversationFeedback.rating, ratingFilter));
  }

  const rows = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      content: messages.content,
      rating: conversationFeedback.rating,
      comment: conversationFeedback.comment,
      feedbackAt: conversationFeedback.createdAt,
    })
    .from(conversationFeedback)
    .innerJoin(messages, eq(messages.id, conversationFeedback.messageId))
    .where(and(...conditions))
    .orderBy(desc(conversationFeedback.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: rows });
});

// GET /evals/conversations?limit=20&offset=0
evalsRoutes.get('/conversations', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];

  if (!hasPermission(permissions, 'analytics', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const rows = await db
    .select()
    .from(conversationMetrics)
    .where(eq(conversationMetrics.tenantId, tenantId))
    .orderBy(desc(conversationMetrics.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: rows });
});

// GET /evals/tokens?days=30 — token + cost breakdown by agent and by model
evalsRoutes.get('/tokens', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'analytics', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '30', 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000);

  const [byAgent, byModel] = await Promise.all([
    db.select({
      agentId:      conversations.agentId,
      agentName:    agents.name,
      totalTokens:  sql<number>`COALESCE(SUM(cm.total_tokens), 0)::int`,
      inputTokens:  sql<number>`COALESCE(SUM(cm.input_tokens), 0)::int`,
      outputTokens: sql<number>`COALESCE(SUM(cm.output_tokens), 0)::int`,
      totalCost:    sql<number>`COALESCE(SUM(cm.total_cost::numeric), 0)::float`,
      conversations: sql<number>`COUNT(*)::int`,
    })
      .from(conversationMetrics)
      .innerJoin(conversations, eq(conversations.id, conversationMetrics.conversationId))
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .where(and(eq(conversationMetrics.tenantId, tenantId), gte(conversationMetrics.createdAt, since)))
      .groupBy(conversations.agentId, agents.name)
      .orderBy(desc(sql`SUM(cm.total_tokens)`)),

    db.select({
      model:        messages.model,
      messageCount: sql<number>`COUNT(*)::int`,
      totalTokens:  sql<number>`COALESCE(SUM(token_count), 0)::int`,
    })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), gte(messages.createdAt, since)))
      .groupBy(messages.model)
      .orderBy(desc(sql`SUM(token_count)`)),
  ]);

  return c.json({ data: { byAgent, byModel, period: { days, from: since.toISOString() } } });
});

// GET /evals/errors?days=7 — tool error rates and failure summary
evalsRoutes.get('/errors', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'analytics', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '7', 10) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db.select({
    toolName:   toolCallLogs.toolName,
    total:      sql<number>`COUNT(*)::int`,
    failures:   sql<number>`SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int`,
    avgLatency: sql<number>`COALESCE(AVG(latency_ms), 0)::int`,
  })
    .from(toolCallLogs)
    .where(and(eq(toolCallLogs.tenantId, tenantId), gte(toolCallLogs.createdAt, since)))
    .groupBy(toolCallLogs.toolName)
    .orderBy(desc(sql`SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)`));

  const tools = rows.map((r: typeof rows[number]) => ({
    toolName: r.toolName, total: r.total, failures: r.failures,
    errorRate: r.total > 0 ? Math.round((r.failures / r.total) * 1000) / 10 : 0,
    avgLatencyMs: r.avgLatency,
  }));

  return c.json({ data: { tools, period: { days, from: since.toISOString() } } });
});

// GET /evals/export?days=30 — CSV export of conversation metrics for periodic reports
evalsRoutes.get('/export', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'analytics', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '30', 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db.select({
    conversationId: conversationMetrics.conversationId,
    agentName:      agents.name,
    createdAt:      conversationMetrics.createdAt,
    totalTokens:    conversationMetrics.totalTokens,
    inputTokens:    conversationMetrics.inputTokens,
    outputTokens:   conversationMetrics.outputTokens,
    totalCost:      conversationMetrics.totalCost,
    responseTimeMs: conversationMetrics.responseTimeMs,
    ragFired:       conversationMetrics.ragFired,
    ragChunks:      conversationMetrics.ragChunksRetrieved,
  })
    .from(conversationMetrics)
    .innerJoin(conversations, eq(conversations.id, conversationMetrics.conversationId))
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(and(eq(conversationMetrics.tenantId, tenantId), gte(conversationMetrics.createdAt, since)))
    .orderBy(desc(conversationMetrics.createdAt))
    .limit(10_000);

  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const header = 'conversation_id,agent,timestamp,total_tokens,input_tokens,output_tokens,cost_usd,response_time_ms,rag_fired,rag_chunks'
  type ExportRow = typeof rows[number];
  const csvRows = rows.map((r: ExportRow) => [
    esc(r.conversationId), esc(r.agentName), esc(r.createdAt?.toISOString()),
    esc(r.totalTokens), esc(r.inputTokens), esc(r.outputTokens),
    esc(r.totalCost), esc(r.responseTimeMs), esc(r.ragFired), esc(r.ragChunks),
  ].join(','))

  const date = new Date().toISOString().slice(0, 10)
  return new Response([header, ...csvRows].join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="usage-report-${date}.csv"`,
    },
  });
});

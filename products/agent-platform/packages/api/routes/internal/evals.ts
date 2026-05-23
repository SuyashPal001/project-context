import { timingSafeEqual } from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { conversationMetrics, messages } from '@serverless-saas/agent-schema/conversations';
import { count, and, eq } from 'drizzle-orm';
import { publishToQueue } from '@serverless-saas/queue';
import type { AppEnv } from '@serverless-saas/types';

function isAuthorized(provided: string): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

const internalEvalsRoute = new Hono<AppEnv>();

// POST /internal/evals/metrics — relay calls this after each response
internalEvalsRoute.post('/metrics', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const schema = z.object({
    conversationId: z.string().uuid(),
    tenantId: z.string().uuid(),
    ragFired: z.boolean(),
    ragChunksRetrieved: z.number().int().min(0).default(0),
    responseTimeMs: z.number().int().min(0).optional(),
    totalTokens: z.number().int().min(0).default(0),
    inputTokens: z.number().int().min(0).default(0),
    outputTokens: z.number().int().min(0).default(0),
    userMessageCount: z.number().int().min(0).default(0),
    costUsd: z.number().min(0).optional(),
  });

  const result = schema.safeParse(await c.req.json());
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const d = result.data;

  const userMessageCountResult = await db
    .select({ count: count() })
    .from(messages)
    .where(and(eq(messages.conversationId, d.conversationId), eq(messages.role, 'user')));

  const actualUserMessageCount = userMessageCountResult[0]?.count ?? 0;

  await db
    .insert(conversationMetrics)
    .values({
      conversationId: d.conversationId,
      tenantId: d.tenantId,
      ragFired: d.ragFired,
      ragChunksRetrieved: d.ragChunksRetrieved,
      responseTimeMs: d.responseTimeMs ?? null,
      totalTokens: d.totalTokens,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      userMessageCount: actualUserMessageCount,
      totalCost: d.costUsd?.toString() ?? '0',
    })
    .onConflictDoUpdate({
      target: conversationMetrics.conversationId,
      set: {
        ragFired: d.ragFired,
        ragChunksRetrieved: d.ragChunksRetrieved,
        responseTimeMs: d.responseTimeMs ?? null,
        totalTokens: d.totalTokens,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        userMessageCount: actualUserMessageCount,
        totalCost: d.costUsd?.toString() ?? '0',
        updatedAt: new Date(),
      },
    });

  return c.json({ success: true }, 200);
});

// POST /internal/evals/auto — relay queues an AI eval job
internalEvalsRoute.post('/auto', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const schema = z.object({
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    tenantId: z.string().uuid(),
    question: z.string().min(1),
    retrievedChunks: z.array(z.string()),
    answer: z.string().min(1),
  });

  const result = schema.safeParse(await c.req.json());
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
  if (!queueUrl) {
    console.error('[internal/evals/auto] SQS_PROCESSING_QUEUE_URL not set');
    return c.json({ error: 'Queue not configured' }, 500);
  }

  await publishToQueue(queueUrl, { type: 'eval.auto', payload: result.data });

  return c.json({ queued: true }, 202);
});

export default internalEvalsRoute;

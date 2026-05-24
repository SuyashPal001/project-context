import { timingSafeEqual } from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db';
import { knowledgeGaps } from '@serverless-saas/agent-schema/intelligence';
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

const internalKnowledgeGapsRoute = new Hono<AppEnv>();

// POST /internal/knowledge-gaps — relay calls this when RAG fires but returns no chunks
internalKnowledgeGapsRoute.post('/', async (c) => {
  if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const schema = z.object({
    tenantId:       z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    query:          z.string().min(1),
    ragScore:       z.number().min(0).max(1).optional(),
  });

  const result = schema.safeParse(await c.req.json());
  if (!result.success) {
    return c.json({ error: result.error.errors[0].message }, 400);
  }

  const d = result.data;

  try {
    await db.insert(knowledgeGaps).values({
      tenantId:       d.tenantId,
      conversationId: d.conversationId ?? null,
      query:          d.query,
      ragScore:       d.ragScore?.toString() ?? null,
    });
  } catch (err) {
    console.error('[internal/knowledge-gaps] insert failed:', err);
  }

  return c.json({ success: true }, 200);
});

export default internalKnowledgeGapsRoute;

import { timingSafeEqual } from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { retrieveChunks, formatContextBlock } from '@serverless-saas/ai';
import { db } from '@serverless-saas/database';
import { documents } from '@serverless-saas/agent-schema/documents';
import { inArray } from 'drizzle-orm';
import type { AppEnv } from '../../types';

const SENSITIVITY_RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

function isAuthorized(provided: string): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

const bodySchema = z.object({
  query: z.string().min(1),
  tenantId: z.string().uuid(),
  limit: z.number().int().min(1).max(10).default(5),
  scoreThreshold: z.number().min(0).max(1).default(0.5),
});

const retrieveRoute = new Hono<AppEnv>();

// POST /api/v1/internal/retrieve
retrieveRoute.post(
  '/retrieve',
  zValidator('json', bodySchema),
  async (c) => {
    try {
      if (!isAuthorized(c.req.header('x-internal-service-key') ?? '')) {
        return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
      }

      const body = c.req.valid('json');
      const chunks = await retrieveChunks(
        body.query,
        body.tenantId,
        body.limit,
        body.scoreThreshold
      );

      const context = formatContextBlock(chunks);

      // Determine the highest sensitivity level across retrieved document chunks
      const docIds = [...new Set(chunks.filter(ch => ch.source === 'document').map(ch => ch.documentId))];
      let maxSensitivity = 'internal';
      if (docIds.length > 0) {
        const rows = await db.select({ s: documents.sensitivityLevel }).from(documents).where(inArray(documents.id, docIds));
        for (const row of rows) {
          if ((SENSITIVITY_RANK[row.s] ?? 0) > (SENSITIVITY_RANK[maxSensitivity] ?? 0)) maxSensitivity = row.s;
        }
      }

      return c.json({ context, chunks, maxSensitivity }, 200);
    } catch (error) {
      console.error('Retrieve failed:', error);
      return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
    }
  }
);

export default retrieveRoute;

import { timingSafeEqual } from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { retrieveChunks, formatContextBlock } from '@serverless-saas/ai';
import { db } from '@serverless-saas/database';
import { documents } from '@serverless-saas/database/schema/documents';
import { personFolders } from '@serverless-saas/database/schema';
import { inArray, and, eq } from 'drizzle-orm';
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
  // Optional: scope retrieval to a specific person folder by identifier string
  identifier: z.string().optional(),
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

      // Resolve person folder if identifier provided
      let personFolderId: string | undefined;
      if (body.identifier) {
        const [folder] = await db
          .select({ id: personFolders.id, status: personFolders.status })
          .from(personFolders)
          .where(and(eq(personFolders.tenantId, body.tenantId), eq(personFolders.identifier, body.identifier)))
          .limit(1);

        if (!folder) {
          return c.json({ context: `No record found for '${body.identifier}'. Please verify the identifier and try again.`, chunks: [], maxSensitivity: 'internal' }, 200);
        }
        if (folder.status === 'pending') {
          return c.json({ context: `Documents for '${body.identifier}' have been received but not yet verified. Please ask an admin to verify this folder.`, chunks: [], maxSensitivity: 'internal' }, 200);
        }
        personFolderId = folder.id;
      }

      const chunks = await retrieveChunks(
        body.query,
        body.tenantId,
        body.limit,
        body.scoreThreshold,
        personFolderId
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

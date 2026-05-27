import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { storageService } from '@serverless-saas/storage';
import { db } from '@serverless-saas/database';
import { files } from '@serverless-saas/database/schema';
import { users } from '@serverless-saas/database/schema/auth';
import { hasPermission } from '@serverless-saas/permissions';
import { eq, and, ne, like } from 'drizzle-orm';
import type { AppEnv } from '../types';

const RELAY_URL = process.env.RELAY_URL ?? 'http://localhost:3001';

export const filesFolderRoutes = new Hono<AppEnv>();

// POST /files/ingest-folder — trigger ingestion for all non-done files under a personalIdentifier prefix
filesFolderRoutes.post(
  '/ingest-folder',
  zValidator('json', z.object({
    personalIdentifier: z.string().min(1).max(100),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    const permissions = requestContext?.permissions || [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
    }

    const { personalIdentifier } = c.req.valid('json');
    const prefix = `${personalIdentifier}/`;

    // Fetch all non-done files matching this folder prefix
    const pending = await db
      .select({ id: files.id, name: files.name, mimeType: files.mimeType, uploadedBy: files.uploadedBy })
      .from(files)
      .where(and(
        eq(files.tenantId, tenantId),
        ne(files.ingestionStatus, 'done'),
        like(files.key, `${prefix}%`),
      ));

    if (pending.length === 0) {
      return c.json({ queued: 0, message: 'No pending files found' });
    }

    type PendingFile = { id: string; name: string; mimeType: string | null; uploadedBy: string | null };
    const pendingTyped = pending as PendingFile[];

    // Mark all as processing
    await Promise.all(pendingTyped.map((f) =>
      db.update(files)
        .set({ ingestionStatus: 'processing', updatedAt: new Date() })
        .where(and(eq(files.id, f.id), eq(files.tenantId, tenantId)))
    ));

    // Fire-and-forget: ingest each file via relay
    const ingestOne = async (file: PendingFile) => {
      try {
        const buffer = await storageService.downloadFile(tenantId, file.id);

        // Resolve uploader's personalIdentifier (fall back to the folder's identifier)
        let uploaderIdentifier = personalIdentifier;
        if (file.uploadedBy) {
          const [uploader] = await db
            .select({ personalIdentifier: users.personalIdentifier })
            .from(users)
            .where(eq(users.id, file.uploadedBy))
            .limit(1);
          uploaderIdentifier = uploader?.personalIdentifier ?? personalIdentifier;
        }

        const relayRes = await fetch(`${RELAY_URL}/internal/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: file.id,
            filename: file.name,
            mimeType: file.mimeType ?? 'application/octet-stream',
            bufferBase64: buffer.toString('base64'),
            tenantId: tenantId ?? 'unknown',
            personalIdentifier: uploaderIdentifier,
          }),
        });

        const relayData = await relayRes.json() as any;
        if (!relayRes.ok || !relayData.ok) throw new Error(relayData.error ?? `Relay ${relayRes.status}`);

        await db.update(files)
          .set({
            formatDetected: relayData.formatDetected,
            chunkCount: relayData.chunkCount,
            extractedFields: relayData.extractedFields ?? null,
            ingestionStatus: 'done',
            updatedAt: new Date(),
          })
          .where(and(eq(files.id, file.id), eq(files.tenantId, tenantId)));
      } catch (err: any) {
        console.error('[ingest-folder] failed for file', file.id, err.message);
        await db.update(files)
          .set({ ingestionStatus: 'failed', updatedAt: new Date() })
          .where(and(eq(files.id, file.id), eq(files.tenantId, tenantId)));
      }
    };

    // Don't await — respond immediately; poll via GET /files for status
    Promise.all(pendingTyped.map(ingestOne)).catch(console.error);

    return c.json({ queued: pending.length });
  }
);

// GET /files/folder-status/:identifier — aggregate ingestion status counts for a folder
filesFolderRoutes.get('/folder-status/:identifier', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const personalIdentifier = c.req.param('identifier');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  const prefix = `${personalIdentifier}/`;
  const allFiles = await db
    .select({ ingestionStatus: files.ingestionStatus })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), like(files.key, `${prefix}%`)));

  const counts = { pending: 0, processing: 0, done: 0, failed: 0, total: allFiles.length };
  for (const f of allFiles) {
    const s = f.ingestionStatus ?? 'pending';
    if (s in counts) (counts as any)[s]++;
  }

  return c.json({ personalIdentifier, counts });
});

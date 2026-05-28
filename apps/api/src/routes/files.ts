import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { storageService } from '@serverless-saas/storage';
import { db } from '@serverless-saas/database';
import { auditLog, files } from '@serverless-saas/database/schema';
import { users } from '@serverless-saas/database/schema/auth';
import { hasPermission } from '@serverless-saas/permissions';
import { eq, and, ne, isNull } from 'drizzle-orm';
import { personFolders } from '@serverless-saas/database/schema';
import { ingestFile } from '../services/ingestion';
import type { AppEnv } from '../types';

const RELAY_URL = process.env.RELAY_URL ?? 'http://localhost:3001';

function classifyDocument(filename: string): string {
  const name = filename.toLowerCase();
  const confidentialKeywords = [
    'ppo', 'pension', 'service_book', 'servicebook',
    'salary', 'gratuity', 'dcrg', 'itr', 'aadhaar',
    'aadhar', 'pan', 'payslip', 'retirement', 'family_pension'
  ];
  if (confidentialKeywords.some(k => name.includes(k))) return 'Confidential';
  return 'Internal';
}

const filesRoutes = new Hono<AppEnv>();

// Get presigned upload URL
filesRoutes.post(
  '/upload',
  zValidator('json', z.object({
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(127),
    key: z.string().max(512).optional(),
    personFolderId: z.string().uuid().optional(),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');
    const { filename, contentType, key: userKey, personFolderId } = c.req.valid('json');

    if (!userId) {
      return c.json({ error: 'Forbidden', message: 'Missing userId' }, 403);
    }

    const permissions = requestContext?.permissions || [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
    }

    const result = await storageService.getUploadUrl({
      tenantId,
      filename,
      contentType,
      uploadedBy: userId,
      userKey,
    });

    // Link to person folder if provided
    if (personFolderId) {
      await db.update(files).set({ personFolderId, updatedAt: new Date() }).where(eq(files.id, result.fileId));
    }

    await db.insert(auditLog).values({
      tenantId,
      actorId: userId,
      actorType: 'human',
      action: 'file_upload_requested',
      resource: 'file',
      resourceId: result.fileId,
      metadata: { filename, contentType },
      traceId: c.get('traceId') ?? '',
    });

    return c.json({ data: result }, 201);
  }
);

// Confirm upload completed
filesRoutes.post(
  '/:id/confirm',
  zValidator('json', z.object({
    size: z.number().int().positive(),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');
    const fileId = c.req.param('id');
    const { size } = c.req.valid('json');

    const permissions = requestContext?.permissions || [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
    }

    // Fetch the pending record to get its S3 key
    const [pendingRecord] = await db
      .select({ key: files.key })
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
      .limit(1);

    if (!pendingRecord) {
      return c.json({ error: 'Not Found', message: 'File record not found' }, 404);
    }

    // Check for an existing uploaded record with the same key (dedup)
    const [existing] = await db
      .select({ id: files.id })
      .from(files)
      .where(and(
        eq(files.key, pendingRecord.key),
        eq(files.tenantId, tenantId),
        eq(files.status, 'uploaded'),
        isNull(files.deletedAt),
        ne(files.id, fileId),
      ))
      .limit(1);

    if (existing) {
      // Update the existing record — reset size and ingestion for the new S3 version
      await db
        .update(files)
        .set({ size, ingestionStatus: 'pending', updatedAt: new Date() })
        .where(and(eq(files.id, existing.id), eq(files.tenantId, tenantId)));

      // Discard the duplicate pending record created during /upload
      await db
        .update(files)
        .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

      await db.insert(auditLog).values({
        tenantId,
        actorId: userId,
        actorType: 'human',
        action: 'file_uploaded',
        resource: 'file',
        resourceId: existing.id,
        metadata: { size, deduplicated: true },
        traceId: c.get('traceId') ?? '',
      });

      return c.json({ success: true, fileId: existing.id });
    }

    await storageService.confirmUpload(tenantId, fileId, size);

    await db.insert(auditLog).values({
      tenantId,
      actorId: userId,
      actorType: 'human',
      action: 'file_uploaded',
      resource: 'file',
      resourceId: fileId,
      metadata: { size },
      traceId: c.get('traceId') ?? '',
    });

    return c.json({ success: true, fileId });
  }
);

// Get presigned GET URL for relay image fetch — short-lived, image attachments only
filesRoutes.get('/:id/presigned-url', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const fileId = c.req.param('id');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  try {
    const presignedUrl = await storageService.getDownloadUrl(tenantId, fileId);
    return c.json({ presignedUrl });
  } catch {
    return c.json({ error: 'Not Found', message: 'File not found' }, 404);
  }
});

// Get presigned download URL — must be before /:id to avoid route shadowing
filesRoutes.get('/:id/download', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const fileId = c.req.param('id');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  try {
    const downloadUrl = await storageService.getDownloadUrl(tenantId, fileId);
    return c.json({ data: { downloadUrl } });
  } catch {
    return c.json({ error: 'Not Found', message: 'File not found' }, 404);
  }
});

// List files
filesRoutes.get('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  const filesList = await storageService.listFiles(tenantId, limit, offset);

  // Map DB field names to the shape the frontend FileRecord interface expects
  const data = filesList.map((f) => ({
    id: f.id,
    tenantId: f.tenantId,
    key: f.key,
    filename: f.name,
    contentType: f.mimeType ?? '',
    size: f.size ?? 0,
    uploadedBy: f.uploadedBy ?? '',
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    // Ingestion metadata
    formatDetected: f.formatDetected ?? null,
    officeCode: f.officeCode ?? null,
    classification: f.classification ?? classifyDocument(f.name),
    chunkCount: f.chunkCount ?? 0,
    ingestionStatus: f.ingestionStatus ?? 'pending',
    extractedFields: f.extractedFields ?? null,
  }));

  return c.json({ data });
});

// Delete file
filesRoutes.delete('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId');
  const fileId = c.req.param('id');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'delete')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:delete' }, 403);
  }

  await storageService.deleteFile(tenantId, fileId);

  await db.insert(auditLog).values({
    tenantId,
    actorId: userId,
    actorType: 'human',
    action: 'file_deleted',
    resource: 'file',
    resourceId: fileId,
    metadata: {},
    traceId: c.get('traceId') ?? '',
  });

  return c.json({ success: true });
});

// Trigger ingestion processing for an uploaded file
filesRoutes.post('/:id/ingest', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const userId = c.get('userId') as string;
  const fileId = c.req.param('id');
  const force = c.req.query('force') === 'true';

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'create')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
  }

  const [fileRecord] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
    .limit(1);

  if (!fileRecord) return c.json({ error: 'Not Found', message: 'File not found' }, 404);

  if (fileRecord.ingestionStatus === 'done' && !force) {
    return c.json({ error: 'Already ingested. Pass ?force=true to re-ingest.' }, 409);
  }

  // Look up uploader's personalIdentifier for chunk tagging
  const [uploader] = await db
    .select({ personalIdentifier: users.personalIdentifier })
    .from(users)
    .where(eq(users.id, fileRecord.uploadedBy ?? userId))
    .limit(1);
  const personalIdentifier = uploader?.personalIdentifier ?? undefined;

  // Mark as processing
  await db
    .update(files)
    .set({ ingestionStatus: 'processing', updatedAt: new Date() })
    .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

  try {
    const buffer = await storageService.downloadFile(tenantId, fileId);
    const filename = fileRecord.name;
    const mimeType = fileRecord.mimeType ?? '';

    let result: { formatDetected: string; chunkCount: number; extractedFields: any[] | null };

    try {
      // Resolve person folder identifier for RAG scoping
      let personFolderId: string | undefined
      let folderIdentifier: string | undefined
      if (fileRecord.personFolderId) {
        const [pf] = await db
          .select({ id: personFolders.id, identifier: personFolders.identifier })
          .from(personFolders)
          .where(eq(personFolders.id, fileRecord.personFolderId))
          .limit(1)
        if (pf) { personFolderId = pf.id; folderIdentifier = pf.identifier }
      }

      const relayRes = await fetch(`${RELAY_URL}/internal/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId,
          filename,
          mimeType,
          bufferBase64: buffer.toString('base64'),
          tenantId: tenantId ?? 'unknown',
          personalIdentifier: folderIdentifier ?? personalIdentifier,
          personFolderId,
        }),
      });

      if (!relayRes.ok) {
        throw new Error(`Relay returned ${relayRes.status}`);
      }

      const relayData = await relayRes.json() as any;
      if (!relayData.ok) {
        throw new Error(relayData.error ?? 'Workflow failed');
      }

      result = {
        formatDetected: relayData.formatDetected,
        chunkCount: relayData.chunkCount,
        extractedFields: relayData.extractedFields ?? null,
      };
    } catch (err: any) {
      console.error('[ingest] relay workflow failed, falling back to inline ingestion', err);
      // Fallback: existing flat ingestion (kept as safety net for demo)
      const fallback = await ingestFile(filename, mimeType, buffer);
      result = {
        formatDetected: fallback.formatDetected,
        chunkCount: fallback.chunkCount,
        extractedFields: fallback.extractedFields ?? null,
      };
    }

    await db
      .update(files)
      .set({
        formatDetected: result.formatDetected,
        chunkCount: result.chunkCount,
        extractedFields: result.extractedFields as any,
        ingestionStatus: 'done',
        officeCode: requestContext?.tenant?.slug ?? tenantId,
        classification: classifyDocument(filename),
        updatedAt: new Date(),
      })
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

    return c.json({
      data: {
        fileId,
        formatDetected: result.formatDetected,
        chunkCount: result.chunkCount,
        extractedFields: result.extractedFields,
        ingestionStatus: 'done',
      }
    });
  } catch (err: any) {
    await db
      .update(files)
      .set({ ingestionStatus: 'failed', updatedAt: new Date() })
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

    return c.json({ error: 'Ingestion failed', message: err.message }, 500);
  }
});

export { filesRoutes };

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { storageService } from '@serverless-saas/storage';
import { db } from '@serverless-saas/database';
import { auditLog, files } from '@serverless-saas/database/schema';
import { hasPermission } from '@serverless-saas/permissions';
import { eq, and } from 'drizzle-orm';
import { ingestFile } from '../services/ingestion';
import type { AppEnv } from '../types';

const filesRoutes = new Hono<AppEnv>();

// Get presigned upload URL
filesRoutes.post(
  '/upload',
  zValidator('json', z.object({
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(127),
    key: z.string().max(512).optional(), // user-space key e.g. "documents/report.pdf"
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');
    const { filename, contentType, key: userKey } = c.req.valid('json');

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

    return c.json({ success: true });
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
    officeCode: f.officeCode ?? 'PB-001',
    classification: f.classification ?? 'Confidential',
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
  const fileId = c.req.param('id');

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'create')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
  }

  // Mark as processing
  await db
    .update(files)
    .set({ ingestionStatus: 'processing', updatedAt: new Date() })
    .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

  try {
    const [fileRecord] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
      .limit(1);

    if (!fileRecord) return c.json({ error: 'Not Found', message: 'File not found' }, 404);

    const buffer = await storageService.downloadFile(tenantId, fileId);
    const result = await ingestFile(fileRecord.name, fileRecord.mimeType ?? '', buffer);

    await db
      .update(files)
      .set({
        formatDetected: result.formatDetected,
        chunkCount: result.chunkCount,
        extractedFields: result.extractedFields as any,
        ingestionStatus: 'done',
        officeCode: 'PB-001',
        classification: 'Confidential',
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

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { db } from '../db';
import { auditLog } from '@serverless-saas/database/schema';
import { eq, and, desc } from 'drizzle-orm';
import { documents, documentChunks } from '@serverless-saas/agent-schema/documents';
import { hasPermission } from '@serverless-saas/permissions';
import { publishToQueue } from '@serverless-saas/queue';
import type { AppEnv } from '@serverless-saas/types';

const documentsRoutes = new Hono<AppEnv>();
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });

// POST /api/v1/documents/upload-url
documentsRoutes.post(
  '/upload-url',
  zValidator('json', z.object({
    fileName: z.string().min(1).max(255),
    mimeType: z.enum([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      // Archives — browsers report zip under either name depending on platform,
      // so both must be accepted or the picker silently rejects the file.
      'application/zip',
      'application/x-zip-compressed',
    ]),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    if (!tenantId) {
      return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
    }

    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const { fileName, mimeType } = c.req.valid('json');
    const fileKey = `tenants/${tenantId}/documents/${crypto.randomUUID()}-${fileName}`;

    try {
      const command = new PutObjectCommand({
        Bucket: process.env.DOCUMENTS_BUCKET!,
        Key: fileKey,
        ContentType: mimeType,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

      return c.json({ uploadUrl, fileKey });
    } catch (error) {
      console.error('Failed to generate presigned URL:', error);
      return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
  }
);

// POST /api/v1/documents
documentsRoutes.post(
  '/',
  zValidator('json', z.object({
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(127),
    fileKey: z.string().min(1).max(512),
    hash: z.string().length(64),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');
    const { name, mimeType, fileKey, hash } = c.req.valid('json');

    if (!tenantId) {
      return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
    }

    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    // Check for duplicate
    console.log('[documents route] db.query keys:', Object.keys((db as any).query || {}));
    console.log('[documents route] db.query.documents:', typeof (db as any).query?.documents);
    const existing = await db.query.documents.findFirst({
      where: and(
        eq(documents.tenantId, tenantId),
        eq(documents.hash, hash)
      ),
    });

    if (existing) {
      return c.json({ error: 'DUPLICATE_DOCUMENT', documentId: existing.id }, 409);
    }

    const documentId = crypto.randomUUID();

    try {
      const [inserted] = await db.insert(documents).values({
        id: documentId,
        tenantId,
        uploadedBy: userId,
        name,
        mimeType,
        fileKey,
        hash,
        status: 'pending',
      }).returning();

      // Publish SQS message for ingestion
      const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
      if (queueUrl) {
        await publishToQueue(queueUrl, {
          type: "document.ingest",
          payload: {
            tenantId,
            documentId: inserted.id,
            fileKey,
            mimeType,
          }
        });
      } else {
        console.warn('SQS_PROCESSING_QUEUE_URL not set — document.ingest job not published');
      }

      return c.json({ documentId: inserted.id, status: 'pending' }, 201);
    } catch (error) {
      console.error('Failed to create document:', error);
      return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
    }
  }
);

// PATCH /api/v1/documents/:id/classification
documentsRoutes.patch(
  '/:id/classification',
  zValidator('json', z.object({
    sensitivityLevel: z.enum(['public', 'internal', 'confidential', 'restricted']),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');
    const { id } = c.req.param();
    const { sensitivityLevel } = c.req.valid('json');

    const permissions = requestContext?.permissions ?? [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const [updated] = await db.update(documents)
      .set({ sensitivityLevel, updatedAt: new Date() })
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
      .returning({ id: documents.id });

    if (!updated) return c.json({ error: 'Document not found', code: 'NOT_FOUND' }, 404);

    await db.update(documentChunks)
      .set({ sensitivityLevel })
      .where(and(eq(documentChunks.documentId, id), eq(documentChunks.tenantId, tenantId)));

    await db.insert(auditLog).values({
      tenantId, actorId: userId!, actorType: 'human',
      action: 'document_classified', resource: 'document', resourceId: id,
      metadata: { sensitivityLevel }, traceId: c.get('traceId') ?? '',
    });

    return c.json({ id, sensitivityLevel });
  }
);

// GET /api/v1/documents
documentsRoutes.get('/', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;

  if (!tenantId) {
    return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  }

  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const data = await db.query.documents.findMany({
    where: eq(documents.tenantId, tenantId),
    orderBy: [desc(documents.createdAt)],
    columns: {
      id: true,
      name: true,
      status: true,
      chunkCount: true,
      mimeType: true,
      createdAt: true,
    },
  });

  return c.json({ documents: data });
});

// GET /api/v1/documents/:id/download — must be before /:id to avoid route shadowing
documentsRoutes.get('/:id/download', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const { id } = c.req.param();

  if (!tenantId) {
    return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  }

  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const document = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, id),
      eq(documents.tenantId, tenantId)
    ),
  });

  if (!document || !document.fileKey) {
    return c.json({ error: 'Document not found', code: 'NOT_FOUND' }, 404);
  }

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.DOCUMENTS_BUCKET!,
      Key: document.fileKey,
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    return c.json({ downloadUrl });
  } catch (error) {
    console.error('Failed to generate download URL:', error);
    return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/v1/documents/:id
documentsRoutes.get('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const { id } = c.req.param();

  if (!tenantId) {
    return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  }

  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const document = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, id),
      eq(documents.tenantId, tenantId)
    ),
  });

  if (!document) {
    return c.json({ error: 'Document not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json(document);
});

// DELETE /api/v1/documents/:id
documentsRoutes.delete('/:id', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const { id } = c.req.param();

  if (!tenantId) {
    return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  }

  const permissions = requestContext?.permissions ?? [];
  if (!hasPermission(permissions, 'files', 'delete')) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }

  const existing = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, id),
      eq(documents.tenantId, tenantId)
    ),
  });

  if (!existing) {
    return c.json({ error: 'Document not found', code: 'NOT_FOUND' }, 404);
  }

  await db.delete(documents).where(and(
    eq(documents.id, id),
    eq(documents.tenantId, tenantId)
  ));

  return c.body(null, 204);
});

export default documentsRoutes;

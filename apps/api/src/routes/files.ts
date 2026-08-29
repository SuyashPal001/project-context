import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { storageService } from '@serverless-saas/storage';
import { db } from '@serverless-saas/database';
import { auditLog, files } from '@serverless-saas/database/schema';
import { features } from '@serverless-saas/database/schema/entitlements';
import { decideUpload, resolveStorageLimit } from './files.quota';
import { sumTenantStorageBytes } from '../usage-counters';
import { hasPermission } from '@serverless-saas/permissions';
import { eq, and, ne, isNull } from 'drizzle-orm';
import { publishToQueue } from '@serverless-saas/queue';
import { runFileIngestion } from '@serverless-saas/agent-worker-handlers';
import type { AppEnv } from '../types';

// Fallback display classification for files ingested before `classification`
// was backfilled on the row. The actual ingest-time classification (used to
// tag chunks) lives in runFileIngestion (agent-worker-handlers) — duplicated
// here rather than exported cross-package for one small pure heuristic.
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

// Server-side mirror of apps/web/components/platform/files/fileCategory.ts —
// only documents go through ingestion. Keep in sync with that file if the
// category rules change; duplicated rather than shared across a web/API
// package boundary for one small pure function.
function isIngestibleDocument(contentType: string, filename: string): boolean {
  const ct = contentType.toLowerCase();
  const name = filename.toLowerCase();
  return (
    ct === 'application/pdf' || name.endsWith('.pdf') ||
    ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx') ||
    ct === 'text/plain' || name.endsWith('.txt') ||
    ct === 'text/csv' || name.endsWith('.csv')
  );
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
    // Optional for now: every caller must be shipped sending it before this can
    // be required, or agent file generation breaks between the Lambda deploy and
    // the orchestrator restart. See the plan's deployment order.
    size: z.number().int().positive().optional(),
  })),
  async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId');
    const { filename, contentType, key: userKey, personFolderId, size } = c.req.valid('json');

    if (!userId) {
      return c.json({ error: 'Forbidden', message: 'Missing userId' }, 403);
    }

    const permissions = requestContext?.permissions || [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
    }

    // Enforce before signing. A gate after the signature still hands out a
    // working upload URL, and the bytes land regardless of what we return.
    if (size !== undefined) {
      const [feature] = await db.select().from(features).where(eq(features.key, 'storage_gb')).limit(1);
      if (!feature) {
        return c.json({ error: 'Feature configuration missing', code: 'FEATURE_NOT_FOUND' }, 500);
      }

      const limit = resolveStorageLimit(requestContext?.entitlements, feature.id);
      // Skipping the sum for unlimited tenants is safe: decideUpload returns
      // early on the flag and never reads usedBytes. This is not the metering
      // the deferred pay-as-you-go billing needs — that comes from periodic
      // snapshots reading the same counter, not from the upload path.
      const usedBytes = limit.unlimited ? 0 : await sumTenantStorageBytes(tenantId);
      const decision = decideUpload({ size, usedBytes, limit });

      if (!decision.allowed) {
        // The numbers go in the payload, not the UI: this rejection is the only
        // place in the product where a storage limit is ever named.
        return c.json(
          decision.code === 'file_too_large'
            ? { error: 'File is too large', code: decision.code, maxBytes: decision.maxBytes, size: decision.size }
            : {
                error: 'Not enough storage remaining',
                code: decision.code,
                usedBytes: decision.usedBytes,
                limitBytes: decision.limitBytes,
                size: decision.size,
              },
          413,
        );
      }
    }

    const result = await storageService.getUploadUrl({
      tenantId,
      filename,
      contentType,
      uploadedBy: userId,
      userKey,
      size,
    });

    // Link to person folder if provided
    if (personFolderId) {
      await db.update(files).set({ personFolderId, updatedAt: new Date() }).where(eq(files.id, result.fileId));
    }

    await db.insert(auditLog).values({
      tenantId,
      actorId: userId!,
      actorType: 'human',
      action: 'file_upload_requested',
      resource: 'file',
      resourceId: result.fileId,
      metadata: { filename, contentType },
      traceId: c.get('traceId') ?? '',
      ipAddress: c.get('clientIp'),
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

    if (!tenantId || !userId) return c.json({ error: 'User or tenant not found', code: 'UNAUTHORIZED' }, 401);

    const permissions = requestContext?.permissions || [];
    if (!hasPermission(permissions, 'files', 'create')) {
      return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
    }

    // Fetch the pending record to get its S3 key
    const [pendingRecord] = await db
      .select({ key: files.key, name: files.name, mimeType: files.mimeType })
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
      .limit(1);

    if (!pendingRecord) {
      return c.json({ error: 'Not Found', message: 'File record not found' }, 404);
    }

    const eligibleForAutoIngest = isIngestibleDocument(pendingRecord.mimeType ?? '', pendingRecord.name);
    const enqueueAutoIngest = async (idToIngest: string) => {
      const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
      if (!queueUrl) {
        console.warn('[files/confirm] SQS_PROCESSING_QUEUE_URL not set — file.ingest job not published');
        return;
      }
      await publishToQueue(queueUrl, { type: 'file.ingest', payload: { tenantId, fileId: idToIngest } });
    };

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
        ipAddress: c.get('clientIp'),
      });

      if (eligibleForAutoIngest) await enqueueAutoIngest(existing.id);

      return c.json({ success: true, fileId: existing.id });
    }

    await storageService.confirmUpload(tenantId, fileId, size);

    if (eligibleForAutoIngest) await enqueueAutoIngest(fileId);

    await db.insert(auditLog).values({
      tenantId,
      actorId: userId!,
      actorType: 'human',
      action: 'file_uploaded',
      resource: 'file',
      resourceId: fileId,
      metadata: { size },
      traceId: c.get('traceId') ?? '',
      ipAddress: c.get('clientIp'),
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
  const prefix = c.req.query('prefix') || undefined;

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'read')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:read' }, 403);
  }

  const filesList = await storageService.listFiles(tenantId, limit, offset, prefix);

  // Agent avatars go through this same upload endpoint (saveAvatarAsset.ts) but are
  // UI plumbing, not user content — filename is always `{agentName}_avatar.svg`
  // (see generateDefaultAvatar.ts). Excluded here so they never show in Drive and
  // never sit stuck at "Pending" in the ingest pipeline, which doesn't apply to them.
  const visibleFiles = filesList.filter(
    (f) => !(f.mimeType === 'image/svg+xml' && f.name.endsWith('_avatar.svg'))
  );

  // Map DB field names to the shape the frontend FileRecord interface expects
  const data = visibleFiles.map((f) => ({
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
    workspaceName: f.workspaceName ?? null,
    classification: f.classification ?? classifyDocument(f.name),
    chunkCount: f.chunkCount ?? 0,
    ingestionStatus: f.ingestionStatus ?? 'pending',
    extractedFields: f.extractedFields ?? null,
    personFolderId: f.personFolderId ?? null,
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
    actorId: userId!,
    actorType: 'human',
    action: 'file_deleted',
    resource: 'file',
    resourceId: fileId,
    metadata: {},
    traceId: c.get('traceId') ?? '',
    ipAddress: c.get('clientIp'),
  });

  return c.json({ success: true });
});

// Trigger ingestion processing for an uploaded file — manual re-trigger from
// the Drive UI. Shares its implementation (runFileIngestion) with the
// automatic file.ingest worker job fired from POST /:id/confirm below, so
// the two trigger paths can never drift out of sync with each other.
filesRoutes.post('/:id/ingest', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;
  const fileId = c.req.param('id');
  const force = c.req.query('force') === 'true';

  const permissions = requestContext?.permissions || [];
  if (!hasPermission(permissions, 'files', 'create')) {
    return c.json({ error: 'Forbidden', message: 'Missing permission: files:create' }, 403);
  }

  try {
    const outcome = await runFileIngestion({ tenantId, fileId, force });
    switch (outcome) {
      case 'not_found':
        return c.json({ error: 'Not Found', message: 'File not found' }, 404);
      case 'already_done':
        return c.json({ error: 'Already ingested. Pass ?force=true to re-ingest.' }, 409);
      case 'already_processing':
        return c.json({ error: 'Ingestion already in progress for this file' }, 409);
      case 'started':
        return c.json({ data: { fileId, ingestionStatus: 'processing' } }, 202);
    }
  } catch (err: any) {
    console.error('[ingest] runFileIngestion failed', err);
    return c.json({ error: 'Ingestion failed', message: err.message }, 500);
  }
});

export { filesRoutes };

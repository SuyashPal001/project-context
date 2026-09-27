import { storageService } from '@serverless-saas/storage';
import { publishToQueue } from '@serverless-saas/queue';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { db } from '../db';
import { listProductImageFileIds } from './productRecords';

/**
 * Deleting a product deletes its photos too — the user expects "delete" to
 * mean gone from Drive and the # picker. Each photo goes through the same
 * steps as a Drive file delete (apps/api/src/routes/files.ts): soft-delete the
 * row, queue the S3 purge, audit. A photo another product still uses is kept.
 * Call only after the product row itself is deleted.
 */
export async function deleteUnusedProductFiles(input: {
  tenantId: string; fileIds: string[]; actorId: string | null; traceId: string; ipAddress?: string;
}): Promise<void> {
  const unique = [...new Set(input.fileIds)];
  if (unique.length === 0) return;
  const stillUsed = new Set(await listProductImageFileIds(input.tenantId));
  const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;

  // Best effort per photo: one failure must not leave the rest behind.
  for (const fileId of unique) {
    if (stillUsed.has(fileId)) continue;
    try {
      const deletedKey = await storageService.deleteFile(input.tenantId, fileId);
      // Null means nothing was deleted (not this tenant's file, or already gone).
      if (!deletedKey) continue;
      if (queueUrl) {
        await publishToQueue(queueUrl, { type: 'storage.purge', payload: { tenantId: input.tenantId, key: deletedKey } });
      } else {
        console.error('[productFileCleanup] SQS_PROCESSING_QUEUE_URL unset — object not purged', { tenantId: input.tenantId, key: deletedKey });
      }
      await db.insert(auditLog).values({
        tenantId: input.tenantId,
        actorId: input.actorId ?? 'system',
        actorType: input.actorId ? 'human' : 'system',
        action: 'file_deleted',
        resource: 'file',
        resourceId: fileId,
        metadata: { reason: 'product_deleted' },
        traceId: input.traceId,
        ipAddress: input.ipAddress,
      });
    } catch (error) {
      console.error('[productFileCleanup] deleting product photo failed', { tenantId: input.tenantId, fileId, error: (error as Error).message });
    }
  }
}

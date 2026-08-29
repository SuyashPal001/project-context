import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { files } from '@serverless-saas/database/schema';
import { publishToQueue } from '@serverless-saas/queue';
import { abandonedBefore } from './files.quota';

/**
 * Expires this tenant's abandoned uploads and queues their bytes for purge.
 *
 * A presign inserts a `pending` row and returns a URL; the client PUTs to S3
 * and calls confirm. When confirm never fires, the bytes sit in S3 with no
 * recorded size — invisible to any sum over `uploaded` rows, forever.
 *
 * Deliberately opportunistic rather than scheduled: the work is scoped to one
 * tenant and bounded by their abandoned uploads in the last hour, so it needs
 * no EventBridge rule of its own. A tenant who never uploads again is never
 * swept, which the one-time backfill script covers instead.
 *
 * Only rows older than the presign expiry are touched. Sweeping anything
 * younger would expire an upload still legitimately in flight, and the client
 * would get a 403 from S3 on a URL just issued to it.
 */
export async function reclaimAbandonedUploads(tenantId: string): Promise<number> {
  const rows = await db
    .update(files)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(
      eq(files.tenantId, tenantId),
      eq(files.status, 'pending'),
      isNull(files.deletedAt),
      lt(files.createdAt, abandonedBefore(new Date())),
    ))
    .returning({ key: files.key });

  if (rows.length === 0) return 0;

  const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
  if (!queueUrl) {
    console.error('SQS_PROCESSING_QUEUE_URL unset — abandoned uploads expired but not purged', {
      tenantId, count: rows.length,
    });
    return rows.length;
  }

  for (const row of rows) {
    await publishToQueue(queueUrl, {
      type: 'storage.purge',
      payload: { tenantId, key: row.key },
    });
  }

  return rows.length;
}

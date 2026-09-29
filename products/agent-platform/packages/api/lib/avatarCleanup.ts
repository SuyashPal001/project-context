import { and, eq, isNotNull } from 'drizzle-orm';
import { storageService } from '@serverless-saas/storage';
import { publishToQueue } from '@serverless-saas/queue';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { files } from '@serverless-saas/database/schema/storage';
import { creativeLibraryAssets } from '@serverless-saas/agent-schema/creativeLibraryAssets';
import { db } from '../db';

// Deliberately self-contained (its own db queries, no import from
// avatarRecords.ts): avatarRecords.ts calls cleanupOrphanedAvatars at the
// start of listTenantAvatars, and importing avatarRecords back here would
// create a circular import.

/**
 * A tenant avatar whose portrait file was deleted elsewhere (Drive delete,
 * etc.) is orphaned: the picker can no longer show it, but its row — and any
 * reference sheet it pinned — would otherwise sit around forever. This finds
 * those rows and retires them.
 *
 * For each orphaned row: claim it first (UPDATE ... WHERE status='active'
 * RETURNING id) so two concurrent cleanup runs (e.g. two listTenantAvatars
 * calls racing) can't both act on the same row — only the run whose UPDATE
 * actually flips a row proceeds. Only then, if it pinned a reference sheet,
 * delete that sheet the same way lib/productFileCleanup.ts deletes a product
 * photo (storageService.deleteFile → queue storage.purge → audit as
 * 'system'). Best effort per row: one failure must not stop the rest. Never
 * throws — called at the start of listTenantAvatars with no try/catch around
 * the call. Capped at 50 orphans per call — a bound on this side query, not a
 * bound on the picker's own MAX_TENANT_AVATARS limit.
 */
export async function cleanupOrphanedAvatars(tenantId: string): Promise<void> {
  try {
    const orphans = await db
      .select({ id: creativeLibraryAssets.id, attributes: creativeLibraryAssets.attributes })
      .from(creativeLibraryAssets)
      .innerJoin(files, eq(files.id, creativeLibraryAssets.fileId))
      .where(and(
        eq(creativeLibraryAssets.tenantId, tenantId),
        eq(creativeLibraryAssets.kind, 'avatar'),
        eq(creativeLibraryAssets.status, 'active'),
        isNotNull(creativeLibraryAssets.fileId),
        isNotNull(files.deletedAt),
      ))
      .limit(50);

    const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;

    for (const orphan of orphans) {
      try {
        const claimed = await db.update(creativeLibraryAssets)
          .set({ status: 'deleted' })
          .where(and(
            eq(creativeLibraryAssets.tenantId, tenantId),
            eq(creativeLibraryAssets.id, orphan.id),
            eq(creativeLibraryAssets.status, 'active'),
          ))
          .returning({ id: creativeLibraryAssets.id });
        if (claimed.length === 0) continue; // another run already claimed this row

        const attrs = (orphan.attributes ?? {}) as { referenceSheetFileId?: string };
        if (attrs.referenceSheetFileId) {
          const deletedKey = await storageService.deleteFile(tenantId, attrs.referenceSheetFileId);
          if (deletedKey) {
            if (queueUrl) {
              await publishToQueue(queueUrl, { type: 'storage.purge', payload: { tenantId, key: deletedKey } });
            } else {
              console.error('[avatarCleanup] SQS_PROCESSING_QUEUE_URL unset — object not purged', { tenantId, key: deletedKey });
            }
            await db.insert(auditLog).values({
              tenantId,
              actorId: 'system',
              actorType: 'system',
              action: 'file_deleted',
              resource: 'file',
              resourceId: attrs.referenceSheetFileId,
              metadata: { reason: 'avatar_orphaned' },
              traceId: `avatar-cleanup:${orphan.id}`,
            });
          }
        }
      } catch (error) {
        console.error('[avatarCleanup] cleaning up an orphaned avatar failed', { tenantId, id: orphan.id, error: (error as Error).message });
      }
    }
  } catch (error) {
    console.error('[avatarCleanup] listing orphaned avatars failed', { tenantId, error: (error as Error).message });
  }
}

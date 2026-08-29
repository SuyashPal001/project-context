import { storageService } from '@serverless-saas/storage';

interface PurgePayload {
  tenantId: string;
  key: string;
}

/**
 * Removes an S3 object whose database row has already been soft-deleted or
 * expired.
 *
 * Soft deletion keeps the row for audit and ingestion lineage; this job is what
 * stops the bytes being billed forever. Without it a tenant could fill their
 * quota, delete, and repeat indefinitely — the quota counts `uploaded` rows
 * while the bill counts objects.
 */
export async function handleStoragePurge(body: Record<string, unknown>): Promise<void> {
  const payload = body.payload as PurgePayload | undefined;

  if (!payload?.tenantId || !payload?.key) {
    console.log('Storage purge job had no tenantId/key — nothing to do');
    return;
  }

  try {
    await storageService.deleteObjectForTenant(payload.tenantId, payload.key);
    console.log('Storage object purged', { tenantId: payload.tenantId, key: payload.key });
  } catch (error) {
    // Idempotence, not blanket suppression: SQS redelivers, and an object that
    // is already gone is the expected steady state on a retry. Anything else —
    // access denied, a network failure — must still fail so SQS retries it,
    // otherwise the object it was meant to delete leaks silently.
    if ((error as { name?: string })?.name === 'NoSuchKey') {
      console.log('Storage object already absent', { tenantId: payload.tenantId, key: payload.key });
      return;
    }
    throw error;
  }
}

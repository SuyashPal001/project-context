/**
 * One-time reclamation of S3 objects the old delete path left behind.
 *
 * Two populations, both invisible to any sum over `uploaded` rows and both
 * billing indefinitely:
 *   - soft-deleted files, whose S3 objects were never removed because
 *     deleteFile only ever set status and deletedAt
 *   - `pending` rows older than the presign expiry, whose uploads never
 *     confirmed and whose bytes therefore have no recorded size
 *
 * Dry by default. This enqueues irreversible deletions, so --execute is
 * required and the counts should be inspected first.
 *
 * Usage:
 *   DATABASE_URL=... SQS_PROCESSING_QUEUE_URL=... npx tsx scripts/backfill-storage-purge.ts
 *   DATABASE_URL=... SQS_PROCESSING_QUEUE_URL=... npx tsx scripts/backfill-storage-purge.ts --execute
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@serverless-saas/database/schema';
import { files } from '@serverless-saas/database/schema/storage';
import { and, eq, lt } from 'drizzle-orm';
import { publishToQueue } from '@serverless-saas/queue';

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client, { schema });

const execute = process.argv.includes('--execute');

/** Matches PRESIGN_EXPIRY_MS in apps/api/src/routes/files.quota.ts. */
const PRESIGN_EXPIRY_MS = 3600 * 1000;

async function main() {
  const cutoff = new Date(Date.now() - PRESIGN_EXPIRY_MS);

  const deleted = await db
    .select({ id: files.id, tenantId: files.tenantId, key: files.key })
    .from(files)
    .where(eq(files.status, 'deleted'));

  const abandoned = await db
    .select({ id: files.id, tenantId: files.tenantId, key: files.key })
    .from(files)
    .where(and(eq(files.status, 'pending'), lt(files.createdAt, cutoff)));

  console.log(`soft-deleted rows whose objects were never purged: ${deleted.length}`);
  console.log(`abandoned pending uploads older than 1h:           ${abandoned.length}`);
  console.log(`total purge jobs this would enqueue:               ${deleted.length + abandoned.length}`);

  if (!execute) {
    console.log('\nDry run — nothing enqueued. Inspect the counts above, then re-run with --execute.');
    return;
  }

  const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
  if (!queueUrl) throw new Error('SQS_PROCESSING_QUEUE_URL is unset — refusing to run');

  let enqueued = 0;
  for (const row of [...deleted, ...abandoned]) {
    await publishToQueue(queueUrl, {
      type: 'storage.purge',
      payload: { tenantId: row.tenantId, key: row.key },
    });
    enqueued++;
  }

  // Only after the purges are enqueued: a crash between the two leaves rows
  // still marked pending, which the next run picks up again. Marking first
  // would lose them.
  if (abandoned.length > 0) {
    await db
      .update(files)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(files.status, 'pending'), lt(files.createdAt, cutoff)));
  }

  console.log(`\nDone — enqueued ${enqueued} purge jobs, marked ${abandoned.length} rows expired`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => client.end());

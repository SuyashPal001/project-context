import { and, eq, sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { files } from '@serverless-saas/database/schema';
import { registerUsageCounter } from '@serverless-saas/entitlements';

/**
 * Bytes a tenant currently occupies.
 *
 * Only `uploaded` rows count. `pending` rows have no size yet, and `deleted`
 * and `expired` rows are already queued for purge from S3 — counting either
 * would charge a tenant for bytes they cannot free.
 *
 * sum() over an integer column is bigint, which postgres.js returns as a
 * string. Parse it here so no caller has to remember.
 */
export async function sumTenantStorageBytes(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${files.size}), 0)` })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), eq(files.status, 'uploaded')));

  return Number(row?.total ?? 0);
}

let countersRegistered = false;

/**
 * Foundation-owned usage counters. Mirrors registerCounters() in the agent
 * platform's api package, including the idempotence guard.
 *
 * storage_gb is registered for every tenant, including those on unlimited
 * plans: enterprise storage is billed by consumption, and a tenant that is
 * never metered cannot later be billed for history that was never recorded.
 */
export function registerFoundationCounters(): void {
  if (countersRegistered) return;
  countersRegistered = true;

  registerUsageCounter('storage_gb', sumTenantStorageBytes);
}

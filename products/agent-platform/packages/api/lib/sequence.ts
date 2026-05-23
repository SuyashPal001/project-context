import { db } from '@serverless-saas/database';
import { tenantCounters } from '@serverless-saas/agent-schema/pm';
import { sql } from 'drizzle-orm';

/**
 * Atomically increments and returns the next sequence ID for a given
 * (tenantId, resource) pair. Uses INSERT ... ON CONFLICT DO UPDATE so the
 * operation is a single round-trip with no separate lock or transaction needed.
 *
 * resource values: 'plan' | 'milestone' | 'task'
 */
export async function nextSequenceId(tenantId: string, resource: string): Promise<number> {
    const [row] = await db
        .insert(tenantCounters)
        .values({ tenantId, resource, lastSeq: 1 })
        .onConflictDoUpdate({
            target: [tenantCounters.tenantId, tenantCounters.resource],
            set: { lastSeq: sql`${tenantCounters.lastSeq} + 1` },
        })
        .returning({ lastSeq: tenantCounters.lastSeq });

    return row.lastSeq;
}

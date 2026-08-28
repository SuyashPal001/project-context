import { and, count, eq } from 'drizzle-orm';
import { creditLedger } from '@serverless-saas/database/schema/credits';
// Type-only: this module must NOT import the real '../db' singleton at
// runtime. Both call sites (taskWorker.execution.ts via
// './taskWorker.utils', tasks.approval.ts via '../db') already have their
// own testable `db` seam — a required parameter here reuses whichever one
// the caller (and its tests) already mock, instead of pulling in a second,
// unmocked path to the same singleton.
import type { db as RealDb } from '../db';

export type CreditAttemptDb = Pick<typeof RealDb, 'select'>;

/**
 * Number of refunds already recorded for this task, tenant-scoped. THIS is
 * the attempt number taskChargeKey() (apps/agent-orchestrator/src/credits.ts)
 * needs — refundTask fires on every early termination that invalidates a
 * charge key (a clarify-and-resume pause via onTaskComment, onStepFail, or
 * the workflow's own non-success branch), not only the clarification-shaped
 * one. Counting `clarification_requested` events (the previous derivation)
 * missed the other two, reachable paths — see the retry-billing fix report
 * for the full defect writeup. `credit_ledger` is the authority on what was
 * actually charged and returned, so deriving from it subsumes every cause of
 * a refund rather than enumerating them.
 *
 * Scoped by tenant_id AND job_id (not job_id alone) — the idempotency
 * namespace, and therefore the ledger itself, is per-tenant (migration
 * 0071); an unscoped lookup would let one tenant's refund count leak into
 * another's attempt derivation if task IDs ever collided across tenants.
 */
export async function countTaskRefunds(
    db: CreditAttemptDb,
    tenantId: string,
    taskId: string,
): Promise<number> {
    const rows = await db.select({ value: count() }).from(creditLedger)
        .where(and(
            eq(creditLedger.tenantId, tenantId),
            eq(creditLedger.jobId, taskId),
            eq(creditLedger.kind, 'refund'),
        ));
    return Number(rows[0]?.value ?? 0);
}

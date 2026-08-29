import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { InsufficientCreditsError } from './errors';

export interface SpendInput {
  tenantId: string;
  amountMicro: bigint;              // negative debits, positive credits
  key: string;
  kind: 'debit' | 'refund' | 'settle' | 'grant' | 'adjust';
  actorId?: string | null;
  actorType?: 'human' | 'agent' | null;
  rateId?: string | null;
  rateVersion?: number | null;
  jobId?: string | null;
  jobType?: string | null;
  grantType?: string | null;
  expiresAt?: Date | null;
  reason?: string | null;
}

// drizzle's postgres-js driver returns a bare array-like RowList from
// db.execute() on some code paths and a { rows } wrapper on others (see
// packages/foundation/ai/src/cache.ts and apps/agent-orchestrator's
// folderScope.ts, which both do this same dance) - normalize instead of
// assuming either shape.
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

/**
 * Single typed call into spend_credits(). One statement is one implicit
 * transaction - required over the Supabase transaction pooler (6543), where a
 * client-side BEGIN/COMMIT could span two different backends. Never wrap this
 * call in a transaction.
 *
 * Migration 0072: spend_credits() no longer raises SQLSTATE P0001 for a plain
 * shortfall. It used to, but that raise aborted the whole statement -
 * including the lazy expiry sweep the same call had just performed under the
 * account lock, so a spend that failed discarded the very expiry it found
 * (invariant 3 violation). The function now reports a shortfall through two
 * OUT columns (`insufficient`, `short_by`) instead, which lets the call
 * complete normally - and the sweep's write, already committed earlier in
 * the same function body, survives. This function still throws
 * InsufficientCreditsError to preserve the exact contract every existing
 * caller relies on; the difference is entirely internal to this file. A
 * genuine unexpected database error still propagates as a thrown error and
 * still rolls back the whole call, unchanged.
 */
export async function spendCredits(i: SpendInput): Promise<bigint> {
  const result = await db.execute(sql`
    select * from spend_credits(
      ${i.tenantId}::uuid, ${i.amountMicro.toString()}::bigint, ${i.key}, ${i.kind},
      ${i.actorId ?? null}::uuid, ${i.actorType ?? null}::actor_type,
      ${i.rateId ?? null}::uuid, ${i.rateVersion ?? null}::integer,
      ${i.jobId ?? null}::uuid, ${i.jobType ?? null},
      ${i.grantType ?? null}, ${i.expiresAt?.toISOString() ?? null}::timestamptz, ${i.reason ?? null}
    )
  `);
  const [row] = rowsOf(result);
  if (row.insufficient) {
    throw new InsufficientCreditsError();
  }
  return BigInt(row.new_balance as string | number | bigint);
}

export interface GrantInput {
  tenantId: string;
  amountMicro: bigint;              // positive
  key: string;
  grantType: 'purchase' | 'subscription' | 'trial' | 'admin' | 'refund';
  expiresAt?: Date | null;
  actorId?: string | null;
  actorType?: 'human' | 'agent' | null;
  reason?: string | null;
}

export const grantCredits = (i: GrantInput): Promise<bigint> =>
  spendCredits({ ...i, kind: 'grant', grantType: i.grantType });

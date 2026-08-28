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
 */
export async function spendCredits(i: SpendInput): Promise<bigint> {
  try {
    const result = await db.execute(sql`
      select spend_credits(
        ${i.tenantId}::uuid, ${i.amountMicro.toString()}::bigint, ${i.key}, ${i.kind},
        ${i.actorId ?? null}::uuid, ${i.actorType ?? null}::actor_type,
        ${i.rateId ?? null}::uuid, ${i.rateVersion ?? null}::integer,
        ${i.jobId ?? null}::uuid, ${i.jobType ?? null},
        ${i.grantType ?? null}, ${i.expiresAt ?? null}::timestamptz, ${i.reason ?? null}
      ) as balance
    `);
    const [row] = rowsOf(result);
    return BigInt(row.balance as string | number | bigint);
  } catch (err) {
    // drizzle-orm's postgres-js driver wraps every query failure in a
    // DrizzleQueryError ("Failed query: ...") and puts the real postgres.js
    // PostgresError - the one carrying .code/.message from `raise exception`
    // - on .cause. Check both so this doesn't silently stop matching if a
    // future drizzle-orm version ever throws the raw error unwrapped.
    const raised = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const pgErr = raised.cause ?? raised;
    if (pgErr.code === 'P0001' || String(pgErr.message).includes('INSUFFICIENT_CREDITS')) {
      throw new InsufficientCreditsError();
    }
    throw err;
  }
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

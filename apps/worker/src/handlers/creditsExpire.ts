import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { spendCredits } from '@serverless-saas/credits';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // yyyy-mm-dd
}

/**
 * Expiry is already lazy inside spend_credits() (migration 0070/0071): every
 * call takes `for update` on the tenant's ACCOUNT row first, unconditionally,
 * before anything else runs - including before the lazy-expiry loop takes its
 * own `for update` on that tenant's `credit_grants` rows. That account-row
 * lock is what actually serializes two callers spending for the same tenant;
 * by the time the expiry loop's `for update` is taken, this call already has
 * the only lock that matters for that tenant.
 *
 * So the grant-row `for update` inside the expiry loop is not what prevents a
 * double-deduct between two *normal* spend_credits() callers - the account
 * lock already does that. What it actually guards against is a SECOND,
 * DIFFERENT code path that reads and mutates `credit_grants` for a tenant
 * WITHOUT going through spend_credits() first (and therefore without ever
 * taking the account lock). This handler is deliberately not that path: its
 * only query against the database is the read-only `select distinct
 * tenant_id` below, and the actual mutation is delegated entirely to
 * spend_credits() via a zero-amount call - p_amount_micro = 0 skips the debit
 * and credit branches, but the lazy-expiry loop above them is unconditional,
 * so it still runs under the account lock and still writes the
 * `expiry:{grantId}` ledger rows, with no separate code path to keep in sync.
 *
 * The invariant to protect, if this file is ever "optimized": do not add a
 * query here (or anywhere else) that reads `credit_grants` with intent to
 * mutate it directly. The moment one exists outside spend_credits(), it can
 * race the lazy sweep inside spend_credits() and collide on the
 * `expiry:{grantId}` idempotency key - aborting a legitimate concurrent
 * spend with a unique-constraint error instead of a clean replay.
 */
export async function handleCreditsExpire(_body: Record<string, unknown>): Promise<void> {
  // Read-only candidate list — no lock needed here. Worst case this is
  // slightly stale (a grant expires between this select and the
  // spend_credits() call below, or was already swept by a concurrent lazy
  // expiry); either way the zero-amount call for that tenant is a safe no-op,
  // since the authoritative filter lives inside spend_credits() itself.
  const result = await db.execute(sql`
    select distinct tenant_id
      from credit_grants
     where expires_at is not null
       and expires_at <= now()
       and spent_micro < amount_micro
  `);
  const tenantIds = rowsOf(result).map((row) => row.tenant_id as string);
  const today = todayUtc();

  console.log('[credits.expire] sweep starting', { candidates: tenantIds.length });

  let completed = 0;
  for (const tenantId of tenantIds) {
    try {
      // `expiry-sweep:{tenantId}:{date}` is a tracing label on the
      // spend_credits() call, not a replay guard: with p_amount_micro = 0
      // neither the debit nor credit branch runs, so no ledger row is EVER
      // written under this key - the replay check on p_key can never match
      // it on a second run. What actually makes a repeat run a no-op is the
      // outer candidate query above and, underneath it, spend_credits()'s
      // own `spent_micro < amount_micro` filter on the expiry loop: once a
      // grant is fully spent it drops out of both.
      await spendCredits({
        tenantId,
        amountMicro: 0n,
        key: `expiry-sweep:${tenantId}:${today}`,
        kind: 'adjust',
        reason: 'nightly expiry sweep',
      });
      completed += 1;
    } catch (err) {
      // Never let one tenant's sweep failure block the rest of the batch.
      console.error('[credits.expire] sweep failed for tenant', tenantId, err);
    }
  }

  // A 120s Lambda running this loop sequentially, one tenant at a time, has
  // no other progress signal - if the candidate count ever outgrows what fits
  // in the timeout, the tail of the batch is silently dropped until the next
  // nightly run. Logging both counts makes that visible instead of silent.
  console.log('[credits.expire] sweep finished', { candidates: tenantIds.length, completed });
}

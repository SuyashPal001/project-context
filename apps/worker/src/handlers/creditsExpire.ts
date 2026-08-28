import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { spendCredits } from '@serverless-saas/credits';

// Expiry is already lazy inside spend_credits() (migration 0070/0071): every
// call takes `for update` on the account row, then sweeps any of that
// tenant's grants with `expires_at <= now() and spent_micro < amount_micro`
// under the SAME lock before doing anything else. That loop is what keeps
// balance_micro honest and what guards against a double-deduct — it is not
// reimplemented here.
//
// This sweep exists only for tenants that never spend, so their reported
// balance doesn't sit high forever. It works by finding tenants with an
// expired, unspent grant, then making a **zero-amount** spend_credits() call
// for each: p_amount_micro = 0 skips both the debit and credit branches, but
// the lazy-expiry loop above them is unconditional, so it still runs, still
// takes the same `for update` lock, and still writes the `expiry:{grantId}`
// ledger rows. There is deliberately no separate query here that re-does the
// locking or the `spent_micro < amount_micro` filter — a second code path
// doing that same job could race the lazy sweep inside spend_credits() and
// collide on the `expiry:{grantId}` idempotency key, aborting a legitimate
// concurrent spend.
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // yyyy-mm-dd
}

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

  for (const tenantId of tenantIds) {
    try {
      await spendCredits({
        tenantId,
        amountMicro: 0n,
        key: `expiry-sweep:${tenantId}:${today}`,
        kind: 'adjust',
        reason: 'nightly expiry sweep',
      });
    } catch (err) {
      // Never let one tenant's sweep failure block the rest of the batch.
      console.error('[credits.expire] sweep failed for tenant', tenantId, err);
    }
  }
}

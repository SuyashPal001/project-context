import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { grantCredits, spendCredits } from '../index';
import { InsufficientCreditsError } from '../errors';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Own tenant UUID, distinct from every other file that shares this test
// database: read.integration.test.ts and spend.integration.test.ts use
// ...a1/...a2 in this same directory; unlimited.integration.test.ts (also
// here) uses ...a3/...a4/...a5; apps/api's onboarding.credits.test.ts uses
// ...b1/...b2/...b9; apps/worker's creditsExpire.test.ts uses ...c1/...c2.
const TENANT = '00000000-0000-0000-0000-0000000000a6';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

async function seedTenant(tenantId: string) {
  await db.execute(sql`
    insert into tenants (id, name, slug) values (${tenantId}, 'expiry replay test', ${'expiry-replay-' + tenantId.slice(-4)})
    on conflict (id) do nothing
  `);
}

async function grantExpiringYesterday(tenantId: string, amountMicro: bigint) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await grantCredits({
    tenantId, amountMicro, key: `test-grant:${tenantId}:${Date.now()}:${Math.random()}`,
    grantType: 'subscription', expiresAt: yesterday,
  });
}

async function ledgerRows(tenantId: string, keyPrefix: string) {
  const result = await db.execute(sql`
    select * from credit_ledger where tenant_id = ${tenantId} and idempotency_key like ${keyPrefix + '%'}
  `);
  return rowsOf(result);
}

// Moved here (unchanged) from apps/worker/src/handlers/__tests__/creditsExpire.test.ts
// per code review: this test exercises spend_credits()'s own lazy-expiry
// replay safety directly - it never calls handleCreditsExpire() - so it
// belongs beside the rest of that function's coverage, where someone editing
// migration 0071 would actually run it.
describe.skipIf(!TEST_DB)('spend_credits() lazy expiry replay safety', () => {
  beforeEach(async () => {
    await db.execute(sql`delete from credit_ledger where tenant_id = ${TENANT}`);
    await db.execute(sql`delete from credit_grants where tenant_id = ${TENANT}`);
    await db.execute(sql`delete from credit_accounts where tenant_id = ${TENANT}`);
    await seedTenant(TENANT);
  });

  afterAll(async () => {
    await db.execute(sql`delete from credit_ledger where tenant_id = ${TENANT}`);
    await db.execute(sql`delete from credit_grants where tenant_id = ${TENANT}`);
    await db.execute(sql`delete from credit_accounts where tenant_id = ${TENANT}`);
    await db.execute(sql`delete from tenants where id = ${TENANT}`);
  });

  // The worker's own handleCreditsExpire() candidate query already filters
  // out grants where spent_micro = amount_micro, so calling it twice in a row
  // never re-invokes spend_credits() for an already-expired grant - that path
  // can't observe a regression in spend_credits()'s own guard. Call
  // spend_credits() directly, twice, with two DIFFERENT idempotency keys (so
  // the outer per-call replay check on p_key doesn't short-circuit the second
  // call either) to force its internal lazy-expiry loop to run twice against
  // the same already-expired grant - proving the `spent_micro < amount_micro`
  // filter inside spend_credits() itself is what stops the second run from
  // re-inserting a colliding `expiry:{grantId}` ledger row (which would
  // otherwise abort with a unique-constraint error and take a legitimate
  // concurrent spend down with it).
  it('does not re-process an already-expired grant even if the zero-amount sweep call itself repeats', async () => {
    await grantExpiringYesterday(TENANT, 500_000n);
    await spendCredits({ tenantId: TENANT, amountMicro: 0n, key: `expiry-sweep:${TENANT}:direct-1`, kind: 'adjust' });
    await spendCredits({ tenantId: TENANT, amountMicro: 0n, key: `expiry-sweep:${TENANT}:direct-2`, kind: 'adjust' });
    expect(await ledgerRows(TENANT, 'expiry:')).toHaveLength(1);
  });
});

// Regression for the bug fixed in migration 0072: 0071's spend_credits() ran
// the lazy expiry sweep and the debit attempt in one flat sequence inside a
// single implicit transaction, so `raise exception 'INSUFFICIENT_CREDITS'`
// rolled back the sweep it had just performed a moment earlier under the same
// lock - the balance stayed overstated by exactly the expired amount until
// the nightly cron caught up. Own tenant UUID, distinct from every other
// tenant suffix listed above this file's TENANT comment.
const SHORTFALL_TENANT = '00000000-0000-0000-0000-0000000000a7';

describe.skipIf(!TEST_DB)('spend_credits() sweep survives an insufficient-credits shortfall', () => {
  beforeEach(async () => {
    await db.execute(sql`delete from credit_ledger where tenant_id = ${SHORTFALL_TENANT}`);
    await db.execute(sql`delete from credit_grants where tenant_id = ${SHORTFALL_TENANT}`);
    await db.execute(sql`delete from credit_accounts where tenant_id = ${SHORTFALL_TENANT}`);
    await seedTenant(SHORTFALL_TENANT);
  });

  afterAll(async () => {
    await db.execute(sql`delete from credit_ledger where tenant_id = ${SHORTFALL_TENANT}`);
    await db.execute(sql`delete from credit_grants where tenant_id = ${SHORTFALL_TENANT}`);
    await db.execute(sql`delete from credit_accounts where tenant_id = ${SHORTFALL_TENANT}`);
    await db.execute(sql`delete from tenants where id = ${SHORTFALL_TENANT}`);
  });

  it('sweeps an expired grant and throws InsufficientCreditsError, even though the debit itself is short', async () => {
    // One grant, expired yesterday, never spent - balance_micro overstates
    // what's actually spendable until the next sweep runs.
    await grantExpiringYesterday(SHORTFALL_TENANT, 1_000_000n);

    // The grant only just expired for real, so balance_micro is still stale
    // at 1,000,000 in credit_accounts before this call.
    const [before] = rowsOf(await db.execute(
      sql`select balance_micro from credit_accounts where tenant_id = ${SHORTFALL_TENANT}`,
    ));
    expect(BigInt(before.balance_micro as string)).toBe(1_000_000n);

    await expect(
      spendCredits({ tenantId: SHORTFALL_TENANT, amountMicro: -50_000n, key: 'shortfall:1', kind: 'debit' }),
    ).rejects.toThrow(InsufficientCreditsError);

    // The sweep must have landed anyway: balance zeroed, one expiry row, the
    // grant fully spent-out - none of it undone by the failed debit above.
    const [acct] = rowsOf(await db.execute(
      sql`select balance_micro from credit_accounts where tenant_id = ${SHORTFALL_TENANT}`,
    ));
    expect(BigInt(acct.balance_micro as string)).toBe(0n);
    expect(await ledgerRows(SHORTFALL_TENANT, 'expiry:')).toHaveLength(1);
    const [grant] = rowsOf(await db.execute(
      sql`select spent_micro, amount_micro from credit_grants where tenant_id = ${SHORTFALL_TENANT}`,
    ));
    expect(BigInt(grant.spent_micro as string)).toBe(BigInt(grant.amount_micro as string));

    // And no partial debit row survived under the failed key.
    expect(await ledgerRows(SHORTFALL_TENANT, 'shortfall:1')).toHaveLength(0);
  });
});

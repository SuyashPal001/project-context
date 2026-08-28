import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { grantCredits, spendCredits } from '@serverless-saas/credits';
import { handleCreditsExpire } from '../creditsExpire';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Own tenant UUIDs, distinct from other test files (credits/read.integration
// uses ...a2; onboarding.credits.test.ts uses ...b1/...b2).
const TENANT = '00000000-0000-0000-0000-0000000000c1';
const TENANT_LIVE = '00000000-0000-0000-0000-0000000000c2';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

async function seedTenant(tenantId: string) {
  await db.execute(sql`
    insert into tenants (id, name, slug) values (${tenantId}, 'credits expire test', ${'credits-expire-' + tenantId.slice(-4)})
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

async function grantExpiringNextMonth(tenantId: string, amountMicro: bigint) {
  const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await grantCredits({
    tenantId, amountMicro, key: `test-grant:${tenantId}:${Date.now()}:${Math.random()}`,
    grantType: 'subscription', expiresAt: nextMonth,
  });
}

async function balanceOf(tenantId: string): Promise<bigint> {
  const [row] = await db.execute(sql`select balance_micro from credit_accounts where tenant_id = ${tenantId}`) as unknown as { balance_micro: string }[];
  return BigInt(row?.balance_micro ?? '0');
}

async function ledgerRows(tenantId: string, keyPrefix: string) {
  const result = await db.execute(sql`
    select * from credit_ledger where tenant_id = ${tenantId} and idempotency_key like ${keyPrefix + '%'}
  `);
  return rowsOf(result);
}

describe.skipIf(!TEST_DB)('handleCreditsExpire', () => {
  beforeEach(async () => {
    for (const t of [TENANT, TENANT_LIVE]) {
      await db.execute(sql`delete from credit_ledger where tenant_id = ${t}`);
      await db.execute(sql`delete from credit_grants where tenant_id = ${t}`);
      await db.execute(sql`delete from credit_accounts where tenant_id = ${t}`);
      await seedTenant(t);
    }
  });

  afterAll(async () => {
    for (const t of [TENANT, TENANT_LIVE]) {
      await db.execute(sql`delete from credit_ledger where tenant_id = ${t}`);
      await db.execute(sql`delete from credit_grants where tenant_id = ${t}`);
      await db.execute(sql`delete from credit_accounts where tenant_id = ${t}`);
      await db.execute(sql`delete from tenants where id = ${t}`);
    }
  });

  it('zeroes an expired grant and writes one expiry row', async () => {
    await grantExpiringYesterday(TENANT, 500_000n);
    await handleCreditsExpire({});
    expect(await balanceOf(TENANT)).toBe(0n);
    expect(await ledgerRows(TENANT, 'expiry:')).toHaveLength(1);
  });

  it('is a no-op on a second run - it must not double-deduct', async () => {
    await grantExpiringYesterday(TENANT, 500_000n);
    await handleCreditsExpire({});
    await handleCreditsExpire({});
    expect(await ledgerRows(TENANT, 'expiry:')).toHaveLength(1);
  });

  it('leaves live grants alone', async () => {
    await grantExpiringNextMonth(TENANT_LIVE, 500_000n);
    await handleCreditsExpire({});
    expect(await balanceOf(TENANT_LIVE)).toBe(500_000n);
  });

  // This handler's own tenant-candidate query already filters out grants
  // where spent_micro = amount_micro, so calling handleCreditsExpire() twice
  // in a row never re-invokes spend_credits() for an already-expired grant -
  // the two tests above can't observe a regression in spend_credits()'s own
  // guard. Call spend_credits() directly, twice, with two DIFFERENT
  // idempotency keys (so the outer per-call replay check on p_key doesn't
  // short-circuit the second call either) to force its internal lazy-expiry
  // loop to run twice against the same already-expired grant - proving the
  // `spent_micro < amount_micro` filter inside spend_credits() itself is what
  // stops the second run from re-inserting a colliding `expiry:{grantId}`
  // ledger row (which would otherwise abort with a unique-constraint error
  // and, per the brief, take a legitimate concurrent spend down with it).
  it('does not re-process an already-expired grant even if the zero-amount sweep call itself repeats', async () => {
    await grantExpiringYesterday(TENANT, 500_000n);
    await spendCredits({ tenantId: TENANT, amountMicro: 0n, key: `expiry-sweep:${TENANT}:direct-1`, kind: 'adjust' });
    await spendCredits({ tenantId: TENANT, amountMicro: 0n, key: `expiry-sweep:${TENANT}:direct-2`, kind: 'adjust' });
    expect(await ledgerRows(TENANT, 'expiry:')).toHaveLength(1);
  });
});

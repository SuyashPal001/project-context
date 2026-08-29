import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { grantCredits } from '@serverless-saas/credits';
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

  // A fourth test used to live here calling spend_credits() directly (never
  // handleCreditsExpire()) to prove its internal lazy-expiry loop doesn't
  // double-deduct when replayed with different idempotency keys. That's
  // spend_credits()'s own property, not this handler's, so it moved to
  // packages/foundation/credits/src/__tests__/expiry-replay.integration.test.ts,
  // beside the rest of spend_credits()'s coverage.
});

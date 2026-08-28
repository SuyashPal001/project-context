import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';

const TEST_DB = process.env.TEST_DATABASE_URL;
// `types: { bigint }` is what lets a JS BigInt be passed as an int8 parameter -
// postgres.js serializes one either way, but its default Serializable type does not
// include bigint, so without this `tsc` rejects every micro amount below.
const sql = TEST_DB
  ? postgres(TEST_DB, { max: 5, types: { bigint: postgres.BigInt } })
  : (null as never);
const TENANT = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000a2';

async function resetTenant(tenant: string, slug: string) {
  await sql`delete from credit_ledger where tenant_id = ${tenant}`;
  await sql`delete from credit_grants where tenant_id = ${tenant}`;
  await sql`delete from credit_accounts where tenant_id = ${tenant}`;
  await sql`insert into tenants (id, name, slug) values (${tenant}, 'credit test', ${slug})
            on conflict (id) do nothing`;
}

async function reset() {
  await resetTenant(TENANT, 'credit-test-a1');
  await resetTenant(TENANT_B, 'credit-test-a2');
}

async function grantFor(tenant: string, amount: bigint, expiresAt: string | null) {
  // credit_grants.tenant_id references credit_accounts.tenant_id, so the account
  // row has to exist before the grant that hangs off it.
  await sql`insert into credit_accounts (tenant_id, balance_micro) values (${tenant}, ${amount})
            on conflict (tenant_id) do update set balance_micro = credit_accounts.balance_micro + ${amount}`;
  await sql`insert into credit_grants (tenant_id, grant_type, amount_micro, expires_at)
            values (${tenant}, 'admin', ${amount}, ${expiresAt})`;
}

const grant = (amount: bigint, expiresAt: string | null) => grantFor(TENANT, amount, expiresAt);

async function liveGrantSum(tenant: string) {
  const [r] = await sql`select coalesce(sum(amount_micro - spent_micro), 0) as live
                        from credit_grants
                        where tenant_id = ${tenant} and (expires_at is null or expires_at > now())`;
  return BigInt(r.live);
}

// Migration 0072: spend_credits() returns a row of (new_balance, insufficient,
// short_by) rather than a bare scalar, so a shortfall can be reported without
// raising - raising would abort the whole statement and take the lazy expiry
// sweep down with it (see 0072's migration comment).
const spend = (amount: bigint, key: string, kind = 'debit') =>
  sql`select * from spend_credits(${TENANT}, ${amount}, ${key}, ${kind}, null, null)`;

describe.skipIf(!TEST_DB)('spend_credits', () => {
  beforeEach(reset);
  afterAll(async () => { if (TEST_DB) await sql.end(); });

  it('debits from a single grant and returns the new balance', async () => {
    await grant(1_000_000n, null);
    const [row] = await spend(-250_000n, 'test:1');
    expect(BigInt(row.new_balance)).toBe(750_000n);
  });

  it('reports insufficient (no throw) and writes no debit rows when short', async () => {
    await grant(100_000n, null);
    const [row] = await spend(-500_000n, 'test:2');
    expect(row.insufficient).toBe(true);
    expect(BigInt(row.short_by)).toBe(400_000n);
    expect(BigInt(row.new_balance)).toBe(100_000n);   // unchanged - nothing to sweep, nothing charged
    const rows = await sql`select * from credit_ledger where idempotency_key = 'test:2'`;
    expect(rows.length).toBe(0);
  });

  it('drains grant A then grant B under one key, as seq 0 and 1', async () => {
    await grant(300_000n, null);
    await new Promise(r => setTimeout(r, 10));   // distinct created_at for FIFO order
    await grant(300_000n, null);
    await spend(-500_000n, 'test:3');
    const rows = await sql`select seq, amount_micro from credit_ledger
                           where idempotency_key = 'test:3' order by seq`;
    expect(rows.map(r => Number(r.amount_micro))).toEqual([-300_000, -200_000]);
  });

  it('replays the same key without charging twice', async () => {
    await grant(1_000_000n, null);
    await spend(-400_000n, 'test:4');
    const [row] = await spend(-400_000n, 'test:4');
    expect(BigInt(row.new_balance)).toBe(600_000n);
    const rows = await sql`select * from credit_ledger where idempotency_key = 'test:4'`;
    expect(rows.length).toBe(1);
  });

  it('never spends an expired grant, and drops it from the balance at spend time', async () => {
    await grant(1_000_000n, new Date(Date.now() - 60_000).toISOString());
    await grant(200_000n, null);
    const [row] = await spend(-100_000n, 'test:5');
    expect(BigInt(row.new_balance)).toBe(100_000n);            // expired 1_000_000 swept, not spent
    const [exp] = await sql`select kind from credit_ledger where kind = 'expiry' and tenant_id = ${TENANT}`;
    expect(exp.kind).toBe('expiry');
  });

  it('credits into a NEW grant rather than un-spending an old one', async () => {
    await grant(500_000n, null);
    await spend(-500_000n, 'test:6');
    const [row] = await sql`select * from spend_credits(${TENANT}, ${200_000n}, 'test:6:refund', 'refund',
                                                 null, null, null, null, null, null, 'refund')`;
    expect(BigInt(row.new_balance)).toBe(200_000n);
    const grants = await sql`select grant_type from credit_grants where tenant_id = ${TENANT}`;
    expect(grants.map(g => g.grant_type).sort()).toEqual(['admin', 'refund']);
  });

  it('serializes concurrent debits with zero overdraft', async () => {
    await grant(1_000_000n, null);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => spend(-200_000n, `test:conc:${i}`)),
    );
    // None of these throw any more (0072) - a shortfall is reported through
    // the row, not a rejection - so "succeeded" now means fulfilled AND not
    // insufficient.
    const ok = results.filter(r => r.status === 'fulfilled' && !r.value[0].insufficient).length;
    expect(ok).toBe(5);                                     // 5 x 200_000 = the whole grant
    const [acct] = await sql`select balance_micro from credit_accounts where tenant_id = ${TENANT}`;
    expect(BigInt(acct.balance_micro)).toBe(0n);            // never negative
  });

  it('keeps balance equal to the sum of live grant remainders', async () => {
    await grant(700_000n, null);
    await spend(-250_000n, 'test:inv');
    const [acct] = await sql`select balance_micro from credit_accounts where tenant_id = ${TENANT}`;
    const [sum] = await sql`select coalesce(sum(amount_micro - spent_micro), 0) as live
                            from credit_grants
                            where tenant_id = ${TENANT} and (expires_at is null or expires_at > now())`;
    expect(BigInt(acct.balance_micro)).toBe(BigInt(sum.live));
  });

  // Regression: the idempotency key namespace is per-tenant. An operator-chosen
  // top-up key like 'aug-promo' is free-form (spec section 5), so the same string
  // will be reused across tenants. Before the tenant predicate on the replay check,
  // the second tenant's call matched the first tenant's ledger row on the key string
  // alone and returned an unchanged balance with no grant applied and no error -
  // a silent credit loss.
  it('scopes the idempotency key per tenant, so one key can be reused across tenants', async () => {
    const KEY = 'aug-promo';
    const topUp = (tenant: string) =>
      sql`select * from spend_credits(${tenant}, ${500_000n}, ${KEY}, 'grant',
                               null, null, null, null, null, null, 'admin')`;

    const [a] = await topUp(TENANT);
    const [b] = await topUp(TENANT_B);

    expect(BigInt(a.new_balance)).toBe(500_000n);
    expect(BigInt(b.new_balance)).toBe(500_000n);   // tenant B is credited, not replayed off A

    const ledger = await sql`select tenant_id from credit_ledger where idempotency_key = ${KEY}
                             order by tenant_id`;
    expect(ledger.map(r => r.tenant_id)).toEqual([TENANT, TENANT_B]);

    for (const t of [TENANT, TENANT_B]) {
      const [acct] = await sql`select balance_micro from credit_accounts where tenant_id = ${t}`;
      expect(BigInt(acct.balance_micro)).toBe(500_000n);
      expect(await liveGrantSum(t)).toBe(500_000n);
      const grants = await sql`select amount_micro from credit_grants where tenant_id = ${t}`;
      expect(grants.length).toBe(1);
    }

    // ...and a genuine replay within one tenant still replays.
    const [again] = await topUp(TENANT);
    expect(BigInt(again.new_balance)).toBe(500_000n);
    const aRows = await sql`select 1 from credit_ledger
                            where tenant_id = ${TENANT} and idempotency_key = ${KEY}`;
    expect(aRows.length).toBe(1);
  });

  it('refunds a multi-grant debit into a new grant, preserving the balance invariant', async () => {
    await grant(200_000n, null);
    await new Promise(r => setTimeout(r, 10));   // distinct created_at for FIFO order
    await grant(300_000n, null);

    await spend(-450_000n, 'inv:debit');
    const debits = await sql`select seq, amount_micro from credit_ledger
                             where tenant_id = ${TENANT} and idempotency_key = 'inv:debit'
                             order by seq`;
    expect(debits.map(r => Number(r.amount_micro))).toEqual([-200_000, -250_000]);

    // Sum the debit's rows and issue ONE positive call - spec section 4, no special case.
    const refund = debits.reduce((acc, r) => acc - BigInt(r.amount_micro), 0n);
    expect(refund).toBe(450_000n);
    const [row] = await sql`select * from spend_credits(${TENANT}, ${refund}, 'inv:debit:refund', 'refund',
                                                 null, null)`;
    expect(BigInt(row.new_balance)).toBe(500_000n);

    const [acct] = await sql`select balance_micro from credit_accounts where tenant_id = ${TENANT}`;
    expect(BigInt(acct.balance_micro)).toBe(await liveGrantSum(TENANT));
    expect(BigInt(acct.balance_micro)).toBe(500_000n);

    // The refund landed in a NEW grant: grant A is drained, grant B keeps its 50k
    // remainder, and neither had spent_micro walked back.
    const grants = await sql`select grant_type, amount_micro, spent_micro from credit_grants
                             where tenant_id = ${TENANT} order by created_at`;
    expect(grants.map(g => g.grant_type)).toEqual(['admin', 'admin', 'refund']);
    expect(grants.map(g => Number(g.spent_micro))).toEqual([200_000, 250_000, 0]);
    expect(Number(grants[2].amount_micro)).toBe(450_000);
  });
});

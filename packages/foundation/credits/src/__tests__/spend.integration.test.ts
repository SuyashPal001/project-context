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

async function reset() {
  await sql`delete from credit_ledger where tenant_id = ${TENANT}`;
  await sql`delete from credit_grants where tenant_id = ${TENANT}`;
  await sql`delete from credit_accounts where tenant_id = ${TENANT}`;
  await sql`insert into tenants (id, name, slug) values (${TENANT}, 'credit test', 'credit-test-a1')
            on conflict (id) do nothing`;
}

async function grant(amount: bigint, expiresAt: string | null) {
  // credit_grants.tenant_id references credit_accounts.tenant_id, so the account
  // row has to exist before the grant that hangs off it.
  await sql`insert into credit_accounts (tenant_id, balance_micro) values (${TENANT}, ${amount})
            on conflict (tenant_id) do update set balance_micro = credit_accounts.balance_micro + ${amount}`;
  await sql`insert into credit_grants (tenant_id, grant_type, amount_micro, expires_at)
            values (${TENANT}, 'admin', ${amount}, ${expiresAt})`;
}

const spend = (amount: bigint, key: string, kind = 'debit') =>
  sql`select spend_credits(${TENANT}, ${amount}, ${key}, ${kind}, null, null) as balance`;

describe.skipIf(!TEST_DB)('spend_credits', () => {
  beforeEach(reset);
  afterAll(async () => { if (TEST_DB) await sql.end(); });

  it('debits from a single grant and returns the new balance', async () => {
    await grant(1_000_000n, null);
    const [row] = await spend(-250_000n, 'test:1');
    expect(BigInt(row.balance)).toBe(750_000n);
  });

  it('raises INSUFFICIENT_CREDITS and writes no rows when short', async () => {
    await grant(100_000n, null);
    await expect(spend(-500_000n, 'test:2')).rejects.toThrow(/INSUFFICIENT_CREDITS/);
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
    expect(BigInt(row.balance)).toBe(600_000n);
    const rows = await sql`select * from credit_ledger where idempotency_key = 'test:4'`;
    expect(rows.length).toBe(1);
  });

  it('never spends an expired grant, and drops it from the balance at spend time', async () => {
    await grant(1_000_000n, new Date(Date.now() - 60_000).toISOString());
    await grant(200_000n, null);
    const [row] = await spend(-100_000n, 'test:5');
    expect(BigInt(row.balance)).toBe(100_000n);            // expired 1_000_000 swept, not spent
    const [exp] = await sql`select kind from credit_ledger where kind = 'expiry' and tenant_id = ${TENANT}`;
    expect(exp.kind).toBe('expiry');
  });

  it('credits into a NEW grant rather than un-spending an old one', async () => {
    await grant(500_000n, null);
    await spend(-500_000n, 'test:6');
    const [row] = await sql`select spend_credits(${TENANT}, ${200_000n}, 'test:6:refund', 'refund',
                                                 null, null, null, null, null, null, 'refund') as balance`;
    expect(BigInt(row.balance)).toBe(200_000n);
    const grants = await sql`select grant_type from credit_grants where tenant_id = ${TENANT}`;
    expect(grants.map(g => g.grant_type).sort()).toEqual(['admin', 'refund']);
  });

  it('serializes concurrent debits with zero overdraft', async () => {
    await grant(1_000_000n, null);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => spend(-200_000n, `test:conc:${i}`)),
    );
    const ok = results.filter(r => r.status === 'fulfilled').length;
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
});

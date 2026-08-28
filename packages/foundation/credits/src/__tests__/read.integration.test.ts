import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { spendCredits, grantCredits, getBalance, getLedger, InsufficientCreditsError } from '../index';

const TEST_DB = process.env.TEST_DATABASE_URL;
const TENANT = '00000000-0000-0000-0000-0000000000a2';

describe.skipIf(!TEST_DB)('credits wrappers', () => {
  beforeEach(async () => {
    await db.execute(sql`delete from credit_ledger where tenant_id = ${TENANT}`);
    await db.execute(sql`delete from credit_grants where tenant_id = ${TENANT}`);
    await db.execute(sql`delete from credit_accounts where tenant_id = ${TENANT}`);
    await db.execute(sql`
      insert into tenants (id, name, slug) values (${TENANT}, 'credits wrapper test', 'credits-wrapper-test')
      on conflict (id) do nothing
    `);
  });

  it('grants then debits, and reports both in the balance', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 1_000_000n, key: 'g:1', grantType: 'admin' });
    await spendCredits({ tenantId: TENANT, amountMicro: -400_000n, key: 'd:1', kind: 'debit' });
    const balance = await getBalance(TENANT);
    expect(balance.balanceMicro).toBe(600_000n);
    expect(balance.grants).toHaveLength(1);
  });

  it('throws a typed error, not a raw pg error, when short', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 100n, key: 'g:2', grantType: 'admin' });
    await expect(
      spendCredits({ tenantId: TENANT, amountMicro: -999_999n, key: 'd:2', kind: 'debit' }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('returns ledger rows newest first', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 1_000_000n, key: 'g:3', grantType: 'admin' });
    await spendCredits({ tenantId: TENANT, amountMicro: -1n, key: 'd:3', kind: 'debit' });
    const rows = await getLedger(TENANT, { limit: 10 });
    expect(rows[0].kind).toBe('debit');
    expect(rows[1].kind).toBe('grant');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { spendCredits, grantCredits, getBalance, getLedger, InsufficientCreditsError, getUsageByType, getLastGrant } from '../index';

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

  // Regression: spendCredits() interpolated a raw JS Date into the
  // drizzle-orm `sql` template passed to db.execute(). That path hits
  // postgres.js's prepared-param encoder, which - unlike postgres.js's own
  // tagged-template call - does not serialize Date objects and throws
  // ERR_INVALID_ARG_TYPE. No existing test caught it because every other
  // grantCredits call in this suite omits expiresAt; the credits backfill
  // script (task 7) is the first real caller that always passes one, and
  // every trial/subscription-renewal grant (task 13) rides this same path.
  it('accepts a Date expiresAt and round-trips it through credit_grants.expires_at', async () => {
    const expiresAt = new Date('2027-06-01T00:00:00.000Z');
    await grantCredits({
      tenantId: TENANT, amountMicro: 250_000n, key: 'g:expiry',
      grantType: 'subscription', expiresAt,
    });
    const balance = await getBalance(TENANT);
    expect(balance.grants).toHaveLength(1);
    expect(balance.grants[0].expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('buckets ledger debits by job type, defaulting unrecognized/null job types to text', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 10_000_000n, key: 'g:bucket', grantType: 'admin' });
    await spendCredits({ tenantId: TENANT, amountMicro: -1_000_000n, key: 'd:text', kind: 'debit', jobType: 'chat_message' });
    await spendCredits({ tenantId: TENANT, amountMicro: -2_000_000n, key: 'd:image', kind: 'debit', jobType: 'image_generation' });
    await spendCredits({ tenantId: TENANT, amountMicro: -3_000_000n, key: 'd:video', kind: 'debit', jobType: 'video_generation' });
    await spendCredits({ tenantId: TENANT, amountMicro: -400_000n, key: 'd:audio', kind: 'debit', jobType: 'music_generation' });
    await spendCredits({ tenantId: TENANT, amountMicro: -100_000n, key: 'd:unknown', kind: 'debit', jobType: null });

    const usage = await getUsageByType(TENANT);
    expect(usage.text).toBe(1_100_000n); // chat_message (1,000,000) + null (100,000)
    expect(usage.image).toBe(2_000_000n);
    expect(usage.video).toBe(3_000_000n);
    expect(usage.audio).toBe(400_000n);
  });

  it('ignores grant/refund rows — only debits count as spend', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 5_000_000n, key: 'g:ignore-me', grantType: 'admin' });
    const usage = await getUsageByType(TENANT);
    expect(usage.text).toBe(0n);
    expect(usage.image).toBe(0n);
    expect(usage.video).toBe(0n);
    expect(usage.audio).toBe(0n);
  });

  it('reports the most recently created grant, regardless of which grant a debit actually drew from', async () => {
    await grantCredits({ tenantId: TENANT, amountMicro: 1_000_000n, key: 'g:old', grantType: 'admin' });
    await grantCredits({ tenantId: TENANT, amountMicro: 5_000_000n, key: 'g:new', grantType: 'purchase' });
    await spendCredits({ tenantId: TENANT, amountMicro: -500_000n, key: 'd:against-fifo', kind: 'debit' });

    const lastGrant = await getLastGrant(TENANT);
    expect(lastGrant?.grantType).toBe('purchase');
    expect(lastGrant?.amountMicro).toBe(5_000_000n);
  });

  it('returns null for getLastGrant when the tenant has no grants', async () => {
    const lastGrant = await getLastGrant(TENANT);
    expect(lastGrant).toBeNull();
  });
});

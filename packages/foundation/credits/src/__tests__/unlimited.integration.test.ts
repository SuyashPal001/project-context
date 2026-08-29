import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { isUnlimited } from '../read';

const TEST_DB = process.env.TEST_DATABASE_URL;

const ENTERPRISE_TENANT = '00000000-0000-0000-0000-0000000000a3';
const FREE_TENANT = '00000000-0000-0000-0000-0000000000a4';
const UNKNOWN_TENANT = '00000000-0000-0000-0000-0000000000a5';

async function resetTenant(tenant: string, slug: string) {
  await db.execute(sql`delete from subscriptions where tenant_id = ${tenant}`);
  await db.execute(sql`delete from tenant_feature_overrides where tenant_id = ${tenant}`);
  await db.execute(sql`
    insert into tenants (id, name, slug) values (${tenant}, 'unlimited test', ${slug})
    on conflict (id) do nothing
  `);
}

describe.skipIf(!TEST_DB)('isUnlimited', () => {
  beforeEach(async () => {
    await resetTenant(ENTERPRISE_TENANT, 'unlimited-test-a3');
    await resetTenant(FREE_TENANT, 'unlimited-test-a4');
    // UNKNOWN_TENANT deliberately has no tenants/subscriptions row at all.
    await db.execute(sql`delete from subscriptions where tenant_id = ${UNKNOWN_TENANT}`);

    await db.execute(sql`
      insert into subscriptions (tenant_id, plan, status) values (${ENTERPRISE_TENANT}, 'enterprise', 'active')
    `);
    await db.execute(sql`
      insert into subscriptions (tenant_id, plan, status) values (${FREE_TENANT}, 'free', 'active')
    `);
  });

  it('is true for a tenant on a plan whose credits entitlement is unlimited', async () => {
    expect(await isUnlimited(ENTERPRISE_TENANT)).toBe(true);
  });

  it('is false for a metered plan', async () => {
    expect(await isUnlimited(FREE_TENANT)).toBe(false);
  });

  it('is false, not throwing, when the tenant has no subscription row', async () => {
    expect(await isUnlimited(UNKNOWN_TENANT)).toBe(false);
  });
});

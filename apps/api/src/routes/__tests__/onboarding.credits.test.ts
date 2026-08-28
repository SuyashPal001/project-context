import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { grantTrialCredits, grantSubscriptionCycleCredits, planCreditAllowance } from '../../lib/creditsLifecycle';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Own tenant UUIDs, distinct from other test files (credits/read.integration
// uses ...a2; apps/worker's creditsExpire test uses ...c1/...c2).
const TENANT = '00000000-0000-0000-0000-0000000000b1';
const UNLIMITED_TENANT = '00000000-0000-0000-0000-0000000000b2';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

const OVERRIDE_GRANTER = '00000000-0000-0000-0000-0000000000b9';

// Seeds a tenant on 'starter' (value_limit 2000 - NOT null) but with a
// tenant_feature_override marking the 'credits' feature unlimited=true. This
// is deliberately NOT the 'enterprise' plan: enterprise's own value_limit is
// null, so planCreditAllowance() would return null and skip granting even if
// the isUnlimited() check were removed entirely - that would silently mask a
// mutation of the unlimited-skip. Overriding unlimited on a plan that DOES
// have a concrete entitlement amount is what actually proves the skip runs.
async function seedUnlimitedOverride(tenantId: string) {
  await seedTenantWithPlan(tenantId, 'starter');
  await db.execute(sql`
    insert into users (id, cognito_id, email, name)
    values (${OVERRIDE_GRANTER}, ${'cognito-' + OVERRIDE_GRANTER}, ${'override-granter@example.com'}, 'Override Granter')
    on conflict (id) do nothing
  `);
  const [feature] = rowsOf(await db.execute(sql`select id from features where key = 'credits' limit 1`));
  await db.execute(sql`
    insert into tenant_feature_overrides (tenant_id, feature_id, unlimited, granted_by, reason)
    values (${tenantId}, ${feature.id as string}, true, ${OVERRIDE_GRANTER}, 'mutation-test override')
    on conflict (tenant_id, feature_id) do update set unlimited = true
  `);
}

async function seedTenantWithPlan(tenantId: string, plan: string) {
  await db.execute(sql`
    insert into tenants (id, name, slug) values (${tenantId}, 'onboarding credits test', ${'oct-' + tenantId.slice(-8)})
    on conflict (id) do nothing
  `);
  const existing = await db.execute(sql`
    select 1 from subscriptions where tenant_id = ${tenantId} and status = 'active' limit 1
  `);
  if (rowsOf(existing).length === 0) {
    await db.execute(sql`
      insert into subscriptions (tenant_id, plan, status, billing_cycle, started_at)
      values (${tenantId}, ${plan}, 'active', 'monthly', now())
    `);
  }
}

// Mirrors the tenant-creation path in onboarding.ts's '/complete' handler:
// seed a subscription, then run the same credit-granting step it calls.
// Running the full HTTP route (6 seeded agents, roles, permissions, api
// keys...) would test onboarding's agent-seeding, not the credit grant this
// task adds - this isolates exactly the behavior task 13 is responsible for.
async function createTenant(tenantId: string, plan: string = 'free') {
  await seedTenantWithPlan(tenantId, plan);
  await grantTrialCredits(tenantId);
}

async function ledgerRows(tenantId: string, keyPrefix: string) {
  const result = await db.execute(sql`
    select * from credit_ledger where tenant_id = ${tenantId} and idempotency_key like ${keyPrefix + '%'}
  `);
  return rowsOf(result);
}

async function accountExists(tenantId: string): Promise<boolean> {
  const result = await db.execute(sql`select 1 from credit_accounts where tenant_id = ${tenantId}`);
  return rowsOf(result).length > 0;
}

async function cleanup(tenantId: string) {
  await db.execute(sql`delete from credit_ledger where tenant_id = ${tenantId}`);
  await db.execute(sql`delete from credit_grants where tenant_id = ${tenantId}`);
  await db.execute(sql`delete from credit_accounts where tenant_id = ${tenantId}`);
  await db.execute(sql`delete from tenant_feature_overrides where tenant_id = ${tenantId}`);
  await db.execute(sql`delete from subscriptions where tenant_id = ${tenantId}`);
}

describe.skipIf(!TEST_DB)('trial and subscription credit grants', () => {
  beforeEach(async () => {
    await cleanup(TENANT);
    await cleanup(UNLIMITED_TENANT);
  });

  afterAll(async () => {
    await cleanup(TENANT);
    await cleanup(UNLIMITED_TENANT);
    await db.execute(sql`delete from tenants where id = ${TENANT}`);
    await db.execute(sql`delete from tenants where id = ${UNLIMITED_TENANT}`);
    await db.execute(sql`delete from users where id = ${OVERRIDE_GRANTER}`);
  });

  it('grants trial credits exactly once per tenant', async () => {
    await createTenant(TENANT);
    await createTenant(TENANT); // replayed onboarding
    const rows = await ledgerRows(TENANT, 'trial:');
    expect(rows).toHaveLength(1);
  });

  it('creates the credit account row at tenant creation', async () => {
    await createTenant(TENANT);
    expect(await accountExists(TENANT)).toBe(true);
  });

  it('sizes the trial grant from the plan credits entitlement', async () => {
    await createTenant(TENANT, 'starter');
    const rows = await ledgerRows(TENANT, 'trial:');
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0].amount_micro as string)).toBe(2_000n * 1_000_000n);
  });

  it('keys the trial grant idempotency key as trial:{tenantId}, not a generic key', async () => {
    await createTenant(TENANT);
    const rows = await ledgerRows(TENANT, 'trial:');
    expect(rows[0].idempotency_key).toBe(`trial:${TENANT}`);
  });

  it('does not grant an unlimited tenant, but still creates its account row', async () => {
    await seedUnlimitedOverride(UNLIMITED_TENANT);
    await grantTrialCredits(UNLIMITED_TENANT);
    expect(await ledgerRows(UNLIMITED_TENANT, 'trial:')).toHaveLength(0);
    expect(await accountExists(UNLIMITED_TENANT)).toBe(true);
  });

  it('reads the plan credit allowance from the credits entitlement', async () => {
    await seedTenantWithPlan(TENANT, 'business');
    expect(await planCreditAllowance(TENANT)).toBe(10_000);
  });

  it('grants subscription credits on renewal, keyed by subscription id and cycle', async () => {
    await seedTenantWithPlan(TENANT, 'starter');
    await grantSubscriptionCycleCredits(TENANT, 'sub-abc', new Date(), 'monthly');
    const rows = await ledgerRows(TENANT, 'sub:sub-abc:');
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe('sub:sub-abc:0');
    expect(BigInt(rows[0].amount_micro as string)).toBe(2_000n * 1_000_000n);
  });

  it('grants subscription credits exactly once per subscription cycle', async () => {
    await seedTenantWithPlan(TENANT, 'starter');
    await grantSubscriptionCycleCredits(TENANT, 'sub-abc', new Date(), 'monthly');
    await grantSubscriptionCycleCredits(TENANT, 'sub-abc', new Date(), 'monthly'); // replay
    const rows = await ledgerRows(TENANT, 'sub:sub-abc:');
    expect(rows).toHaveLength(1);
  });

  it('does not grant subscription credits to an unlimited tenant', async () => {
    await seedUnlimitedOverride(UNLIMITED_TENANT);
    await grantSubscriptionCycleCredits(UNLIMITED_TENANT, 'sub-xyz', new Date(), 'monthly');
    expect(await ledgerRows(UNLIMITED_TENANT, 'sub:sub-xyz:')).toHaveLength(0);
  });
});

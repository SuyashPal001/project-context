import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, nextCycleEnd } from '@serverless-saas/database';
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

  it('grants subscription credits on a plan change, keyed by tenant, plan, and cycle end', async () => {
    await seedTenantWithPlan(TENANT, 'starter');
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', new Date());
    const rows = await ledgerRows(TENANT, `sub:${TENANT}:starter:`);
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0].amount_micro as string)).toBe(2_000n * 1_000_000n);
  });

  it('grants subscription credits exactly once when the same call repeats (the abuse case: spamming /billing/upgrade)', async () => {
    await seedTenantWithPlan(TENANT, 'starter');
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', new Date());
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', new Date()); // replay
    const rows = await ledgerRows(TENANT, `sub:${TENANT}:starter:`);
    expect(rows).toHaveLength(1);
  });

  it('does not re-grant when billingCycle toggles monthly<->annual within the same cycle', async () => {
    await seedTenantWithPlan(TENANT, 'starter');
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', new Date());
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'annual', new Date());  // toggle to annual
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', new Date()); // toggle back
    const rows = await ledgerRows(TENANT, `sub:${TENANT}:starter:`);
    expect(rows).toHaveLength(1);
  });

  it('truncates the fresh-cycle key to a UTC date, not the full millisecond timestamp', async () => {
    // Pins the review fix for a concurrency gap: on a tenant's first-ever
    // subscription grant (or the first call after a genuine cycle boundary)
    // there is no prior grant to reuse yet, so `expiresAt` is computed fresh
    // via nextCycleEnd(startedAt, ...), which preserves startedAt's
    // milliseconds. `startedAt` is a fresh `new Date()` per request in
    // billing.ts, so N concurrent calls racing this branch would each
    // compute a slightly different `expiresAt` and therefore a different
    // key, unless the key's period component is coarser than the value
    // stored on the grant. A real two-connection race isn't reproducible
    // deterministically in this suite (same structural limit as Task 14's
    // `for update` lock - see that mutation note); asserting the key format
    // directly is the deterministic proxy: it fails exactly when the
    // truncation is removed, independent of timing.
    await seedTenantWithPlan(TENANT, 'starter');
    const start = new Date();
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', start);
    const rows = await ledgerRows(TENANT, `sub:${TENANT}:starter:`);
    expect(rows).toHaveLength(1);
    const expectedDate = nextCycleEnd(start, 'monthly').toISOString().slice(0, 10);
    expect(rows[0].idempotency_key).toBe(`sub:${TENANT}:starter:${expectedDate}`);
  });

  it('grants once per distinct plan on a genuine mid-cycle plan change, with no clawback of the earlier grant', async () => {
    // Pins the accepted v1 bound from the review: a real plan change mid-cycle
    // still gets a full fresh allowance (no proration/clawback), but that is
    // bounded to once PER DISTINCT PLAN within the period - repeating a plan
    // that already granted in this cycle must still collapse. Uses free,
    // starter, business (concrete credits amounts); enterprise is excluded
    // here because it is the `unlimited` plan and takes the isUnlimited()
    // early-return path instead - already covered by the unlimited-tenant
    // test below.
    await seedTenantWithPlan(TENANT, 'free');
    const start = new Date();

    await grantSubscriptionCycleCredits(TENANT, 'free', 'monthly', start);
    // A genuine plan change: mirrors what upgradeHandler does to the
    // subscriptions row before calling grantSubscriptionCycleCredits with the
    // new plan value - planCreditAllowance() reads the tenant's ACTIVE
    // subscription row, not the `plan` argument, so the row has to move too.
    await db.execute(sql`update subscriptions set plan = 'starter' where tenant_id = ${TENANT} and status = 'active'`);
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', start);
    await db.execute(sql`update subscriptions set plan = 'business' where tenant_id = ${TENANT} and status = 'active'`);
    await grantSubscriptionCycleCredits(TENANT, 'business', 'monthly', start);
    // Repeating a plan already granted this cycle must still collapse.
    await grantSubscriptionCycleCredits(TENANT, 'business', 'monthly', start);

    const freeRows = await ledgerRows(TENANT, `sub:${TENANT}:free:`);
    const starterRows = await ledgerRows(TENANT, `sub:${TENANT}:starter:`);
    const businessRows = await ledgerRows(TENANT, `sub:${TENANT}:business:`);
    expect(freeRows).toHaveLength(1);
    expect(starterRows).toHaveLength(1);
    expect(businessRows).toHaveLength(1);
    expect(BigInt(freeRows[0].amount_micro as string)).toBe(200n * 1_000_000n);
    expect(BigInt(starterRows[0].amount_micro as string)).toBe(2_000n * 1_000_000n);
    expect(BigInt(businessRows[0].amount_micro as string)).toBe(10_000n * 1_000_000n);
  });

  it('grants again once the prior cycle has actually ended, even for the same plan', async () => {
    await seedTenantWithPlan(TENANT, 'starter');
    const firstStart = new Date();
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', firstStart);
    const first = await ledgerRows(TENANT, `sub:${TENANT}:starter:`);
    expect(first).toHaveLength(1);

    // Don't touch the grant row - pass a `startedAt` far enough past the
    // first grant's own cycle end (~1 month out) that the real elapsed-time
    // check must be the thing deciding this is a fresh cycle, not a
    // coincidentally-different key from mutating expires_at directly.
    const secondStart = new Date(firstStart.getTime() + 40 * 24 * 60 * 60 * 1000);
    await grantSubscriptionCycleCredits(TENANT, 'starter', 'monthly', secondStart);
    const rows = await ledgerRows(TENANT, `sub:${TENANT}:starter:`);
    expect(rows).toHaveLength(2);
  });

  it('does not grant subscription credits to an unlimited tenant', async () => {
    await seedUnlimitedOverride(UNLIMITED_TENANT);
    await grantSubscriptionCycleCredits(UNLIMITED_TENANT, 'starter', 'monthly', new Date());
    expect(await ledgerRows(UNLIMITED_TENANT, `sub:${UNLIMITED_TENANT}:`)).toHaveLength(0);
  });
});

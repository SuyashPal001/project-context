import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { handleCreditsRenew } from '../creditsRenew';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Own tenant UUIDs, distinct from every other test file (read.integration uses
// ...a2; onboarding.credits uses ...b1/...b2; creditsExpire uses ...c1/...c2).
const ACTIVE = '00000000-0000-0000-0000-0000000000d1';
const TRIALING = '00000000-0000-0000-0000-0000000000d2';
const CANCELLED = '00000000-0000-0000-0000-0000000000d3';
const DUPLICATE_ROWS = '00000000-0000-0000-0000-0000000000d4';
const ENDED = '00000000-0000-0000-0000-0000000000d5';

const ALL = [ACTIVE, TRIALING, CANCELLED, DUPLICATE_ROWS, ENDED];

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

async function seedTenant(tenantId: string) {
  await db.execute(sql`
    insert into tenants (id, name, slug)
    values (${tenantId}, 'credits renew test', ${'credits-renew-' + tenantId.slice(-4)})
    on conflict (id) do nothing
  `);
}

async function seedSubscription(
  tenantId: string,
  plan: string,
  status: string,
  startedAt: Date,
  endedAt: Date | null = null,
) {
  await db.execute(sql`
    insert into subscriptions (tenant_id, plan, status, billing_cycle, started_at, ended_at)
    values (${tenantId}, ${plan}, ${status}::subscription_status, 'monthly', ${startedAt.toISOString()}, ${endedAt ? endedAt.toISOString() : null})
  `);
}

async function subGrants(tenantId: string) {
  return rowsOf(await db.execute(sql`
    select idempotency_key from credit_ledger
     where tenant_id = ${tenantId} and idempotency_key like ${'sub:' + tenantId + ':%'}
     order by idempotency_key
  `));
}

async function cleanup() {
  for (const tenantId of ALL) {
    await db.execute(sql`delete from credit_ledger where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from credit_grants where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from credit_accounts where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from subscriptions where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  }
}

describe.skipIf(!TEST_DB)('handleCreditsRenew', () => {
  beforeEach(async () => {
    await cleanup();
    for (const tenantId of ALL) await seedTenant(tenantId);
  });

  afterAll(cleanup);

  it('grants an active tenant once, and a second run in the same cycle grants nothing', async () => {
    // Acceptance criteria 1 and 2. The job carries no rollover detection of
    // its own — this is the idempotency key inside grantSubscriptionCycleCredits
    // doing the work, which is the point of the design.
    await seedSubscription(ACTIVE, 'starter', 'active', new Date());

    await handleCreditsRenew({});
    expect(await subGrants(ACTIVE)).toHaveLength(1);

    await handleCreditsRenew({});
    expect(await subGrants(ACTIVE)).toHaveLength(1);
  });

  it('does not grant to trialing, cancelled, or ended subscriptions', async () => {
    // Criterion 7. `trialing` is excluded by product decision: the trial grant
    // at onboarding is the whole of it.
    await seedSubscription(TRIALING, 'starter', 'trialing', new Date());
    await seedSubscription(CANCELLED, 'starter', 'cancelled', new Date());
    // Active status but a past ended_at — the `ended_at > now()` half of the
    // predicate, which a status-only filter would miss.
    await seedSubscription(ENDED, 'starter', 'active', new Date(Date.now() - 60 * 86_400_000), new Date(Date.now() - 86_400_000));

    await handleCreditsRenew({});

    expect(await subGrants(TRIALING)).toHaveLength(0);
    expect(await subGrants(CANCELLED)).toHaveLength(0);
    expect(await subGrants(ENDED)).toHaveLength(0);
  });

  it('grants once for a tenant carrying several active subscription rows', async () => {
    // upgradeHandler cancels and re-inserts with no lock, so a tenant can
    // transiently hold more than one `active` row. Without `distinct on` this
    // tenant is processed once per row — and because the two rows here are on
    // DIFFERENT plans, the grant function's own idempotency would not collapse
    // them: two different plans mean two different keys and two allowances.
    const older = new Date(Date.now() - 2 * 86_400_000);
    const newer = new Date(Date.now() - 86_400_000);
    await seedSubscription(DUPLICATE_ROWS, 'starter', 'active', older);
    await seedSubscription(DUPLICATE_ROWS, 'business', 'active', newer);

    await handleCreditsRenew({});

    const grants = await subGrants(DUPLICATE_ROWS);
    expect(grants).toHaveLength(1);
    // And it is the NEWEST row that wins — `order by started_at desc`.
    expect(grants[0].idempotency_key as string).toContain(':business:');
  });

  it('one tenant failing does not stop the rest of the batch', async () => {
    // Criterion 9. A subscription whose plan has no `credits` entitlement is
    // skipped inside the grant function; the batch must still reach the other
    // tenants.
    //
    // Creating that condition means removing a seeded plan_entitlements row,
    // which is SHARED state on this database — onboarding.credits.test.ts
    // asserts free == 200 credits, and vitest runs these files in one process
    // with fileParallelism disabled. Hence the try/finally: the row goes back
    // even if an assertion throws. (Found by writing it without the restore
    // first and watching the free entitlement vanish from the test database.)
    const [feature] = rowsOf(await db.execute(sql`select id from features where key = 'credits' limit 1`)) as unknown as { id: string }[];
    const [saved] = rowsOf(await db.execute(sql`
      select value_limit, unlimited, enabled from plan_entitlements
       where plan = 'free' and feature_id = ${feature.id}
    `)) as unknown as { value_limit: number | null; unlimited: boolean; enabled: boolean }[];

    try {
      await db.execute(sql`
        insert into subscriptions (tenant_id, plan, status, billing_cycle, started_at)
        values (${CANCELLED}, 'free', 'active', 'monthly', now())
      `);
      await db.execute(sql`
        delete from plan_entitlements where plan = 'free' and feature_id = ${feature.id}
      `);
      await seedSubscription(ACTIVE, 'starter', 'active', new Date());

      await handleCreditsRenew({});

      // The entitlement-less tenant granted nothing, and skipped rather than
      // granting zero.
      expect(await subGrants(CANCELLED)).toHaveLength(0);
      // The healthy tenant in the same batch still got its allowance.
      expect(await subGrants(ACTIVE)).toHaveLength(1);
    } finally {
      await db.execute(sql`
        insert into plan_entitlements (plan, feature_id, value_limit, unlimited, enabled)
        values ('free', ${feature.id}, ${saved?.value_limit ?? 200}, ${saved?.unlimited ?? false}, ${saved?.enabled ?? false})
        on conflict do nothing
      `);
    }
  });

  it('keeps invariant 3: balance equals the sum of live unexpired grant remainders', async () => {
    // Criterion 10, checked against the real account row rather than assumed
    // from the ledger.
    await seedSubscription(ACTIVE, 'starter', 'active', new Date());
    await handleCreditsRenew({});

    const [row] = rowsOf(await db.execute(sql`
      select a.balance_micro,
             coalesce((
               select sum(g.amount_micro - g.spent_micro) from credit_grants g
                where g.tenant_id = a.tenant_id
                  and (g.expires_at is null or g.expires_at > now())
             ), 0) as live
        from credit_accounts a
       where a.tenant_id = ${ACTIVE}
    `)) as unknown as { balance_micro: string; live: string }[];

    expect(BigInt(row.balance_micro)).toBe(BigInt(row.live));
    expect(BigInt(row.balance_micro)).toBeGreaterThan(0n);
  });
});

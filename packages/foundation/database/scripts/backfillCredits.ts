// One-off backfill: gives every existing tenant on an active/trialing
// subscription an opening credit grant, sized to their plan's `credits`
// entitlement. Must run before the monthly-quota-to-credits wiring ships
// (task 8+), or the first chat turn after that deploy raises
// INSUFFICIENT_CREDITS for every tenant that has never been granted.
//
// Idempotent per tenant: the ledger key is `backfill:{tenant_id}`, and
// migration 0071 scopes the ledger's idempotency check to
// `where tenant_id = p_tenant and idempotency_key = p_key`, so re-running
// this script is a clean replay, never a duplicate grant. This script also
// pre-checks the same key before calling grantCredits, purely so --dry-run
// and normal output can report "already backfilled" instead of "grant" on a
// second run - the actual duplicate-grant protection lives in spend_credits()
// itself, not here.
//
// Unlimited-plan tenants (enterprise) are skipped entirely. Giving them a
// synthetic grant would break the invariant that balance_micro equals the
// sum of live grant remainders (spend_credits() never consults "unlimited";
// it only knows grants).
//
// Run against DATABASE_URL explicitly on the command line - never rely on
// the ambient env, which apps/api/.env points at the shared Supabase dev
// database:
//   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @serverless-saas/database backfill:credits --dry-run

import postgres from 'postgres';
import { grantCredits, isUnlimited, MICRO_PER_CREDIT } from '../../credits/src/index';

const dryRun = process.argv.includes('--dry-run');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

function endOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

interface TenantRow {
  tenant_id: string;
  value_limit: number | null;
}

async function run() {
  const [creditsFeature] = await sql`select id from features where key = 'credits' limit 1`;
  if (!creditsFeature) {
    throw new Error("no 'credits' feature row found - check the plan seed (task 5) ran before this script");
  }

  // distinct on tenant_id: a tenant should have at most one active/trialing
  // subscription, but this doesn't assume it - it picks the most recently
  // started one deterministically rather than granting once per duplicate row.
  const tenants = await sql<TenantRow[]>`
    select distinct on (s.tenant_id)
           s.tenant_id, coalesce(tfo.value_limit, pe.value_limit) as value_limit
      from subscriptions s
      join features f on f.key = 'credits'
      left join plan_entitlements pe on pe.plan = s.plan::text and pe.feature_id = f.id
      left join tenant_feature_overrides tfo
             on tfo.tenant_id = s.tenant_id and tfo.feature_id = f.id
            and tfo.revoked_at is null and tfo.deleted_at is null
            and (tfo.expires_at is null or tfo.expires_at > now())
     where s.status in ('active', 'trialing')
     order by s.tenant_id, s.started_at desc nulls last
  `;

  if (dryRun) console.log('[DRY RUN] - no DB writes\n');

  let granted = 0;
  for (const t of tenants) {
    if (await isUnlimited(t.tenant_id)) {
      console.log(`skip ${t.tenant_id}: unlimited`);
      continue;
    }
    if (t.value_limit == null) {
      console.warn(`skip ${t.tenant_id}: no credits entitlement - check the plan seed`);
      continue;
    }

    const key = `backfill:${t.tenant_id}`;
    const [existing] = await sql`
      select 1 from credit_ledger
       where tenant_id = ${t.tenant_id} and idempotency_key = ${key}
       limit 1`;
    if (existing) {
      console.log(`skip ${t.tenant_id}: already backfilled`);
      continue;
    }

    const amountMicro = BigInt(t.value_limit) * MICRO_PER_CREDIT;
    console.log(`${dryRun ? 'would grant' : 'grant'} ${t.value_limit} credits to ${t.tenant_id}`);
    if (!dryRun) {
      // spend_credits() creates the credit_accounts row itself
      // (`insert ... on conflict do nothing`) under the same row lock it
      // takes to read the balance - no need to pre-create it here.
      await grantCredits({
        tenantId: t.tenant_id,
        amountMicro,
        key,
        grantType: 'subscription',
        expiresAt: endOfMonth(),
        reason: 'opening balance at credit system rollout',
      });
    }
    granted += 1;
  }

  console.log(`${dryRun ? 'would grant' : 'granted'} ${granted} of ${tenants.length} tenant(s)`);
  await sql.end();
  // grantCredits/isUnlimited go through @serverless-saas/database's shared
  // drizzle client (a pooled postgres.js connection, max 10, opened at import
  // time), which this script never owns a handle to and so cannot .end(). It
  // has no idle timeout, so without an explicit exit here the process hangs
  // after a successful run instead of returning to the shell.
  process.exit(0);
}

run().catch(async (err) => {
  console.error('backfill failed', err);
  await sql.end();
  process.exit(1);
});

import { sql } from 'drizzle-orm';
import { db, creditAccounts, nextCycleEnd } from '@serverless-saas/database';
import { grantCredits, isUnlimited, MICRO_PER_CREDIT } from '@serverless-saas/credits';

const TRIAL_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

/**
 * Reads the `credits` entitlement (value_limit) for a tenant's active or
 * trialing subscription. A tenant feature override wins over the plan
 * entitlement - same precedence as isUnlimited() and the credits backfill
 * script (packages/foundation/database/scripts/backfillCredits.ts), whose
 * query this mirrors. Returns null when there is no active/trialing
 * subscription, or the plan carries no `credits` entitlement row at all (a
 * plan seed gap - callers should treat that as "grant nothing", not "grant
 * zero").
 */
export async function planCreditAllowance(tenantId: string): Promise<number | null> {
  const result = await db.execute(sql`
    select coalesce(tfo.value_limit, pe.value_limit) as value_limit
      from subscriptions s
      join features f on f.key = 'credits'
      left join plan_entitlements pe on pe.plan = s.plan::text and pe.feature_id = f.id
      left join tenant_feature_overrides tfo
             on tfo.tenant_id = s.tenant_id and tfo.feature_id = f.id
            and tfo.revoked_at is null and tfo.deleted_at is null
            and (tfo.expires_at is null or tfo.expires_at > now())
     where s.tenant_id = ${tenantId} and s.status in ('active', 'trialing')
     order by s.started_at desc nulls last
     limit 1
  `);
  const [row] = rowsOf(result) as unknown as { value_limit: number | null }[];
  return row?.value_limit ?? null;
}

/**
 * Trial grant at tenant creation. Always creates the credit_accounts row
 * (even for an unlimited tenant - a tenant should always have an account row
 * to look up, whether or not it ever holds a grant). Unlimited tenants get no
 * grant at all: a synthetic infinite grant would break the invariant that
 * balance_micro equals the sum of live grant remainders (spend_credits()
 * never consults "unlimited"; it only knows grants).
 *
 * Idempotent per tenant via the `trial:{tenantId}` ledger key - a replayed
 * onboarding call (e.g. the existing-workspace guard in onboarding.ts
 * returning early on a retry) never double-grants, since spend_credits()
 * itself is the one enforcing the replay check.
 *
 * Never throws: a grant failure must not roll back tenant creation. The
 * credits backfill script (task 7) can repair a missing grant later.
 */
export async function grantTrialCredits(tenantId: string): Promise<void> {
  try {
    await db.insert(creditAccounts).values({ tenantId }).onConflictDoNothing();
  } catch (err) {
    console.error('[credits] failed to create credit account at onboarding for tenant', tenantId, err);
    return;
  }

  try {
    if (await isUnlimited(tenantId)) return;

    const credits = await planCreditAllowance(tenantId);
    if (credits == null) {
      console.warn('[credits] no credits entitlement found for tenant - skipping trial grant', tenantId);
      return;
    }

    await grantCredits({
      tenantId,
      amountMicro: BigInt(credits) * MICRO_PER_CREDIT,
      key: `trial:${tenantId}`,
      grantType: 'trial',
      expiresAt: new Date(Date.now() + TRIAL_PERIOD_MS),
      reason: 'signup trial credits',
    });
  } catch (err) {
    console.error('[credits] trial grant failed for tenant', tenantId, err);
  }
}

/**
 * Subscription-cycle grant, called from the subscription renewal path
 * (apps/api/src/routes/billing.ts's upgradeHandler, the only place in this
 * codebase that creates a new active subscription today - there is no
 * recurring-charge billing engine yet, see the TODOs in billing.ts).
 *
 * Keyed `sub:{subscriptionId}:{cycle}` so each cycle grants exactly once and
 * non-rollover falls out of expiry rather than needing a reset job. This
 * codebase creates a brand-new subscription row on every plan/cycle change
 * (upgradeHandler ends the old row and inserts a new one) rather than
 * recycling one subscription id across renewals, so `subscriptionId` is
 * always fresh here and `cycle` is always 0 - the key shape still matches the
 * spec and stays forward-compatible with a real recurring-billing engine
 * keying multiple cycles off one subscription id later.
 */
export async function grantSubscriptionCycleCredits(
  tenantId: string,
  subscriptionId: string,
  cycleStartedAt: Date,
  billingCycle: 'monthly' | 'annual',
  cycle = 0,
): Promise<void> {
  try {
    if (await isUnlimited(tenantId)) return;

    const credits = await planCreditAllowance(tenantId);
    if (credits == null) {
      console.warn('[credits] no credits entitlement found for tenant - skipping subscription grant', tenantId);
      return;
    }

    const expiresAt = nextCycleEnd(cycleStartedAt, billingCycle);

    await grantCredits({
      tenantId,
      amountMicro: BigInt(credits) * MICRO_PER_CREDIT,
      key: `sub:${subscriptionId}:${cycle}`,
      grantType: 'subscription',
      expiresAt,
      reason: 'subscription cycle credits',
    });
  } catch (err) {
    console.error('[credits] subscription cycle grant failed for tenant', tenantId, err);
  }
}

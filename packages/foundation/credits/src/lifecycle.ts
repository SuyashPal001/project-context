import { sql } from 'drizzle-orm';
import { db, creditAccounts, nextCycleEnd } from '@serverless-saas/database';
import { grantCredits } from './spend';
import { isUnlimited } from './read';
import { MICRO_PER_CREDIT } from './rate';

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
 * Looks up the `expires_at` of the tenant's most recent `subscription`-type
 * grant. Used only to decide whether a new upgrade call lands inside the
 * cycle that grant already covers - see grantSubscriptionCycleCredits below.
 */
async function lastSubscriptionGrantExpiry(tenantId: string): Promise<Date | null> {
  const result = await db.execute(sql`
    select expires_at
      from credit_grants
     where tenant_id = ${tenantId} and grant_type = 'subscription'
     order by created_at desc, id desc
     limit 1
  `);
  const [row] = rowsOf(result) as unknown as { expires_at: string | Date | null }[];
  if (!row?.expires_at) return null;
  const parsed = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Subscription-cycle grant. Two callers: the plan-change path
 * (apps/api/src/routes/billing.ts's upgradeHandler) and the nightly renewal
 * job (apps/worker/src/handlers/creditsRenew.ts).
 *
 * ---- Why `anchor` and `now` are separate parameters ----
 * They used to be one `startedAt` argument doing two different jobs: the
 * anniversary anchor for nextCycleEnd(), and the already-granted test
 * (`startedAt < lastExpiry`). upgradeHandler passes a fresh `new Date()`, so
 * for it the two coincide and the test reads "is now before the last grant's
 * expiry?" — which is correct, and is why the conflation went unnoticed.
 *
 * A scheduled renewal cannot pass `new Date()` as the anchor: the anniversary
 * has to be computed from the subscription's real started_at, or the billing
 * date drifts forward by however late the job runs. But that value is ALWAYS
 * earlier than the last grant's expiry once any grant exists, so
 * `stillInPriorCycle` would be permanently true, the function would reuse the
 * previous cycle's key, spend_credits() would replay it, and the job would
 * grant nothing — silently, forever, with a successful-looking log line.
 *
 * So the two roles are separate arguments. The already-granted question is
 * about *now*, not about when the subscription began. `now` defaults to the
 * current time, which keeps upgradeHandler's four-argument call and every key
 * it produces bit-identical to before the split — asserted by a test, because
 * that is the path R25/R27 hardened against an unbounded credit mint.
 *
 * It also makes multi-cycle behavior testable without mocking the clock:
 * pass successive dates.
 *
 * ---- Why this is keyed per (tenant, plan, cycle) and not per subscription row ----
 * upgradeHandler cancels the tenant's active subscription and inserts a
 * BRAND NEW row - with a fresh uuid - on every call, including a same-plan
 * retry or a monthly<->annual toggle. An idempotency key built from that
 * fresh subscription id (the original design) is fresh on every call by
 * construction, so spend_credits()'s replay check can never fire: anyone
 * with `billing:update` could mint an unbounded number of grants by calling
 * POST /billing/upgrade in a loop, or by toggling billing cycle back and
 * forth. There is also no payment gate yet (see billing.ts's TODO), so nothing
 * upstream of this function stops the loop either.
 *
 * The fix: never key on the subscription row at all. Key on
 * `sub:{tenantId}:{plan}:{cycleEndISO}`, where `cycleEndISO` identifies the
 * billing period rather than the row that happened to represent it:
 *   - If the tenant's most recent subscription-type grant is still live
 *     (`now` is before its `expires_at`), this call lands inside the
 *     SAME period that grant already covers. Reuse that `expires_at` as both
 *     the key's period identifier and this call's own `expiresAt` - so a
 *     same-plan retry, or a monthly<->annual toggle mid-period, produces the
 *     exact same key as the original grant and collapses via
 *     spend_credits()'s replay check. It also stops that toggle from
 *     quietly extending the credit window on every flip.
 *   - Otherwise (no prior subscription grant, or its cycle has genuinely
 *     ended) this is a fresh period: compute a new `expiresAt` via
 *     nextCycleEnd() from the `anchor`, relative to `now`. A real plan
 *     change lands here too - if it happens mid-cycle it still gets a full
 *     fresh allowance for the new plan (proration/clawback of the old grant
 *     is out of scope for v1; see the review notes), and if it happens in a
 *     new cycle it grants as a plain renewal would.
 *
 * `billingCycle` is deliberately NOT part of the key - only `plan` and the
 * resolved cycle end are. That is what makes toggling monthly<->annual with
 * the same plan collapse to one grant instead of two.
 *
 * ---- Why the key truncates expiresAt to a UTC date, not the full timestamp ----
 * The "still inside a prior cycle" branch above only fires once a grant from
 * an EARLIER call already exists to look up. On the very first call for a
 * cycle - a tenant's first-ever subscription grant, or the first call after
 * a genuine cycle boundary - there is nothing to reuse yet, so `expiresAt`
 * is computed fresh via nextCycleEnd(anchor, ...), and nextCycleEnd()
 * preserves the anchor's hours/minutes/seconds/milliseconds. For
 * upgradeHandler the anchor is a fresh `new Date()` per request
 * (billing.ts), so it varies by milliseconds. A burst of N concurrent calls
 * that all read lastSubscriptionGrantExpiry() before any of their grants has
 * committed each compute a slightly different `expiresAt` (different
 * milliseconds), hence a different key - the account-row lock inside
 * spend_credits() serializes them but can't collapse them, since the replay
 * check matches on the exact key string. That's up to N full allowances
 * instead of one, at exactly the two moments (first-ever grant, cycle
 * rollover) this key scheme exists to protect. Truncating the key's period
 * component to a UTC date (`YYYY-MM-DD`) closes this: one plan cannot have
 * two cycle ends on the same UTC date (nextCycleEnd() steps by whole months),
 * so no legitimate grant collapses that shouldn't, but every racer in the
 * same burst now computes the same key and converges on one grant. The full
 * `expiresAt` (with its real time-of-day) is still stored on the grant row
 * itself via `GrantInput.expiresAt` - only the *key* is date-truncated, so
 * expiry behavior is unaffected.
 */
export async function grantSubscriptionCycleCredits(
  tenantId: string,
  plan: string,
  billingCycle: 'monthly' | 'annual',
  anchor: Date,
  now: Date = new Date(),
): Promise<void> {
  try {
    if (await isUnlimited(tenantId)) return;

    const credits = await planCreditAllowance(tenantId);
    if (credits == null) {
      console.warn('[credits] no credits entitlement found for tenant - skipping subscription grant', tenantId);
      return;
    }

    const lastExpiry = await lastSubscriptionGrantExpiry(tenantId);
    const stillInPriorCycle = lastExpiry != null && now < lastExpiry;
    const expiresAt = stillInPriorCycle ? lastExpiry : nextCycleEnd(anchor, billingCycle, now);

    await grantCredits({
      tenantId,
      amountMicro: BigInt(credits) * MICRO_PER_CREDIT,
      key: `sub:${tenantId}:${plan}:${expiresAt.toISOString().slice(0, 10)}`,
      grantType: 'subscription',
      expiresAt,
      reason: 'subscription cycle credits',
    });
  } catch (err) {
    console.error('[credits] subscription cycle grant failed for tenant', tenantId, err);
  }
}

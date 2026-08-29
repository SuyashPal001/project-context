import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { grantSubscriptionCycleCredits } from '@serverless-saas/credits';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = result as { rows?: unknown };
  return ((r?.rows ?? result) ?? []) as Array<Record<string, unknown>>;
}

interface RenewalCandidate {
  tenant_id: string;
  plan: string;
  billing_cycle: 'monthly' | 'annual';
  started_at: string | Date;
}

/**
 * Nightly subscription renewal: grants every active tenant its plan allowance
 * once per billing cycle.
 *
 * ---- Why there is no rollover detection here ----
 * This handler does NOT work out whether a tenant's cycle has rolled over.
 * grantSubscriptionCycleCredits is already idempotent per
 * (tenant, plan, cycle-end-date), so this calls it for every active
 * subscription on every run: it grants on the first run of a new cycle and
 * replays harmlessly on the other ~29. The idempotency key does the work.
 *
 * That is the design, not laziness. A cycle-rollover check here would be a
 * SECOND implementation of the same cycle arithmetic that nextCycleEnd()
 * already does, and the two would eventually disagree — at which point the
 * job either grants twice in a cycle or skips one, both silently.
 *
 * ---- Why `trialing` is excluded ----
 * A trial is one-shot: the grant at onboarding is the whole of it, and it
 * expires at the trial's end. Renewals begin when a subscription becomes
 * `active`. The consequence, worth knowing: a tenant who stays in `trialing`
 * past their trial grant's expiry has a zero balance, and because the credit
 * pre-check fails closed they have no working chat or tasks until they
 * convert. That is the intended funnel behavior, but it means the
 * out-of-credits copy has to be honest rather than leaving them staring at a
 * silent failure.
 */
export async function handleCreditsRenew(_body: Record<string, unknown>): Promise<void> {
  // `distinct on` is defensive, not decorative: upgradeHandler cancels the
  // tenant's active subscription and inserts a new row with no lock, so a
  // tenant can transiently carry several `active` rows. Without this, such a
  // tenant would be processed once per row. The grant function's own
  // idempotency would collapse the duplicates for the same plan, but two rows
  // on DIFFERENT plans would each grant — so dedupe here, newest first, the
  // same way the credits backfill script does.
  const result = await db.execute(sql`
    select distinct on (s.tenant_id)
           s.tenant_id, s.plan, s.billing_cycle, s.started_at
      from subscriptions s
     where s.status = 'active'
       and (s.ended_at is null or s.ended_at > now())
     order by s.tenant_id, s.started_at desc
  `);
  const candidates = rowsOf(result) as unknown as RenewalCandidate[];

  console.log('[credits.renew] renewal starting', { candidates: candidates.length });

  const now = new Date();
  let completed = 0;
  let skipped = 0;

  for (const row of candidates) {
    try {
      const anchor = row.started_at instanceof Date ? row.started_at : new Date(row.started_at);
      if (Number.isNaN(anchor.getTime())) {
        // A subscription with no usable started_at has no anniversary to
        // compute, and guessing one would silently invent a billing date.
        console.error('[credits.renew] unusable started_at, skipping tenant', row.tenant_id, row.started_at);
        skipped += 1;
        continue;
      }

      // Unlimited tenants and tenants whose plan carries no `credits`
      // entitlement are skipped INSIDE the grant function, which already
      // handles both. Deliberately not filtered here — one place decides, and
      // it is the place that already does.
      await grantSubscriptionCycleCredits(row.tenant_id, row.plan, row.billing_cycle, anchor, now);
      completed += 1;
    } catch (err) {
      // Never let one tenant's failure block the rest of the batch.
      console.error('[credits.renew] renewal failed for tenant', row.tenant_id, err);
    }
  }

  // The expiry sweep's candidate set is "tenants with an unswept expired
  // grant" — usually small. This one is "every active tenant", which is the
  // whole customer base and grows monotonically. A sequential loop under a
  // 300s timeout is fine for hundreds and not for tens of thousands, and with
  // no progress signal it would silently drop the tail of the batch. Logging
  // both counts makes that ceiling visible before it is hit.
  console.log('[credits.renew] renewal finished', { candidates: candidates.length, completed, skipped });
}

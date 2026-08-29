# Subscription Renewal Grants — Design Spec

**Status:** ready for implementation plan
**Date:** 2026-08-29
**Depends on:** `docs/superpowers/specs/2026-08-28-credit-system-design.md` (the credit system; this spec assumes its invariants and does not restate them)

---

## 0. Goal and non-goals

**Goal.** Grant every metered tenant its plan allowance once per billing cycle, on
a schedule, so a balance refills when the cycle rolls over.

**The gap this closes.** The credit system as shipped grants credits at exactly two
moments: a trial grant at onboarding (`grantTrialCredits`) and a cycle grant on a
plan change (`grantSubscriptionCycleCredits`, called only from
`apps/api/src/routes/billing.ts`'s `upgradeHandler`). There is no recurring caller.
A tenant that signs up and never changes plan receives 200–10,000 credits once, they
expire at the cycle end, and the balance stays at zero permanently. Because the
credit pre-check fails closed, that is a hard stop on chat and tasks, not a degraded
experience — on roughly day 15 for a tenant on the default 14-day trial.

**Non-goals.**
- Payment collection, invoicing, dunning, or proration. This grants credits for an
  active subscription; whether that subscription was paid for is out of scope and
  remains `POST /billing/upgrade`'s unsolved problem.
- Changing the trial grant, the backfill, or any expiry behavior.
- Rollover of unspent credits. Non-rollover falls out of the existing expiry
  mechanism and is deliberate (credit-system spec §10.3).

---

## 1. The one real design problem

`grantSubscriptionCycleCredits(tenantId, plan, billingCycle, startedAt)` cannot be
called by a scheduled job as it stands, and the reason is subtle enough to state
precisely.

The function decides whether the current cycle has already been granted with:

```ts
const lastExpiry = await lastSubscriptionGrantExpiry(tenantId);
const stillInPriorCycle = lastExpiry != null && startedAt < lastExpiry;
const expiresAt = stillInPriorCycle ? lastExpiry : nextCycleEnd(startedAt, billingCycle);
```

`startedAt` is doing two different jobs:

1. **The anchor** for the anniversary — `nextCycleEnd(startedAt, cycle, now)` returns
   the next anniversary of `startedAt` strictly after `now`, day-of-month clamped
   (`packages/foundation/database/cycleEnd.ts:44-56`). A renewal job must pass the
   subscription's real `started_at` here, or the billing date drifts forward by
   however late the job runs.
2. **The already-granted test** — `startedAt < lastExpiry`.

Today's only caller passes a fresh `new Date()` (`billing.ts:94`), so for it these
two coincide and the test effectively reads *"is now before the last grant's
expiry?"*, which is correct.

A renewal job cannot do that. It must pass the subscription's original `started_at`
for the anchor — and that value is **always** earlier than the last grant's expiry
once any grant exists, so `stillInPriorCycle` is permanently true, the function
reuses the previous cycle's key, `spend_credits()` replays it, and **the job grants
nothing, silently, forever.**

### Resolution

Separate the two roles. The already-granted test is a question about *now*, not
about the subscription's start:

```ts
export async function grantSubscriptionCycleCredits(
  tenantId: string,
  plan: string,
  billingCycle: 'monthly' | 'annual',
  anchor: Date,          // subscription.started_at — the anniversary anchor
  now: Date = new Date(),  // the "which cycle are we in" clock
): Promise<void>
```

with `stillInPriorCycle = lastExpiry != null && now < lastExpiry`.

The existing caller passes `anchor = new Date()` and omits `now`, so `anchor === now`
and its behavior is bit-identical to today — including the key it produces. That
equivalence must be asserted by a test, not assumed: the upgrade path is the one
R25/R27 hardened against an unbounded credit mint, and nothing about this change may
weaken it.

**Everything else in the function stays.** The `sub:{tenantId}:{plan}:{YYYY-MM-DD}`
key (R27's date truncation, which closes a millisecond race), the unlimited skip,
the null-entitlement skip, the swallow-and-log posture, and `grantCredits` as the
only write path are all unchanged.

---

## 2. The job

A scheduled worker handler, modeled directly on Task 14's nightly expiry sweep —
same shape, same registration, same SAM pattern.

| | |
|---|---|
| Handler | `apps/worker/src/handlers/creditsRenew.ts` |
| Job type | `credits.renew`, registered in `apps/worker/src/router.ts` |
| SAM entry | `apps/worker/src/creditsRenewHandler.ts` (thin wrapper, mirrors `creditsExpireHandler.ts`) |
| SAM function | `CreditsRenewFunction`, `Schedule: rate(1 day)` |
| Timeout | 300s (see §5 — this loop is longer than the expiry sweep's) |

### Why it needs no rollover detection

`grantSubscriptionCycleCredits` is already idempotent per
`(tenant, plan, cycle-end-date)`. The job therefore does **not** compute whether a
cycle has rolled over. It calls the function for every active subscription on every
run; the function grants on the first run of a new cycle and replays harmlessly on
the other ~29. That is the whole design — the idempotency key does the work, and no
second implementation of cycle arithmetic exists to drift from the first.

### Candidate query

```sql
select distinct on (s.tenant_id)
       s.tenant_id, s.plan, s.billing_cycle, s.started_at
  from subscriptions s
 where s.status = 'active'
   and (s.ended_at is null or s.ended_at > now())
 order by s.tenant_id, s.started_at desc
```

`distinct on` with that ordering matches the defensive pattern the backfill script
already uses against duplicate subscription rows — a real hazard here, since
`upgradeHandler` cancels and re-inserts with no lock and can leave a tenant with
several `active` rows (recorded on the credit-system ledger).

**`trialing` is excluded deliberately** (product decision, 2026-08-29). A trial is
one-shot: the trial grant at onboarding is the whole of it, and it expires at the
trial's end. Renewals begin when a subscription becomes `active`. The consequence to
be aware of is that a tenant who stays in `trialing` past their trial grant's expiry
has a zero balance and, because the pre-check fails closed, no working chat or tasks
until they convert — which is the intended funnel behavior, but it means the product
copy around trial expiry has to be honest about it rather than leaving the tenant
staring at a silent failure.

### Loop

Per tenant: call `grantSubscriptionCycleCredits(tenantId, plan, billingCycle,
startedAt, now)`, catching per tenant so one failure cannot abort the batch. Log the
candidate count before and the completed count after — Task 14's reviewer's point
applies unchanged: a sequential loop under a Lambda timeout with no progress signal
silently drops the tail of the batch when the tenant count outgrows it.

Unlimited tenants and tenants with no `credits` entitlement are skipped **inside**
the grant function, which already handles both. The job does not filter for them —
one place decides, and it is the place that already does.

---

## 2a. The out-of-credits message

Whenever a tenant reaches zero — trial expired, cycle exhausted mid-month, or a plan
with no entitlement — the pre-check fails closed and chat and tasks stop. The UI must
say what to do about it. Today it does not.

**What exists now.** `CreditBalanceIndicator.tsx:44` renders "Add credits →" and
`ApproveCost.tsx:116` renders "Out of credits — add more →". Both link to
`/{tenant}/dashboard/billing`. That page's only action is `POST /billing/upgrade`,
which — for a tenant already on their plan for the current cycle — replays to the
same idempotency key and grants nothing (R25/R27). **So both links are dead ends: the
user is told to add credits, follows the link, and finds nothing that adds credits.**

**Required copy: "Upgrade your plan or buy credits."** Both halves need honest
backing, and only one has it:

| Action | State today |
|---|---|
| **Upgrade plan** | Works — a genuine plan change grants that plan's allowance for the cycle. Only useful to a tenant not already on the top plan. |
| **Buy credits** | **Does not exist.** `grant_type='purchase'` is in the schema; the payment webhook that would create such a grant is explicitly out of scope for v1 (credit-system spec §0). There is no top-up path for any tenant, on any plan. |

So the message must be conditional, not a fixed string:

- **Tenant below the top plan** → "Upgrade your plan for more credits", linking to
  billing. True today.
- **Tenant on the top metered plan, or already upgraded this cycle** → there is no
  self-serve action. The honest message is that they are out of credits until their
  cycle renews on `{date}` — the cycle end is known, so show it — with a contact
  route for a top-up. Do not link to billing; it does nothing for them.
- **Enterprise/unlimited** → unreachable; these tenants are never debited.

**The gap this exposes.** For a tenant on the top plan mid-cycle, the product has no
answer at all: no purchase path, and `POST /credits/grants` is unreachable because
`credits:create` is withheld from owner and admin (R23, correctly) and no ops route
exists that holds it. Until either the purchase webhook or an ops top-up route ships,
that tenant's only recourse is a human. The copy should reflect that rather than
implying a button exists.

This is UI and copy work sitting outside the renewal job itself, but the job is what
determines when tenants hit zero and the trial exclusion above creates one of the
cases — so it is specified here rather than lost.

---

## 3. Interaction with `POST /billing/upgrade`

Once this ships, the upgrade endpoint is no longer the only replenishment path, and
the payment gate can be closed independently. **Order matters:** closing the gate
first leaves tenants with no way to obtain credits at all.

Both callers use the same key, so a plan change and a renewal in the same cycle
collapse to one grant. That is the intended v1 semantics (R25) and needs no
coordination between them.

---

## 4. Acceptance criteria

1. A tenant with a monthly subscription and no plan changes receives exactly one
   subscription grant per cycle, indefinitely.
2. Running the job twice on the same day grants once. Running it every day for a
   whole cycle grants once.
3. Cycle ends do not drift: for a subscription started on the 15th, every grant
   expires on the 15th, and for one started Jan 31, cycle ends clamp to Feb 28/29,
   Mar 31, Apr 30 — verified across at least three consecutive cycles, not one.
4. An annual subscription is granted once per year, not once per month.
5. An unlimited tenant is never granted (no synthetic infinite grant — credit-system
   invariant 3).
6. A tenant whose plan has no `credits` entitlement is skipped and reported, not
   granted zero.
7. A cancelled, expired, or `trialing` subscription is not granted.
8. `POST /billing/upgrade`'s behavior is bit-identical to before the signature
   change, including the exact idempotency key it produces.
9. One tenant's failure does not abort the batch; the run reports candidates and
   completions.
10. `balance_micro` still equals the sum of live unexpired grant remainders after a
    renewal run (credit-system invariant 3).

---

## 5. Risks

**Batch size against the timeout.** The expiry sweep's candidate set is "tenants with
an unswept expired grant" — usually small. This job's is "every active tenant," which
is the whole customer base and grows monotonically. At 300s and a sequential loop
this is fine for hundreds of tenants and not for tens of thousands. Log both counts
from day one so the ceiling is visible before it is hit; batching or fan-out is a
later change, not a v1 requirement.

**A stale `dist/`.** The handler imports `@serverless-saas/credits` and
`@serverless-saas/database` through `dist/`. This repo's known failure mode is
`sam deploy` reporting "no changes" while shipping stale compiled JS — rebuild both
packages before deploying.

**Testing time, not the clock.** Criterion 3 requires several consecutive cycles.
The `now` parameter added in §1 is what makes that testable without waiting or
mocking the system clock — pass successive dates directly. That is a second reason
for the signature change, independent of the correctness one.

---

## 6. Out of scope, recorded

- The payment gate on `POST /billing/upgrade` (§3).
- Proration and clawback on a mid-cycle plan change — accepted for v1 (R25).
- Rollover of unspent credits.
- Notifying a tenant that their balance refilled, or that it did not because their
  plan carries no entitlement.

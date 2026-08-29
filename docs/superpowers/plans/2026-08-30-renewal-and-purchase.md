# Renewal grants + credit purchase — implementation plan

Written 2026-08-30. Implements the two specced-but-unbuilt phases:

- `docs/superpowers/specs/2026-08-29-subscription-renewal-grants.md`
- `docs/superpowers/specs/2026-08-29-credit-purchase.md`

They are a pair. Renewal decides *when* a tenant hits zero; purchase is the only
recourse once they do. Shipping either alone leaves a dead end — renewal alone means a
tenant on the top plan mid-cycle still has no way out, and purchase alone leaves every
metered tenant permanently at zero after their first cycle.

---

## Blocker: purchase needs a payment provider that does not exist yet

**No payment provider SDK is installed anywhere in this repo.** `grep` for stripe,
paddle or chargebee across every `package.json` returns nothing. The `billing_provider`
enum names all three; nothing implements any of them.

Building the purchase flow needs four things only the account owner can supply:

1. A **choice of provider** (the spec assumes Stripe — `amount_total` and session
   metadata are Stripe-shaped)
2. A **Stripe account** and its secret key
3. A **webhook signing secret**, seeded into Secrets Manager as
   `project-context/{env}/stripe` alongside the other 6 manual secrets
4. **Products and prices created in the Stripe dashboard** matching the pack table

Without them the webhook cannot be signature-verified, and the spec is explicit that
the signature check is the security boundary of the entire feature: a public,
unauthenticated endpoint that mints credits. A stubbed verifier is not a smaller
version of that — it is the vulnerability.

**So this plan ships renewal in full and stops purchase at the boundary of what can be
built honestly without an account.** What can be built: the packs table, the price
arithmetic, and the tests that pin them. What cannot: the checkout endpoint (needs the
SDK to create a session) and the webhook (needs the signing secret). Those are
specified below so the remaining work is mechanical once credentials exist.

---

## Part 1 — Renewal grants

### 1.1 Move `creditsLifecycle` into foundation

`grantSubscriptionCycleCredits` lives in `apps/api/src/lib/creditsLifecycle.ts`. The
renewal job runs in `apps/worker`, which **does not and should not depend on
`apps/api`**. Same shape as the problem the money-bug pass hit with `refundTask`.

The resolution is different this time, and simpler. `refundTask` needed a new product
package because task charge keys are agent-platform concepts. This file is the
opposite: trial grants, plan allowances and subscription cycles are generic SaaS
billing, with no knowledge of PM workflows or agents. It already imports nothing but
`@serverless-saas/database` and `@serverless-saas/credits`.

**Move it to `packages/foundation/credits/src/lifecycle.ts`** and export from the
package index. Three importers update (`onboarding.ts`, `billing.ts`, and the existing
test). No behavior changes in this step — a pure move, so that the next step's
signature change is the only thing a reviewer has to reason about.

### 1.2 Split `startedAt` into `anchor` and `now`

The spec's §1, restated because it is the whole reason this job did not already exist:

`startedAt` currently does two jobs — the anniversary anchor for `nextCycleEnd`, and
the already-granted test (`startedAt < lastExpiry`). Today's only caller passes a fresh
`new Date()`, so the two coincide and the test correctly reads "is now before the last
grant's expiry?".

A renewal job cannot do that. It must pass the subscription's real `started_at` as the
anchor or the billing date drifts forward by however late the job runs — and that value
is **always** earlier than the last grant's expiry once any grant exists. So
`stillInPriorCycle` is permanently true, the function reuses the previous cycle's key,
`spend_credits()` replays it, and **the job grants nothing, silently, forever.**

```ts
export async function grantSubscriptionCycleCredits(
  tenantId: string,
  plan: string,
  billingCycle: 'monthly' | 'annual',
  anchor: Date,            // subscription.started_at — the anniversary anchor
  now: Date = new Date(),  // the "which cycle are we in" clock
): Promise<void>
```

with `stillInPriorCycle = lastExpiry != null && now < lastExpiry`.

`nextCycleEnd(anchor, billingCycle, now)` already takes a `now` — it returns the next
anniversary of `anchor` strictly after `now`, day-of-month clamped. That third
parameter exists and is currently never passed.

**The upgrade path must stay bit-identical.** It passes `anchor = new Date()` and omits
`now`, so `anchor === now` and every key it produces is unchanged. This is the path
R25/R27 hardened against an unbounded credit mint; nothing here may weaken it. Asserted
by a test that pins the exact key string, not assumed.

### 1.3 The job

Modeled directly on Task 14's expiry sweep — same shape, same registration, same SAM
pattern.

| | |
|---|---|
| Handler | `apps/worker/src/handlers/creditsRenew.ts` |
| Job type | `credits.renew`, registered in `apps/worker/src/router.ts` |
| SAM entry | `apps/worker/src/creditsRenewHandler.ts` |
| SAM function | `CreditsRenewFunction`, `Schedule: rate(1 day)` |
| Timeout | 300s — this candidate set is every active tenant, not a handful |

**No rollover detection.** `grantSubscriptionCycleCredits` is already idempotent per
`(tenant, plan, cycle-end-date)`. The job calls it for every active subscription on
every run; it grants on the first run of a new cycle and replays harmlessly on the
other ~29. The idempotency key does the work, so no second implementation of cycle
arithmetic exists to drift from the first.

Candidate query:

```sql
select distinct on (s.tenant_id)
       s.tenant_id, s.plan, s.billing_cycle, s.started_at
  from subscriptions s
 where s.status = 'active'
   and (s.ended_at is null or s.ended_at > now())
 order by s.tenant_id, s.started_at desc
```

`distinct on` is defensive, not decorative: `upgradeHandler` cancels and re-inserts
with no lock and can leave a tenant several `active` rows.

`trialing` is excluded deliberately (product decision, 2026-08-29). A trial is
one-shot. The consequence is that a tenant who stays in `trialing` past their trial
grant's expiry has a zero balance and no working chat — intended funnel behavior, but
it makes the out-of-credits copy load-bearing.

Per tenant, catch individually so one failure cannot abort the batch. Log candidates
before and completions after: a sequential loop under a Lambda timeout with no progress
signal silently drops the tail of the batch once the tenant count outgrows it.

Unlimited tenants and tenants with no `credits` entitlement are skipped **inside** the
grant function, which already handles both. The job does not filter for them — one
place decides, and it is the place that already does.

### 1.4 Tests

Every test observed to fail against the unfixed code before the fix lands. Specifically:

- **The bug itself.** A renewal call passing a real `started_at` as anchor grants for
  the current cycle. Against the old signature this grants nothing — that is the
  assertion that must fail first, or the whole change is unproven.
- **Bit-identical upgrade path.** The exact idempotency key `upgradeHandler` produces
  is unchanged. Pin the string.
- **No drift across three consecutive cycles**, including a Jan-31 anchor clamping to
  Feb 28/29, Mar 31, Apr 30. This is what the `now` parameter makes testable without
  mocking the clock.
- **Annual grants once per year, not monthly.**
- **Idempotent**: running the job twice on one day grants once; every day for a whole
  cycle grants once.
- **Skips**: unlimited, no-entitlement, cancelled, `trialing`.
- **Invariant 3** holds after a renewal run.

---

## Part 2 — Credit purchase

### 2.1 What ships now: the pack table

Three rows, seeded, at the 2¢ sale price. A constant is tempting for three rows, but
the price list is the thing ops will want to edit without a deploy, and it needs to be
joinable from a `payments` row later.

```
starter    500 credits    $10
standard   1,250 credits  $25
bulk       5,000 credits  $100
```

**The 2× markup lives in the sale price, never in `credit_rates`.** That table converts
usage into credits; doubling it would silently halve what every plan allowance buys —
2,000 credits would stop being $20 of work. Credits stay an honest unit of consumption
(1 credit = 1¢ of inference, always) and the margin is one visible number.

Checkout takes a **pack id, never a credit count**. That closes the obvious attack: a
client asking for 10,000,000 credits at a price it also supplies.

### 2.2 What is blocked: checkout and webhook

Both specified in the spec's §2.1 and §2.2 and not restated here. The three rules that
matter most, recorded so they survive the gap between this plan and the credentials:

1. **Verify the signature before reading anything else.**
2. **Identity from metadata, value from the payment.** `tenantId` from session metadata
   we set at checkout; the credit amount from the *verified event's* `amount_total`
   divided by the sale price — never from metadata.
3. **Reject an event whose amount matches no known pack.** A partially-paid or
   oddly-valued event is a support case, not a grant.

Idempotency needs no dedupe table: `purchase:{session_id}` is already the key, and
`spend_credits()`'s per-tenant replay check (migration 0071) makes a retry return the
current balance and write nothing. Respond 200 on a duplicate — a 4xx or 5xx makes the
provider retry for days.

### 2.3 Expiry: 12 months, and the FIFO consequence is the point

Not never (an unbounded balance-sheet liability and an unbounded `credit_grants`
table). Not cycle end (buy on the 28th, lose it on the 1st, get a refund request and a
bad review).

`spend_credits()` orders grants `expires_at nulls last, created_at`, so a plan grant
expiring in ~30 days is always consumed before a purchased grant expiring in 12 months.
The monthly allowance burns down first and the paid balance is the reserve —
automatically, with no branch anywhere deciding it.

---

## Order

1. Move `creditsLifecycle` to foundation (pure move, no behavior change)
2. Split the signature, with the bit-identical-upgrade test
3. The renewal job, handler, router, SAM wiring
4. Pack table + seed
5. **Stop.** Checkout and webhook need Stripe credentials.

Deploy order, per the rule the money-bug pass established: any migration adding a
column that handlers select unconditionally lands **before** the Lambdas.

Note `.gitignore:52` is `*.md`, so doc commits need `git add -f`.

# Buying Credits — Design Spec

**Status:** ready for implementation plan
**Date:** 2026-08-29
**Depends on:** `docs/superpowers/specs/2026-08-28-credit-system-design.md` (assumes its invariants; does not restate them) and `2026-08-29-subscription-renewal-grants.md` (§2a, the out-of-credits message this gives a real destination)

---

## 0. Goal and non-goals

**Goal.** A tenant that runs out of credits can buy more, self-serve, and have them
land in their balance without a human involved.

**Why it is on the critical path.** With ops-side granting deferred to the mission
control portal, this is the *only* recourse for a tenant at zero. A tenant on the top
plan mid-cycle cannot upgrade their way out, and nobody can top them up by hand
(`credits:create` is withheld from owner and admin by design — R23 — and no ops route
holds it). Until this ships, "out of credits" means "blocked until the cycle rolls
over." It must land before or with the credit system going live.

**Non-goals for v1.**
- Comping credits, extending a trial, or correcting a billing mistake — mission
  control, later.
- Auto-recharge / top-up-when-low.
- Volume discount tiers. One price per credit; tiers are a pricing change, not a
  code change, once the pack table exists.
- Invoicing, dunning, tax handling beyond what the provider does for us.

---

## 1. Two product decisions, recorded

**Price: 2× cost.** A credit costs 1 US cent of inference (`credit_rates` seeded at
cost — credit-system spec §3) and **sells for 2 US cents**.

**The markup does NOT go in `credit_rates`.** That table converts usage into credits,
and doubling it would silently halve what every plan allowance buys — 2,000 credits
would stop being $20 of work. Instead: credits stay an honest unit of consumption
(1 credit = 1¢ of inference, always), and the margin lives in the **sale price**. A
customer pays 2¢ for a credit that buys 1¢ of work.

Consequences worth stating plainly:
- Plan allowances keep their current meaning and need no re-seeding.
- Gross margin on purchased credits is 50%, visible in one number, changeable without
  touching the metering path.
- Plan credits are effectively sold at whatever the plan price implies; purchased
  credits are sold at exactly 2¢. Those two need not match, and won't.

**Expiry: 12 months from purchase.** Not never — an unbounded liability on the balance
sheet and an unbounded `credit_grants` table. Not cycle end — someone who buys on the
28th and loses it on the 1st files a refund request and a bad review.

**The FIFO consequence is the point, not a side effect.** `spend_credits()` orders
grants `expires_at nulls last, created_at` (credit-system spec §4), so a plan grant
expiring in ~30 days is always consumed before a purchased grant expiring in 12
months. The monthly allowance burns down first and the paid balance is the reserve,
automatically, with no branch anywhere deciding it.

---

## 2. The flow

```
tenant → POST /credits/checkout        (authenticated, tenant-scoped)
       → provider hosted checkout page (we never see card details)
       → provider → POST /integrations/billing/{provider}/webhook   (public, signed)
                  → grantCredits(... grant_type='purchase' ...)
```

Three pieces: a checkout-session endpoint, a public webhook, and a record of the sale.

### 2.1 `POST /credits/checkout`

Mounted with the other secure credit routes in `apps/api/src/routes/credits.ts`,
below the full middleware chain (credit-system spec §9 — a route mounted higher runs
without tenant resolution while looking guarded).

- **Permission: `('billing', 'update')`** — the same one `POST /billing/upgrade`
  uses. Deliberately *not* `credits:create`: this endpoint mints nothing. It creates
  a provider session and returns a redirect URL. Everything that moves credits happens
  in the webhook, after money has actually changed hands.
- Body: which pack (see §2.4). Never a raw credit amount from the client.
- `tenantId` comes from `c.get('requestContext')`, never from the body.
- **Rejects unlimited tenants.** They are never debited, so credits would be inert.
- Creates the provider session with our own metadata: `tenantId`, `packId`, and the
  actor who initiated it.
- Returns `{ checkoutUrl }`.

### 2.2 The webhook

A new public route, mounted on `publicApi` beside the existing webhook routes
(`app.ts:97-98`) — **not** on the secure `api`, because the provider carries no
tenant JWT.

Copy the shape of `apps/api/src/routes/integrations.github.webhook.ts`:
`createHmac` + `timingSafeEqual` against the raw body, 401 on mismatch, secret from
Secrets Manager. Provider specifics differ (Stripe signs with a timestamped scheme and
requires the *unparsed* body), but the discipline is identical and already in the repo.

**This route is the security boundary of the whole feature. It is a public,
unauthenticated endpoint that mints credits.** Three rules:

1. **Verify the signature before reading anything else.** No signature, no work.
2. **Identity from metadata, value from the payment.** Take `tenantId` from the
   session metadata we set at §2.1 — the provider echoes it back and it was written
   by an authenticated request. Take the credit amount from the **verified event's
   `amount_total`**, divided by the 2¢ sale price. Never from metadata. If the two
   ever disagree, the money is authoritative and the discrepancy is logged.
3. **Reject an event whose amount does not correspond to a known pack.** A
   partially-paid or oddly-valued event is a support case, not a grant.

On a verified purchase event:

```ts
await grantCredits({
  tenantId,                                   // from session metadata
  amountMicro: creditsFromAmountPaid * MICRO_PER_CREDIT,
  key: `purchase:${session.id}`,              // credit-system spec §5
  grantType: 'purchase',
  expiresAt: addUtcMonthsClamped(new Date(), 12),
  actorId, actorType: 'human',                // from metadata, for attribution
  reason: 'credit purchase',
});
```

`grantCredits` is the only write path, as everywhere else. `spend_credits()` is the
sole writer of `balance_micro`.

**Idempotency.** Providers retry webhooks — Stripe retries for up to three days.
`purchase:{session_id}` is already the key the credit system specifies for this, and
the per-tenant replay check inside `spend_credits()` (migration 0071) makes a repeat
delivery return the current balance and write nothing. This is the mechanism, not a
best effort: the webhook needs no dedupe table of its own.

**Respond 200 on a duplicate.** A 4xx or 5xx makes the provider retry forever.

### 2.3 The sale record

The billing schema already models this — `invoices`, `payments`, `paymentMethods`,
`billingProviders`, each with an `externalId` for the provider's identifier
(`packages/foundation/database/schema/billing.ts`). Nothing is wired to it.

Write a `payments` row in the same webhook, carrying the provider id, the amount, and
the tenant. Two reasons: the credit ledger records *credits*, not *money*, and the two
need to be reconcilable when someone asks why a balance moved; and a chargeback later
needs the payment to point at.

### 2.4 Packs

A small seeded table (or a constant, if a table is over-engineering for three rows):
an id, a display name, a credit count, and a price in cents at 2¢/credit.

```
starter   500 credits    $10
standard  1,250 credits  $25
bulk      5,000 credits  $100
```

The checkout endpoint takes a pack id, never a credit count. That closes the obvious
attack — a client asking for 10,000,000 credits at a price it also supplies — and it
means the price list lives in one place that ops can edit.

---

## 3. What the tenant sees

This gives §2a of the renewal spec its missing destination. Once this ships:

- **Below the top plan, out of credits** → "Upgrade your plan **or buy credits**."
  Both work.
- **Top plan, out of credits mid-cycle** → "Buy credits" — which is now a real
  action rather than the dead end it is today.
- The existing "Add credits →" links in `CreditBalanceIndicator.tsx:44` and
  `ApproveCost.tsx:116` point at `/dashboard/billing` and currently do nothing. They
  should point at the purchase flow.

---

## 4. Acceptance criteria

1. A completed purchase grants exactly the credits paid for, at 2¢ each, expiring 12
   months out.
2. A replayed webhook (same session id) grants once and returns 200.
3. An unsigned or wrongly-signed webhook grants nothing and returns 401.
4. A webhook whose `amount_total` does not match a known pack grants nothing and is
   logged for a human.
5. `tenantId` is never read from the webhook request body — only from session metadata
   set by an authenticated `POST /credits/checkout`.
6. `POST /credits/checkout` cannot itself move credits: no path through it reaches
   `spend_credits()`.
7. An unlimited tenant cannot buy credits.
8. A tenant with plan credits and purchased credits spends the plan credits first
   (FIFO by expiry), verified against a real balance.
9. `balance_micro` equals the sum of live unexpired grant remainders after a purchase
   (credit-system invariant 3).
10. A `payments` row exists for every granted purchase, reconcilable to the ledger row
    by the provider's session id.

---

## 5. Risks

**Spend-then-chargeback.** A customer buys credits, spends them, then disputes the
charge. The credits are gone and the money is clawed back. There is no mitigation in
v1 — a refund webhook could zero a *remaining* balance, but not recover what was
consumed. Exposure is bounded by pack size. Worth knowing before setting the bulk pack
price, and worth revisiting if it ever happens twice.

**The webhook is the whole security surface.** Everything else in the credit system
sits behind tenant auth; this one endpoint is public and mints credits. It deserves
the most careful review of anything in this spec, and its signature check should be
the first thing anyone re-reads when touching it.

**Provider choice is not made here.** The schema's enum allows stripe, paddle or
chargebee. The flow above is provider-shaped but not provider-specific; picking one is
the implementation plan's first task, and Stripe is the assumption baked into the
`amount_total` and session-metadata references.

### Provider options — recorded 2026-08-30, decision still open

**Stripe is blocked.** Obtaining a Stripe account has proved difficult for this entity.
Everything below follows from that.

**Google Pay is not an option, and neither is Link.** Both are payment *methods* — a
wallet that hands over a card — not processors. They settle nothing, create no charges
and fire no webhooks; they sit on top of a processor that does. Recorded explicitly
because it is a natural assumption and costs a day to discover.

**The category that solves this is a Merchant of Record (MoR).** An MoR becomes the
legal seller: it takes the card, handles VAT/GST in every jurisdiction, absorbs the
compliance, and pays the vendor. For an Indian entity selling software internationally
that removes the need to be an approved merchant anywhere, and sidesteps per-transaction
inward-remittance paperwork. It is the standard path for this shape of business.

| Option | Notes |
|---|---|
| **Paddle** — the recommendation | MoR, accepts Indian sellers, well documented, and **already in the `billing_provider` enum**, so switching to it needs no migration. Fees ~5% against Stripe's ~3%; that difference is the price of not being the merchant, and it is affordable at a 50% margin. Paddle is selective about what it will sell, though a real B2B SaaS is their target. |
| **Lemon Squeezy** | MoR with the simplest onboarding, but Stripe acquired them — onboarding may route back through Stripe and defeat the purpose. Verify before investing. |
| **Dodo Payments / Polar** | Newer MoRs; Dodo is Indian-founded and built for exactly this problem. Less proven, and their webhook signature schemes would need to be read from current docs rather than assumed. |
| **Razorpay** | Easiest to obtain, but **not** an MoR: the tenant's seller stays the merchant, international acceptance needs separate approval, and tax filing stays in-house. Sensible only if buyers are mostly Indian. |

**Switching costs little.** The pack table, the pricing arithmetic, the grant path and
the idempotency key are all provider-agnostic. Only two pieces are provider-specific —
creating a checkout session, and verifying the webhook signature — roughly 150 lines.
The contract in §2.2 (verify signature first; identity from metadata; value from the
verified amount) holds for any provider.

**Verify current terms before committing.** Payment-provider onboarding requirements
change often, and this table reflects knowledge as of mid-2026.

**A smaller unblock exists, if self-serve is not urgent.** An ops route holding
`credits:create` would let a human top a tenant up after taking payment by any means —
bank transfer, payment link, invoice. That is far less work than a payment integration
and is provider-independent. It was declined on 2026-08-29 in favour of self-serve
buying; recorded again here only because Stripe being unobtainable changes the premise
that decision rested on. Still the user's call.

**Test-mode money.** The webhook must distinguish live from test events, or a test
purchase in a shared environment grants real credits. The provider flags this on the
event; check it explicitly rather than relying on separate keys.

---

## 6. Out of scope, recorded

- Refund and chargeback handling beyond the risk noted above.
- Auto-recharge, spending limits, or budget alerts.
- Comping / manual grants — mission control, later. Note that until that exists there
  is still no way to correct a billing mistake in a tenant's favour.
- Multi-currency. One currency, whatever the provider account is configured for.

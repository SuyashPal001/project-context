# Credit System - Design Spec

**Status:** ready for implementation plan
**Date:** 2026-08-28
**Stack:** pnpm monorepo, Hono/Lambda API, Mastra orchestrator on GCP VM, Supabase Postgres + Drizzle

Supersedes the corrupted draft of the same date. Section 3's prices were lost in
that file and are re-derived here from `apps/agent-orchestrator/src/mastra/cost.ts`.

---

## 0. Goal and non-goals

**Goal.** A tenant-scoped credit system: a ledger of grants and debits, priced by an
ops-editable rate table, enforced on every metered action. Metered actions are the four
the product owner selected: LLM tokens, messages, tool calls, skill runs. Grants come
from a plan allowance, a trial, an ops adjustment, or (later) a purchase.

**Also in scope:** closing the metering hole. Chat SSE turns currently write no
`usage_records` row at all - `chatStream.ts` computes tokens, calls `persistCost`, and
stops - so `checkMessageQuota` today counts task runs only. Chat becomes metered.

**Non-goals for v1.**
- Server-side reservations (`RESERVED -> CONFIRMED/EXPIRED`). The estimate is a preview;
  the authoritative check happens at submit.
- Payment provider integration. `grant_type='purchase'` exists in the schema and the
  webhook that calls it does not; ops top-up covers v1.
- Per-step metering inside a Mastra workflow run. See section 6.
- Replacing `usage_records` or `token_costs`. Both stay as the raw event log.

**Assumption flagged for review:** 1 credit = 1 US cent, so the seeded rates in section 3
are at cost with no markup. Change the seed, not the code, to introduce margin.

---

## 1. Invariants

1. **Two layers, never mixed.** `usage_records` and `token_costs` are the raw resource
   log (untouched). `credit_ledger` is the credit layer. `credit_rates` is the only
   conversion between them.
2. **Credits are tenant-owned; actors are attribution.** Balance lives on
   `credit_accounts(tenant_id)`. Ledger rows carry `actor_id` + `actor_type`, matching
   `usage_records` - autonomous agents spend with no user, so a `user_id` column would be
   null exactly where attribution matters most.
3. **`balance_micro` always equals the sum of live, unexpired grant remainders.** Every
   other rule in this spec exists to preserve this one. Two consequences that the earlier
   draft got wrong:
   - a refund **creates a new grant**; it never decrements `spent_micro` on an old one
     (that grant may have expired, which would put credits in the balance that FIFO can
     never find);
   - expired grants are swept **at spend time under the account lock**, not only by a
     nightly cron (otherwise the balance overstates what is spendable between expiry and
     the sweep, and an estimate says "sufficient" for a charge that then fails).
4. **The lock lives in Postgres.** All balance mutation goes through `spend_credits()`.
   Nothing else writes `credit_accounts.balance_micro`. One statement is one implicit
   transaction, which is what makes it safe over the Supabase transaction pooler (6543) -
   no `BEGIN`/`COMMIT` spanning two backends, no client checkout.
5. **Idempotency: one key, N rows.** A spend that drains grant A then grant B writes one
   ledger row per slice under one `idempotency_key`, distinguished by `seq`. The replay
   check runs *after* the account lock so concurrent duplicates serialize into a clean
   replay; `unique(tenant_id, idempotency_key, seq)` is the backstop, not the mechanism.
   **The key namespace is per-tenant**, not global: ops top-up keys are operator-supplied
   and free-form (section 5), so the same string will legitimately be reused across
   tenants, and a global namespace would silently replay tenant B's grant off tenant A's
   ledger row. Every replay lookup filters on `tenant_id` as well as the key.
6. **The estimate never locks and never reserves.** It reads current rates and current
   balance. The real check is inside `spend_credits()`.
7. **Rate edits are versioned and immutable.** Editing a price inserts a new
   `credit_rates` row with `version + 1` and sets `is_active = false` on the old one.
   Ledger rows stamp `rate_id` and `rate_version`, so a debit stays reproducible after a
   price change.
8. **Integer math only.** 1 credit = 1,000,000 micro (`MICRO_PER_CREDIT`). All amounts are
   `bigint` micro. No floats. Rounding is always up, at one place (`rate.ts`).

---

## 2. Schema

`packages/foundation/database/schema/credits.ts`, exported from `schema/index.ts`.
Migration via `pnpm exec drizzle-kit generate` in `packages/foundation/database` - no
hand-typed table DDL.

Three repo constraints the earlier draft violated:
- `tenants` is in `./tenancy`, not `./tenants`.
- `actorTypeEnum` already exists in `./billing`. Import it; redeclaring emits a duplicate
  `CREATE TYPE`.
- **`job_id` carries no foreign key.** The task table is `agent_tasks` in
  `products/agent-platform/packages/schema/agents.ts`, i.e. product schema. A foundation
  table must not reference it (CLAUDE.md, foundation/product rule). `job_type`
  disambiguates instead.

```ts
import {
  pgTable, uuid, bigint, text, timestamp, jsonb, boolean, integer,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenancy';
import { actorTypeEnum } from './billing';

export const creditAccounts = pgTable('credit_accounts', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  balanceMicro: bigint('balance_micro', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditRates = pgTable('credit_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  resourceType: text('resource_type', {
    enum: ['llm_tokens', 'message', 'tool_call', 'skill_run'],
  }).notNull(),
  // model name for llm_tokens; tool name for tool_call; '*' for a catch-all row
  subject: text('subject').notNull().default('*'),
  version: integer('version').notNull().default(1),
  pricingSchema: jsonb('pricing_schema').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('credit_rates_subject_version_uq').on(t.resourceType, t.subject, t.version),
  index('credit_rates_active_idx').on(t.resourceType, t.subject).where(sql`is_active`),
]);

export const creditGrants = pgTable('credit_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => creditAccounts.tenantId),
  actorId: uuid('actor_id'),                       // who created it; null = system
  actorType: actorTypeEnum('actor_type'),
  grantType: text('grant_type', {
    enum: ['purchase', 'subscription', 'trial', 'admin', 'refund'],
  }).notNull(),
  amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),
  spentMicro: bigint('spent_micro', { mode: 'bigint' }).notNull().default(0n),
  expiresAt: timestamp('expires_at', { withTimezone: true }),   // null = never
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata'),
}, (t) => [
  index('credit_grants_fifo_idx').on(t.tenantId, t.expiresAt, t.createdAt),
]);

export const creditLedger = pgTable('credit_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => creditAccounts.tenantId),
  actorId: uuid('actor_id'),
  actorType: actorTypeEnum('actor_type'),
  grantId: uuid('grant_id').references(() => creditGrants.id),  // null on adjust rows
  kind: text('kind', {
    enum: ['grant', 'debit', 'refund', 'settle', 'expiry', 'adjust'],
  }).notNull(),
  amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),  // signed
  balanceAfterMicro: bigint('balance_after_micro', { mode: 'bigint' }).notNull(),
  jobId: uuid('job_id'),                           // no FK - see note above
  jobType: text('job_type'),                       // 'agent_task' | 'document' | 'chat_message'
  rateId: uuid('rate_id').references(() => creditRates.id),
  rateVersion: integer('rate_version'),
  idempotencyKey: text('idempotency_key').notNull(),
  seq: integer('seq').notNull().default(0),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('credit_ledger_tenant_key_seq_uq').on(t.tenantId, t.idempotencyKey, t.seq),
  index('credit_ledger_tenant_time_idx').on(t.tenantId, t.createdAt),
]);
```

**Serialization note.** Drizzle's `mode: 'bigint'` returns a JS `BigInt`, which
`JSON.stringify` throws on. Every route in section 9 must serialize micro amounts as
strings. Do not send a pre-divided `credits` float - divide client-side (invariant 8).

---

## 3. Rates

One active row per `(resource_type, subject)`. Cost resolution lives in exactly one
place: `packages/foundation/credits/rate.ts`.

```jsonc
// llm_tokens - priced per million tokens so every seeded value stays an integer
{ "per_million_tokens_micro": { "input": 15000000, "output": 60000000 } }

// message - flat per assistant turn, on top of tokens
{ "per_message_micro": 0 }

// tool_call - flat per invocation; subject = tool name, '*' = catch-all
{ "per_call_micro": 0 }

// skill_run - flat per skill execution
{ "per_run_micro": 0 }
```

`cost_micro = ceil(tokens * per_million_tokens_micro / 1_000_000)`, summed over input and
output. Rounding up happens once, in `rate.ts`, after summing - never per component.

**Seed (version 1)**, derived from the `PRICING` map in
`apps/agent-orchestrator/src/mastra/cost.ts:5` at 1 credit = 1 US cent:

| resource_type | subject | input (micro / 1M tok) | output (micro / 1M tok) | USD / 1M tok |
|---|---|---|---|---|
| llm_tokens | gemini-2.5-flash | 15,000,000 | 60,000,000 | 0.15 / 0.60 |
| llm_tokens | gemini-2.5-flash-lite | 7,500,000 | 30,000,000 | 0.075 / 0.30 |
| llm_tokens | gemini-2.5-pro | 125,000,000 | 500,000,000 | 1.25 / 5.00 |
| llm_tokens | ollama/* | 0 | 0 | self-hosted |
| llm_tokens | * (fallback) | 15,000,000 | 60,000,000 | flash, matching today's fallback |
| message | * | 0 | - | |
| tool_call | * | 0 | - | |
| skill_run | * | 0 | - | |

The three flat rates seed at zero deliberately: metering and pricing ship separately, so
day one changes no one's balance and ops can price messages, tools, and skills later
without a deploy. `min_charge_micro` from the earlier draft is dropped - if it comes
back, it belongs in `rate.ts` before the sign is chosen, or the settle path can refund
below the floor.

---

## 4. `spend_credits()`

Hand-written migration next to the generated one (Drizzle does not model functions).
Called by the orchestrator through its existing raw `pg` pool and by API/worker through
`db.execute(sql\`select spend_credits(...)\`)`.

```sql
create or replace function spend_credits(
  p_tenant       uuid,
  p_amount_micro bigint,     -- negative = debit, positive = credit
  p_key          text,
  p_kind         text,       -- 'debit' | 'refund' | 'settle' | 'grant' | 'adjust'
  p_actor        uuid,
  p_actor_type   actor_type,
  p_rate_id      uuid    default null,
  p_rate_version integer default null,
  p_job_id       uuid    default null,
  p_job_type     text    default null,
  p_grant_type   text    default null,        -- positive amounts only
  p_expires_at   timestamptz default null,    -- positive amounts only
  p_reason       text    default null
) returns bigint
language plpgsql
as $$
declare
  v_balance   bigint;
  v_remaining bigint;
  v_take      bigint;
  v_seq       integer := 0;
  v_grant     record;
  v_grant_id  uuid;
  v_dummy     bigint;
begin
  insert into credit_accounts (tenant_id) values (p_tenant) on conflict do nothing;

  select balance_micro into v_balance
    from credit_accounts
   where tenant_id = p_tenant
     for update;

  -- Replay check AFTER the lock: concurrent duplicates serialize into a clean
  -- replay instead of one of them dying on the unique index.
  select balance_after_micro into v_dummy
    from credit_ledger
   where tenant_id = p_tenant
     and idempotency_key = p_key
   order by seq desc
   limit 1;
  if found then
    return v_balance;
  end if;

  -- Lazy expiry under the same lock (invariant 3). Keeps balance_micro equal to
  -- the sum of live grant remainders at all times, not just after the cron.
  for v_grant in
    select * from credit_grants
     where tenant_id = p_tenant
       and expires_at is not null
       and expires_at <= now()
       and spent_micro < amount_micro
     order by created_at
     for update
  loop
    v_take := v_grant.amount_micro - v_grant.spent_micro;
    update credit_grants set spent_micro = amount_micro where id = v_grant.id;
    v_balance := v_balance - v_take;
    insert into credit_ledger (tenant_id, grant_id, kind, amount_micro,
                               balance_after_micro, idempotency_key, seq, reason)
      values (p_tenant, v_grant.id, 'expiry', -v_take, v_balance,
              'expiry:' || v_grant.id::text, 0, 'grant expired');
  end loop;

  if p_amount_micro < 0 then
    v_remaining := -p_amount_micro;

    for v_grant in
      select * from credit_grants
       where tenant_id = p_tenant
         and spent_micro < amount_micro
         and (expires_at is null or expires_at > now())
       order by expires_at nulls last, created_at
       for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_grant.amount_micro - v_grant.spent_micro, v_remaining);
      update credit_grants set spent_micro = spent_micro + v_take where id = v_grant.id;
      v_balance   := v_balance - v_take;
      v_remaining := v_remaining - v_take;
      insert into credit_ledger (tenant_id, actor_id, actor_type, grant_id, kind,
                                 amount_micro, balance_after_micro, job_id, job_type,
                                 rate_id, rate_version, idempotency_key, seq, reason)
        values (p_tenant, p_actor, p_actor_type, v_grant.id, p_kind,
                -v_take, v_balance, p_job_id, p_job_type,
                p_rate_id, p_rate_version, p_key, v_seq, p_reason);
      v_seq := v_seq + 1;
    end loop;

    if v_remaining > 0 then
      raise exception 'INSUFFICIENT_CREDITS'
        using errcode = 'P0001',
              detail  = format('short by %s micro', v_remaining);
    end if;

  elsif p_amount_micro > 0 then
    -- A credit ALWAYS creates a new grant. Never un-spend an old one: it may have
    -- expired, and the credits would then sit in the balance where FIFO cannot
    -- reach them (invariant 3).
    insert into credit_grants (tenant_id, actor_id, actor_type, grant_type,
                               amount_micro, expires_at)
      values (p_tenant, p_actor, p_actor_type,
              coalesce(p_grant_type, case when p_kind = 'grant' then 'admin' else 'refund' end),
              p_amount_micro, p_expires_at)
      returning id into v_grant_id;

    v_balance := v_balance + p_amount_micro;
    insert into credit_ledger (tenant_id, actor_id, actor_type, grant_id, kind,
                               amount_micro, balance_after_micro, job_id, job_type,
                               rate_id, rate_version, idempotency_key, seq, reason)
      values (p_tenant, p_actor, p_actor_type, v_grant_id, p_kind,
              p_amount_micro, v_balance, p_job_id, p_job_type,
              p_rate_id, p_rate_version, p_key, 0, p_reason);
  end if;

  update credit_accounts
     set balance_micro = v_balance, updated_at = now()
   where tenant_id = p_tenant;

  return v_balance;
end $$;
```

A replay returns the *current* balance, not the balance as of the original call - callers
must treat the return value as "balance now", not as a receipt.

The nightly expiry job must take the same `for update` on grant rows and must skip grants
with `spent_micro = amount_micro`; otherwise it can race a lazy sweep and collide on the
`expiry:{grant_id}` key, aborting a legitimate spend.

`INSUFFICIENT_CREDITS` (SQLSTATE P0001) rolls back the whole call - no partial debit rows
survive - and maps to HTTP 402 at the API boundary.

**Refund of a multi-grant debit** needs no special case: sum the debit's rows
(`where idempotency_key = 'task:{id}' and kind = 'debit'`) and issue one positive call.
The refund lands in a new grant carrying the shortest `expires_at` among the grants it
came from, so a refund can never extend a credit's life.

---

## 5. Ledger events

| Event | Caller | Amount | Idempotency key | Notes |
|---|---|---|---|---|
| grant: plan allowance | subscription renewal | + | `sub:{subscription_id}:{cycle}` | `expires_at = cycle_end`, so non-rollover needs no special case |
| grant: trial | onboarding | + | `trial:{tenant_id}` | `expires_at = now() + 14 days` (see open question 3) |
| grant: ops top-up | ops portal | + | operator-supplied | `expires_at` null; negative amount with `kind='adjust'` for a clawback |
| grant: purchase | payment webhook (later) | + | `purchase:{session_id}` | out of scope for v1 |
| debit: chat turn | `chatStream.ts` finish handler | - | `chat:{message_id}` | actual tokens; also writes the missing `usage_records` row |
| debit: task estimate | `tasks.ts` submit | - | `task:{task_id}` | charged before enqueue |
| settle: task actual | `tasks.execution.ts` run end | +/- | `task:{task_id}:settle` | `actual - estimate` |
| refund: task failure | terminal-failure path | + | `task:{task_id}:refund` | sums the debit rows; skip if a settle already zeroed it |
| expiry | lazy, in `spend_credits` | - | `expiry:{grant_id}` | nightly cron covers tenants that never spend |

---

## 6. The two metering paths

They share one function and one ledger, but they are not the same flow, and the earlier
draft's single `POST /jobs` flow does not fit chat.

| | Chat SSE | Task / document |
|---|---|---|
| Cost known before? | No - tokens land at `finish` | Yes, as an estimate |
| Pre-check | `balance_micro > 0`, beside `checkMessageQuota` (`chat.ts:135`) | authoritative check inside `spend_credits` at submit (`tasks.ts:65`, `documents.ts:170`) |
| Charge | at `chatStream.ts:402`, beside `persistCost` | estimate at submit, `settle` at `tasks.execution.ts:160,225` / `tasks.ts:188` |
| Refund | n/a | on terminal failure |

**Overdraft, stated honestly.** On the task path it is zero: the check happens inside the
lock. On the chat path it is *not* "one turn" - the pre-check is `balance > 0` and the
debit lands after the stream, so N concurrent streams (two tabs, mobile plus web, an
agent loop) all pass and all debit. Exposure is N x turn cost. Two mitigations, both
cheap, pick at implementation: pre-check `balance_micro >= p95_turn_cost` instead of
`> 0`, or cap concurrent streams per tenant.

**Per-step metering is deliberately absent.** `tasks.execution.ts` accumulates
`totalInputTokens` / `totalOutputTokens` across a Mastra workflow run and records once at
the end (`:160`), so individual steps expose no usage. Estimate-then-settle bounds the
exposure at one task's estimate error. Per-step metering is a later change to the
workflow, not a v1 blocker.

---

### Retiring the entitlement quotas

Credits and the existing monthly quotas are the same enforcement job done twice. Left
side by side, a tenant inside their balance can still be blocked by `checkMessageQuota`,
or the reverse. So **credits replace them**, and the plan entitlement becomes the grant
size rather than a parallel limit:

- Retire the `messages` and `llm_tokens` feature rows. Add one feature, `credits`, whose
  `value_limit` is **credits per billing cycle** (`plan_entitlements`, overridable per
  tenant through `tenant_feature_overrides` exactly as today - the ops surface does not
  change).
- The subscription renewal grant (section 5) reads that entitlement for its amount, so
  plan sizing stays where ops already edits it.
- Delete `checkMessageQuota` and `checkTokenQuota` from
  `apps/agent-orchestrator/src/usage.ts` and their five call sites (`chat.ts:135`,
  `tasks.ts:65,228`, `tasks.execution.ts:30,38`, `documents.ts:170`). The credit
  pre-check replaces them at each site.
- **Unlimited tenants skip the credit layer entirely.** When the `credits` entitlement is
  `unlimited`, the pre-check passes and no debit is written - no synthetic infinite grant,
  which would break invariant 3. `usage_records` still records everything, so unlimited
  tenants remain fully metered in the raw layer; `/credits/balance` reports
  `unlimited: true` with no figure.
- Both quota functions fail *open* today (a DB error returns `allowed: true`). The credit
  pre-check must fail **closed** on a database error, because failing open here gives away
  paid capacity rather than a rate limit. This is a deliberate behavior change; call it
  out in the rollout note.

## 7. Retiring the hardcoded prices

`apps/agent-orchestrator/src/mastra/cost.ts:5` holds a Gemini-only `PRICING` map and is
the second pricing source. After the seed lands, `calculateCostUsd` reads `credit_rates`
(active row for the model) with the current map as a static fallback for unseeded
environments. Same numbers on ship day; one editable source afterwards.

---

## 8. Authorization

No new authz path. `tenantResolutionMiddleware` sets `c.get('tenantId')` from JWT claims
stamped by the pre-token Lambda, so a user cannot present another tenant's id - there is
nothing for a `canSpend(user, tenant)` helper to check.

`hasPermission(permissions, resource, action)` takes an action from
`{create, read, update, delete}` (`packages/foundation/types/src/enums.ts:68`), so
`credits:spend` and `credits:admin` are not expressible. Use:

- `('credits', 'read')` - balance, estimate, ledger
- `('credits', 'create')` - grants, and any route that triggers a spend

---

## 9. Routes

`apps/api/src/routes/credits.ts`, mounted in `apps/api/src/app.ts` **below step 10 of the
middleware chain** - anything mounted higher ships unguarded while looking guarded.

| Method | Path | Returns | Permission |
|---|---|---|---|
| GET | `/credits/balance` | `{ balanceMicro: string, grants: [{ grantType, amountMicro, spentMicro, expiresAt }] }` | credits:read |
| GET | `/credits/estimate?resourceType&subject&params` | `{ costMicro: string, balanceMicro: string, sufficient: boolean, rateId, rateVersion }` | credits:read |
| GET | `/credits/ledger?limit&before&kind` | cursor-paginated rows, newest first | credits:read |
| POST | `/credits/grants` | ops top-up / trial; idempotent by caller key | credits:create |

**Approve is not a new endpoint.** It is the existing `POST /tasks` and the document
route, each accepting an `idempotencyKey` in the body. Note that
`packages/foundation/idempotency` is **worker-only** - `withIdempotency(store,
keyExtractor, handler)` wraps an SQS message handler, not a Hono request. So the key
passes straight through to `spend_credits`, where `unique(idempotency_key, seq)` enforces
it. A Hono idempotency middleware is a separate piece of work if it is ever wanted.

---

## 10. Lifecycle

1. **Account row.** Created on tenant creation (onboarding), plus
   `on conflict do nothing` inside `spend_credits` for tenants that predate this feature.
2. **Trial grant.** On signup: `trial:{tenant_id}`, 14 days, idempotent per tenant.
3. **Subscription grant.** On renewal: `expires_at = cycle_end`. Non-rollover falls out of
   the expiry mechanism; no separate reset job.
4. **Purchase grant.** Webhook, out of scope for v1.
5. **Backfill (one-off, before the wiring lands).** Every existing tenant gets an
   opening grant sized from its plan's `credits` entitlement, keyed
   `backfill:{tenant_id}`, `expires_at` = current cycle end. Without it the first chat
   turn after deploy raises `INSUFFICIENT_CREDITS` for every existing tenant. The script
   is idempotent per tenant and safe to re-run.
6. **Expiry.** Lazy under the spend lock, plus a nightly worker job
   (`credits.expire` in `apps/worker/src/router.ts`) for tenants that never spend, so
   dormant balances do not read high forever.

---

## 11. Implementation phases

**Phase 1 - foundation/credits.** `schema/credits.ts` + generated migration;
`spend_credits.sql` migration; `rate.ts`; `grantCredit()`, `getBalance()`, `getLedger()`.
Tests:
- 10 concurrent debits on one tenant: final balance exact, **zero** overdraft (the check
  is inside the lock - the earlier draft's "1 turn" figure applies to chat only).
- Same idempotency key twice: one charge, ledger rows written once, same balance returned.
- Two-grant drain: rows `seq 0` and `seq 1` under one key; retry is a clean replay.
- Refund of a multi-grant debit: balance restored, new grant created, invariant 3 holds.
- Expired grant: unspendable, and balance drops at the next spend without waiting on cron.

**Phase 2 - rates.** Seed from `cost.ts`; `cost.ts` reads `credit_rates` with static
fallback. No behavior change on ship day.

**Phase 3 - wiring (5 call sites).** Runs *after* the backfill script has granted every
existing tenant its opening balance, and retires the entitlement quotas in the same
change so no window exists where both systems enforce.

**Call sites.** `chat.ts:135` pre-check; `chatStream.ts:402` debit +
the missing `usage_records` row; `tasks.ts:65` estimate-and-charge; `tasks.execution.ts:160,225`
and `tasks.ts:188` settle; `documents.ts:170` same pattern; terminal-failure refund.

**Phase 4 - lifecycle and routes.** `routes/credits.ts` mounted below step 10; trial grant
on onboarding; subscription cycle grant; nightly `credits.expire` worker job.

**Phase 5 - UI.** Estimate-and-approve on the existing submit control: on params change
call `/credits/estimate`, render cost and balance with Approve/Cancel, Approve posts the
existing endpoint with the key. Balance indicator beside the existing `UsageBar`.

Deployment note: phases 3 and 4 straddle both deploy paths. `./deploy.sh` restarts only
`web-frontend` and `api` on the VM - the orchestrator needs `pm2 restart agent-orchestrator`,
and Lambda changes need `sam deploy` with product packages rebuilt first.

---

## 12. Acceptance criteria

1. Nothing outside `spend_credits()` writes `credit_accounts.balance_micro`.
2. For flat-rate resources, `/credits/estimate` returns exactly the amount subsequently
   charged (same rate row, same params). For `llm_tokens` the estimate is an estimate and
   the settle row carries the difference - this criterion does not apply there.
3. Any past ledger row is reproducible from `rate_id` + `rate_version` + the recorded
   amounts, after arbitrary price edits.
4. Concurrent task submits on one tenant: zero overdraft, final balance exact.
5. Same idempotency key twice: one charge, one set of ledger rows.
6. Chat turns write `usage_records` rows and appear in `/credits/ledger`.
7. `credit_rates` is the only pricing source; no `PRICING` map remains in `cost.ts`.
8. An expired grant can never be spent, and the balance reflects its expiry at the next
   spend, without waiting for the cron.
9. `balance_micro` equals the sum of live unexpired grant remainders after every
   operation, including refunds of multi-grant debits (property test).
10. `checkMessageQuota` and `checkTokenQuota` no longer exist, and no route enforces both
    a quota and a balance.
11. An unlimited tenant is never debited, still writes `usage_records`, and is never
    blocked by the pre-check.
12. Every tenant existing before the rollout has an opening grant; no existing tenant's
    first post-deploy turn fails for lack of credits.

---

## 13. Open questions

1. **Credit-to-dollar rate.** Section 3 assumes 1 credit = 1 US cent at cost. Confirm, and
   say whether v1 carries margin (change the seed, not the code).
2. **`job_id` anchor.** Chat debits key on message id, task debits on `agent_tasks.id`.
   Confirm `job_type` values: `chat_message`, `agent_task`, `document`.
3. **Trial length and size.** 14 days is a placeholder with no product rationale behind it;
   the earlier draft's appeal to the EEA/UK withdrawal window is unrelated to credit expiry.
4. **Chat overdraft mitigation.** Threshold pre-check or per-tenant stream cap (section 6).
5. **Plan sizes in credits.** Retiring `messages`/`llm_tokens` means each plan needs a
   `credits` per-cycle number. Free/starter/business/enterprise values are unset; pick
   them alongside open question 1, since they are the same decision in different units.
6. **Fail-closed confirmation.** The quota functions fail open today; the credit
   pre-check fails closed (section 6). Confirm - it means a credits DB outage stops chat
   rather than serving it free.

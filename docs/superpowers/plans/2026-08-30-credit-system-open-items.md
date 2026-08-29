# Credit System — open items

Written 2026-08-30, revised the same day after the money-bug pass shipped. **Start a new
session from this file.**

The credit system is built, reviewed, merged, pushed and fully deployed to dev. This lists
what is left, ordered by what can cost money. Every item has a file:line so you can go
straight to it.

---

## State as of writing

| | |
|---|---|
| Branch | `origin/main` at `cf882f7c` — everything below is merged and pushed |
| Dev database | migrations through **0073 applied** (74 total); seeds run; backfill run. `agent_tasks.credit_attempt` present, existing rows at 0 |
| Backfill result | 4/4 tenants granted, second run granted 0, **invariant 3 verified holding** (re-checked after 0073) |
| AWS dev | all Lambdas deployed as of `cf882f7c`; `project-context-credits-expire-dev` Active; EventBridge `rate(1 day)` ENABLED. Watchdog invoked post-deploy, clean against the new column |
| GCP VM | deployed as of `cf882f7c` |

**Everything in sections 1 and 2 is shipped.** What remains starts at section 3.
Sections 1 and 2 are kept as the record of what was wrong and why, because the
reasoning is what stops it coming back — not as a to-do list.

**No path in the system produces a double credit.** That was verified as the closing
condition of the original review, and the money-bug pass did not open one: every fix
below moves undercharges toward being charged, never the reverse.

Full history, every ruling R1-R36, and every deferred finding:
`docs/superpowers/plans/2026-08-29-credit-system-ledger.md`. The money-bug pass has its
own plan at `docs/superpowers/plans/2026-08-30-credit-money-bugs.md`.

---

## 1. Do first — the browser checklist, the only thing never verified

Deployment is done: migration, Lambdas, VM, in that order. The ordering rule is worth
keeping for the next schema change — **a migration adding a column that handlers select
unconditionally must land before the Lambdas**, or every task approval and every
watchdog sweep throws until it does.

What has still never happened is anyone looking at this feature in a browser.

The checklist lives at the end of
`.superpowers/sdd/2026-08-28-credit-system/task-15-report.md` (git-ignored, lives in
the `credit-system` worktree). Nobody has seen this UI render. The two steps that
matter: zero a tenant's balance and confirm Approve disables on the plan-review
screen; then make the estimate request fail and confirm Approve still works — a failed
*preview* must never block approval, because `spend_credits()` is the real check.

---

## 2. Money bugs — all five fixed and deployed

Fixed in `b5717054` (items 2a-2c, 2e) and `eca7e674` (item 2d). Kept here in short form
because the reasoning is what stops them coming back.

**The root cause behind 2a, 2b and 2c was one thing.** The retry attempt number was
*derived*, by counting `credit_ledger` refund rows for a `job_id`. That equals the
attempt only if every abandoned charge writes a refund and nothing else writes refunds
under the same `job_id` — and neither held. It is now stored in
`agent_tasks.credit_attempt`, advanced inside `refundTask` only when a refund actually
lands, guarded on `credit_attempt = $n` so a replayed refund cannot skip a number.

| Was | Now |
|---|---|
| **2a** The watchdog blocked stalled tasks without refunding, so the attempt froze, the retry rebuilt the same key, `spend_credits()` saw a replay and the first run went unbilled | Sweeps 1 and 2 refund what they block. A stall is our orchestrator crashing, not the tenant's doing, so the tenant pays nothing |
| **2b** Document refunds wrote `job_id = taskId`, so a task whose PRD planning failed began execution at attempt 1 | The charge key alone decides whether a bump is meaningful; a `document:` key does not parse as a task attempt |
| **2c** `handleWorkflowApprove` recounted at approve time, so a refund landing mid-flight desynced resume's key from the charge's and both settle and refund no-opped | Reads the stored column, which only moves when a charge is abandoned |
| **2d** A *successful* workflow stayed charged at the estimate forever | Accumulates the per-step usage `runMastraWorkflow` already reported and settles |
| **2e** `documents.ts` returned 502 on a JSON parse failure without refunding | Refunds, like its two sibling branches |

`refundTask`, `taskChargeKey` and `shortestExpiresAt` now live in
`@serverless-saas/agent-credits` (`products/agent-platform/packages/credits`), because
the watchdog runs in the API Lambda and neither it nor the orchestrator can import the
other. `settleTask` and `chargeTaskEstimate` stayed in the orchestrator — no second
consumer, no reason to move live money code.

**Two tests in this pass passed for the wrong reason before mutation testing caught
them.** One was shielded by test ordering; the other needed its own fixture row at
attempt 0 to detect a permissive key parse at all. A third check — a
`jobType === 'agent_task'` guard — was deleted once a mutation proved it could never
fire. Keep the standard: an assertion that cannot fail is worse than none, because it
reads like coverage.

### Still open here

`runMastraWorkflowSteps` does not call `recordUsage`, so workflow token usage never
reaches the usage metrics that `runMastraTaskSteps` feeds. Credits are correct; the
metrics are blind to workflows. Left alone rather than guessed at.

---

## 3. Coverage

### 3a. Nothing asserts `attempt` reaches the wire

No test reads the SQS body from `handlePlanApprove`, the relay body from
`handleExecution`, or the resume body from `handleWorkflowApprove`. An edit dropping
that field leaves every suite green while silently returning every retry to attempt 0
and free. **Three cheap assertions close it.**

Still true after the money-bug pass, and now slightly worse: all three sites read
`agent_tasks.credit_attempt` directly, so the value they put on the wire is one field
access away from being dropped with nothing to notice. The watchdog's own charge key IS
asserted (`__tests__/watchdog.refund.test.ts`), which is the shape to copy.

### 3b. There is no CI in this repository

No `.github/workflows` at all. Every integration test is
`describe.skipIf(!process.env.TEST_DATABASE_URL)`, so in a CI without that variable
they would all pass by skipping — including every test that guards the money paths.

**Whoever stands up CI must export `TEST_DATABASE_URL`** for the credits, api, worker
and agent-orchestrator jobs, or this feature's entire test suite is decorative.

---

## 4. Structural

### 4a. Invariant 7 is unimplemented

The spec requires rate edits to be versioned and immutable — insert `version + 1`,
deactivate the old row. **No rate-edit path exists anywhere in the codebase.** Nothing
stops an operator running `UPDATE credit_rates SET pricing_schema = ...` in place,
which would retroactively break acceptance criterion 3 (every ledger row reproducible
from `rate_id` + `rate_version`) for every historical row.

Either build the ops rate-edit path with the versioning discipline, or write down that
rates are edited by hand and the discipline is a human convention.

### 4b. Dead code

`ctx.onTaskComment` (`tasks.execution.ts:115-119`), `handleClarifyTask`, and
`POST /internal/tasks/:taskId/clarify` are all unreachable —
`runMastraWorkflow` is the only caller of `ctx.onTaskComment` and it is invoked solely
from `tasks.workflow.ts:82`, which just logs. Verified twice, independently.

The coupling that used to make this dangerous is gone: wiring `onTaskComment` up would
once have reintroduced 2c, because a clarification landing between enqueue and approve
changed the recomputed attempt. With the attempt stored, it cannot. The code is still
dead and still worth deleting, but it is no longer a loaded gun.

### 4c. `0072`'s `P0001` catch is broad

`packages/foundation/database/migrations/0072_spend_credits_sweep_survives_shortfall.sql:176`
catches `sqlstate 'P0001'`, which is the default for *any* `raise exception`. Correct
today, since the shortfall raise is the only producer inside that block. But a future
raise there — or a trigger on `credit_grants`/`credit_ledger` — would be reported as
`insufficient = true` and surface to a user as HTTP 402, masking a real bug as a
billing message. The `if v_remaining > 0` guard covers the post-loop region only.

### 4d. Two queries missing a `tenant_id` predicate

The `task_events` count queries in `taskWorker.execution.ts` and `tasks.approval.ts`
filter by `taskId` only. Not exploitable — both are preceded by a tenant-scoped
`agentTasks` lookup that 404s on mismatch — but it departs from the repo's standing
rule and costs one predicate.

---

## 5. Phases already specced, not built

- `docs/superpowers/specs/2026-08-29-subscription-renewal-grants.md` — the nightly job
  that refills each cycle. **Until this ships, every metered tenant's balance reaches
  zero at their first cycle end and never refills.** With the fail-closed pre-check
  that is a hard stop, not a degradation. Decisions already taken: `trialing` excluded;
  `grantSubscriptionCycleCredits` needs its `startedAt` split into an anchor and a
  `now`, or a scheduled caller silently grants nothing forever.
- `docs/superpowers/specs/2026-08-29-credit-purchase.md` — self-serve buying. **Until
  this ships, a tenant at zero has no recourse at all** — not self-serve, and not
  manual, since no reachable route holds `credits:create`. Decisions already taken: 2×
  markup held in the *sale price* not `credit_rates`; purchased credits expire in 12
  months so FIFO burns the monthly allowance first.

Ops-side granting — comping, trial extensions, correcting a billing mistake — is
deferred to the mission control portal and is covered by neither spec.

---

## 6. Environment notes worth carrying

- **Dev's TLS.** The connection string is `sslmode=require`, but Supabase's pooler cert
  is not in Node's default CA bundle: `psql` accepts it, `pg` and `postgres-js` do not.
  Use `sslmode=no-verify` for drizzle-kit, and `NODE_TLS_REJECT_UNAUTHORIZED=0` scoped
  to the process for `tsx` scripts — which is what `DatabaseSslNoVerify=true` does in
  the deployed Lambda.
- **Migrations must go through the session pooler (5432), not the transaction pooler
  (6543)** that the secret specifies. Drizzle wraps each migration in a transaction and
  transaction-mode pooling hands statements to different backends.
- **`packages/foundation/database/drizzle.config.ts` loads `apps/api/.env`**, whose
  `DATABASE_URL` is the shared Supabase dev database. Always set `DATABASE_URL`
  explicitly. Never `drizzle-kit push`.
- **Local test database:** `postgresql://suyash@localhost:5432/credit_system_test` —
  Homebrew postgresql@18, pgvector 0.8.6 built from source. A test run reporting
  "skipped" is not a passing run.
- **Suite baselines** after the money-bug pass: foundation credits 24, `apps/api` 86,
  `apps/worker` 13, `apps/web` 196, agent-platform api 304, agent-orchestrator 200
  (1 file fails to COLLECT for a pre-existing unbuilt-`dist` reason — do not chase it).
- **`apps/api` needs `DATABASE_URL` as well as `TEST_DATABASE_URL`.** With only the
  latter, one file fails to import `packages/foundation/database` and the run reports
  73 instead of 86 — a partial pass that looks like a pass.
- **`sam build` fails if any foundation package lacks `dist/`.** `pnpm --filter
  "@serverless-saas/*" build` bails at the first failure; use `--no-bail`. Several
  packages fail `tsc` on test-file type errors that do not affect emitted JS.

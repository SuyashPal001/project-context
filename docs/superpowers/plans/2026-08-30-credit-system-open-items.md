# Credit System — open items after the dev deploy

Written 2026-08-30. **Start a new session from this file.**

The credit system is built, reviewed, merged, pushed, and deployed to dev. This lists
what is left, ordered by what can cost money. Every item has a file:line so you can go
straight to it.

---

## State as of writing

| | |
|---|---|
| Branch | merged to `main`, pushed — `b53bc5bf` |
| Dev database | migrations 0069–0072 applied (69 → 73); seeds run; backfill run |
| Backfill result | 4/4 tenants granted, second run granted 0, **invariant 3 verified holding** |
| AWS dev | all 7 Lambdas deployed; `project-context-credits-expire-dev` Active; EventBridge `rate(1 day)` ENABLED |
| GCP VM | **NOT deployed** |

**No path in the system produces a double credit.** That was verified as the closing
condition of the final review. Every remaining money bug below is
undercharge-direction — they cost revenue, they do not overcharge a customer.

Full history, every ruling R1–R36, and every deferred finding:
`docs/superpowers/plans/2026-08-29-credit-system-ledger.md`.

---

## 1. Do first — the VM is not deployed

```bash
./deploy.sh                        # web + api PM2 processes
pm2 restart agent-orchestrator     # deploy.sh does NOT restart this
```

**The orchestrator restart is not optional.** The API Lambda is already running code
that sends an `attempt` field in the resume payload; the orchestrator currently running
on the VM does not know about it. Until it restarts, the two sides disagree.

Then the **7-step browser checklist** at the end of
`.superpowers/sdd/2026-08-28-credit-system/task-15-report.md` (git-ignored, lives in
the `credit-system` worktree). Nobody has seen this UI render. The two steps that
matter: zero a tenant's balance and confirm Approve disables on the plan-review
screen; then make the estimate request fail and confirm Approve still works — a failed
*preview* must never block approval, because `spend_credits()` is the real check.

**Expect one cosmetic wrong thing on dev:** the sidebar still shows the old
`messages` quota bar. The seed stopped *creating* those feature rows; it does not
delete existing ones, so dev still has them. `UsageBar.tsx` will render a quota that
enforces nothing, next to the live credit balance. Decide whether to delete the rows
or fix `UsageBar`.

---

## 2. Money bugs, all undercharge-direction

### 2a. Watchdog blocks a stalled task without refunding — **the one to fix first**

`apps/worker/src/handlers/watchdogHandler.ts:75,143` marks a stalled task `blocked`
and never refunds its charge. The attempt counter is derived from refunds
(`products/agent-platform/packages/api/lib/credit-attempt.ts`), so with no refund row
the retry recomputes the *same* attempt, reuses the same charge key, and
`spend_credits()` replays it — run 1's tokens are never billed.

It is also the live producer of the settle-on-a-refunded-key shape that
`settleTask`'s guard (`apps/agent-orchestrator/src/credits.ts:377-382`) exists to
block, because the original run may still be alive and refund later.

Same shape as the bug that took four review rounds to close. Fix it the same way:
decide whether a watchdog-blocked task should refund, and if so route it through
`refundTask` with the run's own `chargeKey`.

### 2b. Document refunds inflate a task's attempt count

`credit-attempt.ts:30-42` counts `credit_ledger` rows by `job_id` alone. But
`documents.ts:251,269` writes `job_id = taskId` with `kind='refund'` for a
`document:{taskId}` charge. So a task whose PRD-planning failed starts execution at
`attempt: 1`.

Harmless for money — charge, settle and refund all use the same threaded attempt — but
it falsifies the "attempt 0 for a never-refunded task" claim in three comments, and it
makes 2c below the common case rather than an edge. **One predicate from correct:**
`and eq(creditLedger.jobType, 'agent_task')`.

### 2c. `handleWorkflowApprove` recomputes the attempt live

`products/agent-platform/packages/api/routes/tasks.approval.ts:222` re-derives the
attempt at approve time instead of reading what the suspended run was charged under.
Any refund landing between the charge and the approve desyncs resume's key from the
charge's. The failure is a settle/refund that finds no rows and silently no-ops — an
unsettled charge. The `settleTask` guard does not help, because the key holds nothing.

Durable fix: persist the attempt on `agent_tasks` at charge time rather than
re-deriving it.

### 2d. `/api/workflows/execute` charges and never settles

`apps/agent-orchestrator/src/routes/tasks.ts:297` debits an estimate; the only
reconciliation is `tasks.workflow.ts:95`'s refund on failure. A *successful* workflow
is charged the estimate forever, unlike a successful task. Documented as deliberate at
`tasks.workflow.ts:34-38` — confirm that is still the intent.

### 2e. `documents.ts` JSON-parse failure returns 502 with no refund

`apps/agent-orchestrator/src/routes/documents.ts:274-277`, unlike its two sibling
failure branches which do refund. In practice `settleTask` has usually written a row by
then so `refundTask` would no-op, but the asymmetry is unstated.

---

## 3. Coverage

### 3a. Nothing asserts `attempt` reaches the wire

No test reads the SQS body from `handlePlanApprove`, the relay body from
`handleExecution`, or the resume body from `handleWorkflowApprove`. An edit dropping
that field leaves every suite green while silently returning every retry to attempt 0
and free. **Three cheap assertions close it.**

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

Note the coupling: if `onTaskComment` is ever wired up, a clarification landing between
enqueue and approve reintroduces 2c.

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
- **Suite baselines** with the variable set: credits 24, `apps/api` 86, `apps/worker`
  13, `apps/web` 196, agent-orchestrator 196 (1 file fails to COLLECT for a
  pre-existing unbuilt-`dist` reason — do not chase it).
- **`sam build` fails if any foundation package lacks `dist/`.** `pnpm --filter
  "@serverless-saas/*" build` bails at the first failure; use `--no-bail`. Several
  packages fail `tsc` on test-file type errors that do not affect emitted JS.

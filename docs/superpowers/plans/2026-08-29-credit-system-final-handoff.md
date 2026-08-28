# Credit System — handoff at the final gate

Written 2026-08-29. Resume point for a new session.

## Where things stand

All 15 tasks of `docs/superpowers/plans/2026-08-28-credit-system.md` are implemented,
reviewed, and committed on branch `worktree-credit-system` in the worktree
`.claude/worktrees/credit-system`. 28 commits, base `cdf92197`, head `3f7b06b6`.

Every task passed a scoped review plus a fix loop. The final whole-branch review
(Opus) has run and returned **Not ready — two blockers**, both small and local.
A fix agent was dispatched for them and may not have finished.

**Nothing is deployed.** Migrations 0069–0071 exist only on the local test database.

## First thing to check on resume

```bash
cd .claude/worktrees/credit-system
git log --oneline -3
git status --short
```

- If HEAD is past `3f7b06b6`, the fix agent committed — go to "Verifying the fixes".
- If HEAD is `3f7b06b6` with uncommitted changes, the fix agent died mid-work.
  Treat that work as untrusted draft: read it against the two blockers below and
  decide what to keep. Do not assume it is correct or complete.
- `apps/agent-orchestrator/src/routes/tasks.execution.ts` was modified and
  uncommitted at the time of writing.

## The two blockers

### Blocker 1 — a charged task that fails mid-run is never refunded

`apps/agent-orchestrator/src/routes/tasks.execution.ts:227-240`.

`earlyTermination` is set at `:98` (`onStepFail`), `:107` (`onTaskComment`),
`:155-158` (document-workflow non-success) and `:213-217` (execution-workflow
non-success). All four leave the estimate charged at `:42` standing: the settle is
gated behind `if (!earlyTermination)` and `refundTask` is reachable only from the
`catch` blocks at `:165` and `:230`. A workflow returning `status: 'failed'` — the
ordinary failure shape, not a thrown exception — takes this path and the tenant
stays charged for work that never landed.

Fix: `await refundTask({ tenantId, taskId })` in the `earlyTermination` branch.
`refundTask`'s settled-row guard and its `net >= 0n` guard make it safe to call
unconditionally there. `tasks.workflow.ts:79-88` already does exactly this for the
sibling flow — copy that shape.

### Blocker 2 — a failed spend rolls back the lazy expiry sweep

`packages/foundation/database/migrations/0071_credit_ledger_tenant_scoped_idempotency.sql:60-109`.

The lazy expiry sweep and the `raise exception 'INSUFFICIENT_CREDITS'` share one
implicit transaction, so a spend that fails discards the sweep it just performed.

Reproduction (verified): a tenant with one 1,000,000-micro grant expired a day ago,
`balance_micro = 1000000`. Call `spend_credits(tenant, -50000, ...)`. It raises
`INSUFFICIENT_CREDITS`. Afterwards `balance_micro` is still `1000000`,
`credit_ledger` holds zero `expiry` rows, and the grant's `spent_micro` is still `0`.

This breaks **invariant 3** — the one the spec names as protecting every other rule.
At the seam: `apps/agent-orchestrator/src/credits.ts:53`'s chat pre-check reads the
stale balance and passes, `debitChatTurn` swallows the resulting error at `:131-133`,
and the tenant chats free until the nightly Lambda runs — up to 24 hours, unbounded
volume, and that Lambda is itself new and undeployed.

The existing test at `spend.integration.test.ts:84` only covers the spend that
*succeeds*, which is why fifteen scoped reviews did not catch it.

**Hard constraint:** `spend_credits()` is called as ONE statement so no transaction
spans two backends over the Supabase transaction pooler (6543). No client-side
`BEGIN`/`COMMIT`, no splitting into multiple round trips.

Preferred fix: keep it in the database — check the shortfall *before* any mutation so
the function returns the error with nothing to roll back, or catch the condition in a
nested block after the sweep has applied. Fallback, only if a database-side fix is
provably not achievable: an application-side follow-up
`spendCredits({ amountMicro: 0n, kind: 'adjust', key: 'expiry-sweep:{tenant}:{date}' })`
at `debitChatTurn`'s catch and `chargeTaskEstimate`'s caller error paths, mirroring
`creditsExpire.ts:72`. That fallback is second choice because it only protects paths
that remember to make the call.

Any function change ships as a NEW migration `0072_*.sql`, hand-registered in
`migrations/meta/_journal.json` the way 0070 and 0071 were. Never rewrite an applied
migration in place.

Regression test to add in `packages/foundation/credits/src/__tests__/`: expired grant,
spend larger than the remainder, assert `balance_micro` reaches 0 and an `expiry`
ledger row exists. Confirm it fails before the fix and passes after.

### Also ordered, smaller but real

Refund and settle grants pass no `expiresAt` (`apps/agent-orchestrator/src/credits.ts:348-361`
and `:433-442`), so `0071:112-118` writes `expires_at = null` and a refund silently
converts expiring trial or cycle credits into permanent ones. Spec §4 requires the
refund to carry the shortest `expires_at` among the grants it came from. Derive it
from the debit rows already queried.

## Verifying the fixes

Dispatch a scoped re-review on **Opus** (the user directed all remaining reviews to
Opus) using
`~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/subagent-driven-development/scripts/review-package`
over the fix range, with `re-review-prompt.md`. Then the branch is ready to present.

## Environment

- `TEST_DATABASE_URL=postgresql://suyash@localhost:5432/credit_system_test` — local
  Homebrew postgresql@18 on 5432, pgvector 0.8.6 built from source, migrations
  0069–0071 applied, seeds run.
- **`packages/foundation/database/drizzle.config.ts` loads `apps/api/.env`, whose
  `DATABASE_URL` points at the SHARED SUPABASE DEV DATABASE.** Set `DATABASE_URL`
  explicitly on every drizzle-kit or script invocation. Never `drizzle-kit push`.
- Integration tests `describe.skipIf(!process.env.TEST_DATABASE_URL)` — a run
  reporting "skipped" is not a passing run. Check the counts.
- Baselines with the variable set: credits 23, `apps/api` 86, `apps/worker` 13,
  `apps/web` 194, agent-orchestrator 173. One orchestrator test file fails to COLLECT
  for a pre-existing unbuilt-`dist` reason (`@serverless-saas/mcp`) — do not chase it.
- Rebuild `@serverless-saas/credits` and `@serverless-saas/database` before suites
  that import through `dist/`.
- Do NOT use `git stash` — this worktree shares a stash stack with other checkouts.
- `.gitignore:52` is `*.md`; doc commits need `git add -f`.

## Everything else

`.superpowers/sdd/2026-08-28-credit-system/progress.md` is the full execution ledger:
every ruling (R1–R32), every deferred minor, every rollout item, and the final
review's verdict in full. It is git-ignored, so it lives only in this worktree —
read it before making any decision the run already made.

The two rollout blockers the owner must decide on, both recorded there in full:

1. **Nothing grants subscription credits recurringly.** `grantSubscriptionCycleCredits`
   has one caller and it is a plan-change handler, so a metered tenant's balance goes
   to zero 14 days after signup and never refills. With the fail-closed pre-check that
   is a hard product outage on day 15, not a degraded experience.
2. **`POST /billing/upgrade` has no payment gate.** After a genuine cycle end, any
   holder of `billing:update` can self-serve one allowance per cycle. These two
   interact: upgrade is currently the *only* replenishment path, so closing the gate
   without building renewals leaves tenants no way to obtain credits at all.

# Credit system — money bug fixes

Written 2026-08-30. Follows `2026-08-30-credit-system-open-items.md`, which listed
five undercharge-direction money bugs after the dev deploy. This plan fixes all five.

Two product decisions were taken before writing this:

1. **A watchdog-blocked task is refunded.** A stall means the Redis heartbeat expired —
   an orchestrator crash or timeout, which is our infrastructure failing, not the
   tenant's input. The tenant pays nothing for a run that produced nothing. We absorb
   the tokens already burned.
2. **`/api/workflows/execute` gets real token accounting and a settle.** The up-front
   estimate stops being the final price for a successful workflow run.

---

## The root cause behind items 1, 2 and 3

`attempt` — the number that makes each retry of a task charge under its own
`task:{id}:attempt:{n}` key instead of replaying the previous run's already-refunded
debit — is **derived** rather than stored. `countTaskRefunds()` counts `credit_ledger`
rows with `kind='refund'` for a `job_id`, and that count is used as the attempt number.

The derivation is only correct if two things hold:

- every abandoned charge writes a refund row, and
- nothing else writes refund rows under that `job_id`.

Both are false today.

| | What breaks it |
|---|---|
| Item 1 | The watchdog abandons a charge and writes no refund. The counter freezes, the retry rebuilds the same key, `spend_credits()` sees a replay and charges nothing — the first run's tokens are never billed. |
| Item 2 | `documents.ts` writes `job_id = taskId, kind = 'refund'` for a `document:{taskId}` charge. A task whose PRD planning failed starts execution at attempt 1. |
| Item 3 | `handleWorkflowApprove` recomputes the count at approve time. Any refund landing between the charge and the approve gives resume a different key than the charge used, so settle and refund both find nothing and silently no-op. |

**The fix is to stop deriving it.** The attempt becomes a stored column,
`agent_tasks.credit_attempt`, advanced exactly once per abandoned charge, at the moment
the refund for that charge lands. That makes items 2 and 3 impossible by construction
rather than by a predicate, and reduces item 1 to routing the watchdog through the
refund path.

---

## Tasks

### 1. Store the attempt

Add to `agentTasks` in `products/agent-platform/packages/schema/agents.ts`:

```ts
creditAttempt: integer('credit_attempt').notNull().default(0),
```

Generate the migration with drizzle-kit. `default(0)` backfills every existing row to
attempt 0, which is what the unsuffixed `task:{id}` key already means — so no historical
charge key changes meaning.

### 2. Extract the shared credit code into a product package

The watchdog runs in the API Lambda (`products/agent-platform/packages/api`); the refund
logic lives in the orchestrator (`apps/agent-orchestrator/src/credits.ts`). Neither
package can import the other, and the logic is product-specific, so it cannot go in
`packages/foundation/*`.

Create `products/agent-platform/packages/credits` (`@serverless-saas/agent-credits`)
holding exactly the pieces both sides need:

- `taskChargeKey(taskId, attempt)`
- `shortestExpiresAt()`
- `refundTask()`
- `readCreditAttempt()` / `bumpCreditAttempt()`

Moved verbatim, no behavior change in this task. `settleTask`, `chargeTaskEstimate` and
`debitChatTurn` stay in the orchestrator — nothing else calls them, and moving live money
code with no second consumer buys risk for nothing.

The two sides use different drivers: the orchestrator has a node-pg `Pool`, the API
package has a postgres.js client behind Drizzle. `refundTask` already accepts an
injectable `pool` dep with a `query(text, params) => { rows }` shape, so the API side
passes a thin adapter over `client.unsafe()` rather than opening a second connection.

### 3. Advance the attempt inside `refundTask`

`refundTask` takes the `attempt` it is refunding (every caller already has it) and, only
after a refund row actually lands, runs:

```sql
update agent_tasks set credit_attempt = credit_attempt + 1
 where id = $1 and tenant_id = $2 and credit_attempt = $3
```

The `credit_attempt = $3` predicate makes the bump idempotent: a replayed or racing
refund for the same attempt updates zero rows instead of skipping an attempt number.

Skipped entirely when `jobType !== 'agent_task'`, which is what stops document refunds
from touching a task's attempt — item 2, closed at the source rather than by a predicate
on a count.

### 4. Read the stored column everywhere the count was read

- `taskWorker.execution.ts:40` — use `task.creditAttempt` from the row already fetched.
- `tasks.approval.ts:94` (`handlePlanApprove`) — add `creditAttempt` to the existing select.
- `tasks.approval.ts:222` (`handleWorkflowApprove`) — same. Item 3 closed: the value read
  is the one written at charge time, not a live recount.
- Delete `products/agent-platform/packages/api/lib/credit-attempt.ts` and its tests.

`attemptOverride` on `handleExecution` stays. It exists so an SQS redelivery replays the
attempt carried in the message body rather than re-reading a value that may have moved,
and that reasoning is unchanged by the column.

### 5. Watchdog refunds what it blocks

`products/agent-platform/packages/api/handlers/watchdogHandler.ts`, sweeps 1 and 2 (the
`in_progress` and `planning` sweeps — both abandon a charged run). After the status
update lands and before the notification, read `credit_attempt`, refund under
`taskChargeKey(taskId, attempt)`, and let `refundTask` bump.

Sweep 3 (`awaiting_approval` → `cancelled`) also needs a refund: a plan sitting unapproved
for seven days was charged at planning time.

Failures here must not abort the sweep. `refundTask` already swallows and logs loudly on
its own inner failure; the call is wrapped the same way the WebSocket and SQS pushes are.

### 6. `documents.ts` JSON-parse branch refunds

`apps/agent-orchestrator/src/routes/documents.ts:274-277` returns 502 on a parse failure
without refunding, unlike its two sibling failure branches. Add the same
`refundTask({ ..., jobType: 'document' })` call. Usually a no-op because `settleTask` has
already written a row by then — `refundTask`'s settled-row guard handles that — but the
asymmetry is what makes the file hard to reason about.

### 7. Workflow token accounting and settle

`apps/agent-orchestrator/src/routes/tasks.workflow.ts` charges an estimate at submit time
and reconciles it only on failure, so a *successful* workflow is charged the estimate
forever. Unlike `runMastraTaskSteps`, `runMastraWorkflow` tracks no token totals at all.

Thread input/output token totals out of `runMastraWorkflow` the way the task path does,
accumulate them across steps, and call `settleTask` on the success branch with the same
`chargeKey` the estimate was charged under.

This is the largest task here and touches a different code path from tasks 1–6. It ships
after them, separately, so a regression in either is unambiguous.

---

## Testing standard

Same as the original build: every test must be **observed to fail** against the
unfixed code before the fix lands. Specifically —

- The attempt column must be shown to hold its value across a refund landing between
  charge and approve (item 3's exact shape), which the derivation cannot.
- A document refund must be shown NOT to move a task's attempt (item 2).
- A watchdog-blocked task must be shown to charge again on retry, under a new key
  (item 1) — the assertion that fails today.
- `bumpCreditAttempt` must be shown idempotent under a replayed refund.

Note `.gitignore:52` is `*.md`, so doc commits need `git add -f`.

import { isUnlimited, spendCredits } from '@serverless-saas/credits'
import { attemptFromChargeKey } from './chargeKey'

/**
 * The minimum a caller must hand us to talk to Postgres.
 *
 * Structural rather than `pg.Pool` because the two callers use different
 * drivers: the agent orchestrator has a real node-pg Pool, while the API
 * Lambda (which is where the watchdog runs) has a postgres.js client behind
 * Drizzle and passes a thin adapter over `client.unsafe()`. Neither should
 * open a second connection just to issue a refund.
 */
export interface CreditPool {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>
}

/**
 * The earliest expiry among the grants a debit drew from, or null if every
 * one of them was permanent.
 *
 * A refund must never hand back credits that outlive the ones spent: a grant
 * that was going to expire on the 1st cannot come back as a permanent grant
 * just because the task it paid for failed. So the refund grant inherits the
 * SHORTEST real expiry among the drawn grants — or null only if every drawn
 * grant was itself permanent, in which case there is nothing to shorten and a
 * permanent refund is correct, not a bug.
 */
export function shortestExpiresAt(expiresAts: Array<Date | string | null>): Date | null {
  let shortest: Date | null = null
  for (const raw of expiresAts) {
    if (raw == null) continue
    const d = raw instanceof Date ? raw : new Date(raw)
    if (shortest === null || d.getTime() < shortest.getTime()) shortest = d
  }
  return shortest
}

/**
 * Advances agent_tasks.credit_attempt past the attempt whose charge was just
 * refunded, so the next run of this task charges under a fresh key instead of
 * replaying a debit that no longer stands.
 *
 * `credit_attempt = $3` is what makes this idempotent. A replayed refund — a
 * retried failure callback, an SQS redelivery, two failure paths firing on the
 * same run — carries the same charge key, therefore the same attempt, and the
 * second bump updates zero rows rather than skipping an attempt number.
 * Skipping one would be harmless for money but would leave a gap that makes
 * the ledger unreadable against the column.
 *
 * Returns whether the bump landed, for logging and tests.
 */
export async function bumpCreditAttempt(
  pool: CreditPool,
  tenantId: string,
  taskId: string,
  attempt: number,
): Promise<boolean> {
  const res = await pool.query<{ id: string }>(
    `update agent_tasks
        set credit_attempt = credit_attempt + 1, updated_at = now()
      where id = $1 and tenant_id = $2 and credit_attempt = $3
      returning id`,
    [taskId, tenantId, attempt],
  )
  return res.rows.length > 0
}

export interface RefundTaskArgs {
  tenantId: string
  taskId: string
  /** Idempotency key of the ORIGINAL charge to refund. Defaults to `task:{taskId}`; the document routes override this. */
  chargeKey?: string
  /** Idempotency key for the refund write itself. Defaults to `{chargeKey}:refund`. */
  key?: string
  /** credit_ledger.job_type. Defaults to 'agent_task'; the document routes override with 'document'. */
  jobType?: string
}

export interface RefundTaskDeps {
  isUnlimited?: typeof isUnlimited
  spendCredits?: typeof spendCredits
  pool: CreditPool
}

/**
 * Refunds a task's charge on terminal failure, then advances the task's
 * credit attempt so a retry charges fresh.
 *
 * Never un-spends the original debit's grant — spend_credits() guarantees that
 * already; this always creates a NEW grant for whatever net amount the tenant
 * is down.
 *
 * Sums only the original charge key's debit row, scoped by tenant_id —
 * migration 0071 made the idempotency namespace per-tenant specifically
 * because an unscoped `idempotency_key` lookup let one tenant's key silently
 * affect another's; this query must never regress that.
 *
 * Skipped if a settle already ran for this charge: the success path already
 * reconciled it, so a failure callback racing in after that must not refund on
 * top. Skipped for unlimited tenants (nothing was charged). A second
 * refundTask call for the same charge is additionally guarded by
 * spend_credits()'s own idempotency on the refund key.
 *
 * The attempt bump is deliberately inside all of those guards: it fires only
 * when a refund row actually lands, because the attempt number's whole meaning
 * is "how many charges for this task have been abandoned". A skipped refund
 * abandoned nothing.
 */
export async function refundTask(args: RefundTaskArgs, deps: RefundTaskDeps): Promise<void> {
  const isUnlimitedFn = deps.isUnlimited ?? isUnlimited
  const spendCreditsFn = deps.spendCredits ?? spendCredits
  const pool = deps.pool
  const chargeKey = args.chargeKey ?? `task:${args.taskId}`
  const refundKey = args.key ?? `${chargeKey}:refund`
  const jobType = args.jobType ?? 'agent_task'
  try {
    if (await isUnlimitedFn(args.tenantId)) return

    const settleKey = `${chargeKey}:settle`
    const settled = await pool.query<{ exists: boolean }>(
      `select exists(select 1 from credit_ledger where tenant_id = $1 and idempotency_key = $2) as exists`,
      [args.tenantId, settleKey],
    )
    if (settled.rows[0]?.exists) return

    const debitKey = chargeKey
    const res = await pool.query<{ amount_micro: string; expires_at: string | null }>(
      `select cl.amount_micro, cg.expires_at
         from credit_ledger cl
         left join credit_grants cg on cg.id = cl.grant_id
        where cl.tenant_id = $1 and cl.idempotency_key = $2 and cl.kind = 'debit'`,
      [args.tenantId, debitKey],
    )
    const net = res.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n) // negative if the tenant was charged; 0 if never charged
    if (net >= 0n) return
    // Spec §4: the refund grant can never outlive the shortest-lived grant
    // the original debit drew from.
    const originalGrantExpiresAt = shortestExpiresAt(res.rows.map(row => row.expires_at))

    // A failure past this point means real money owed to the tenant gets
    // stuck — unlike debitChatTurn's fire-and-forget (a dropped debit costs
    // us revenue we chose not to chase), a dropped refund is money WE owe.
    // The swallow below is intentional (a throwing refund must not break the
    // failure path it runs on), but it must be loud and replay-ready: the
    // refund key is idempotent per tenant, so a human can safely replay this
    // exact spend_credits() call by hand once they see the log line.
    try {
      await spendCreditsFn({
        tenantId: args.tenantId,
        amountMicro: -net,
        key: refundKey,
        kind: 'refund',
        grantType: 'refund',
        jobId: args.taskId,
        jobType,
        expiresAt: originalGrantExpiresAt,
        reason: 'task failed',
      })
    } catch (spendErr) {
      console.error(
        `[credits] UNREFUNDED CHARGE: tenantId=${args.tenantId} taskId=${args.taskId} ` +
        `key=${refundKey} amountMicro=${-net} — refund write failed and was swallowed; ` +
        `tenant is still down ${-net} micro-credits for a task that did not complete. ` +
        `Replay by hand: spend_credits('${args.tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (spendErr as Error).message,
      )
      return
    }

    // The refund landed, so the charge it undid is abandoned — advance the
    // attempt.
    //
    // The charge key alone decides whether that is meaningful, and it is the
    // ONLY thing that decides. A `document:{taskId}` key returns null here even
    // though its job_id is the task id — which is precisely the defect this
    // replaced, where a failed PRD planning run silently pushed a task to
    // attempt 1. There is deliberately no second `jobType === 'agent_task'`
    // check in front of this: it would be unreachable, since every non-task
    // job type in the system carries a non-task charge key, and an unreachable
    // guard on money code reads like protection while proving nothing.
    //
    // The workflow route refunds under `task:{workflowRunId}`, which DOES parse
    // as attempt 0 — but a workflow run id is not an agent_tasks id, so the
    // update's `id = $1` predicate matches nothing and the bump is a no-op.
    const attempt = attemptFromChargeKey(args.taskId, chargeKey)
    if (attempt !== null) {
      try {
        await bumpCreditAttempt(pool, args.tenantId, args.taskId, attempt)
      } catch (bumpErr) {
        // The refund is already durable; failing to advance the attempt only
        // risks the NEXT run replaying this now-refunded key and running
        // free. Loud, because that is a revenue leak a human must close.
        console.error(
          `[credits] ATTEMPT NOT ADVANCED: tenantId=${args.tenantId} taskId=${args.taskId} ` +
          `attempt=${attempt} — the refund for ${chargeKey} landed but agent_tasks.credit_attempt ` +
          `could not be bumped; a retry of this task will replay the refunded charge key and run ` +
          `for free until it is set to ${attempt + 1} by hand. Cause:`,
          (bumpErr as Error).message,
        )
      }
    }
  } catch (err) {
    console.error(`[credits] refundTask failed tenantId=${args.tenantId} taskId=${args.taskId}:`, (err as Error).message)
  }
}

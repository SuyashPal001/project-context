/**
 * Per-attempt task charge key, and its inverse.
 *
 * Attempt 0 (a task that has never had a charge abandoned — the common case)
 * keeps the exact original `task:{taskId}` key, so existing behavior is
 * unchanged for tasks that never pause or fail. Each subsequent attempt gets
 * its OWN key.
 *
 * Without this, a re-run's chargeTaskEstimate call would carry the same
 * `task:{taskId}` key as the original charge — already refunded by then — and
 * spend_credits()'s replay check (invariant 5) would find that original
 * debit's ledger row and return the current balance without charging anything
 * for the new run. A refund-then-retry is the ordinary product flow, not an
 * edge case, so that gap made every retried task run for free.
 *
 * `attempt` is `agent_tasks.credit_attempt`, advanced by exactly one whenever
 * a charge is abandoned and refunded (see refundTask). It used to be derived
 * at read time by counting refund rows in credit_ledger; see the column's
 * comment in products/agent-platform/packages/schema/agents.ts for why that
 * derivation was wrong.
 */
export function taskChargeKey(taskId: string, attempt: number): string {
  return attempt > 0 ? `task:${taskId}:attempt:${attempt}` : `task:${taskId}`
}

/**
 * Inverse of taskChargeKey: which attempt does this charge key belong to?
 *
 * `null` means the key is not a task charge key for this task at all — a
 * `document:{taskId}` key, or a key belonging to some other task. Callers use
 * that to decide whether advancing `agent_tasks.credit_attempt` is meaningful,
 * which is what stops a document refund from moving a task's attempt.
 *
 * Recovering the attempt from the key rather than passing it alongside is
 * deliberate: refundTask is always given the key of the charge it is undoing,
 * so an attempt read back out of that key cannot disagree with it. A separate
 * `attempt` argument could.
 */
export function attemptFromChargeKey(taskId: string, chargeKey: string): number | null {
  if (chargeKey === `task:${taskId}`) return 0
  const prefix = `task:${taskId}:attempt:`
  if (!chargeKey.startsWith(prefix)) return null
  const rest = chargeKey.slice(prefix.length)
  // Reject anything that is not a plain positive integer: Number('') is 0,
  // Number(' 1') is 1 and Number('1e3') is 1000, none of which taskChargeKey
  // can produce.
  if (!/^[1-9][0-9]*$/.test(rest)) return null
  return Number(rest)
}

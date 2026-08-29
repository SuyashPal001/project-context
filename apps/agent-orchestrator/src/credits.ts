import type pg from 'pg'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import type { PricingSchema } from '@serverless-saas/credits'
import {
  refundTask as sharedRefundTask,
  shortestExpiresAt,
  type RefundTaskArgs,
  type RefundTaskDeps,
} from '@serverless-saas/agent-credits'
import { getPool } from './usage.js'

export interface CreditBalanceResult {
  allowed: boolean
  balanceMicro: bigint
  unlimited: boolean
}

// One round trip: balance from credit_accounts, plus the `credits` entitlement
// (tenant override wins over plan entitlement) — mirrors the lookup pattern in
// isUnlimited() (packages/foundation/credits/src/read.ts) and checkMessageQuota()
// (usage.ts), but as a single query over the raw pg pool so a unit test can
// inject a fake `{ query }` without pulling in drizzle.
//
// tenant_id is bound once via $1 and threaded through every join — no query
// here can cross tenants.
const BALANCE_QUERY = `
  select
    coalesce(ca.balance_micro, 0) as balance_micro,
    coalesce(tfo.unlimited, pe.unlimited, false) as unlimited
  from (select $1::uuid as tenant_id) t
  left join credit_accounts ca on ca.tenant_id = t.tenant_id
  left join subscriptions s on s.tenant_id = t.tenant_id and s.status in ('active', 'trialing')
  left join features f on f.key = 'credits'
  left join plan_entitlements pe on pe.plan = s.plan::text and pe.feature_id = f.id
  left join tenant_feature_overrides tfo
         on tfo.tenant_id = t.tenant_id and tfo.feature_id = f.id
        and tfo.revoked_at is null and tfo.deleted_at is null
        and (tfo.expires_at is null or tfo.expires_at > now())
`

/**
 * Chat pre-check: `balance_micro > 0` exactly — see the plan's controller
 * ruling (section 6). Unlimited tenants pass without a balance read being
 * meaningful. Fails CLOSED on any error — the reverse of the quota functions
 * it replaces (checkMessageQuota/checkTokenQuota fail open), because a DB
 * error here would otherwise give away paid capacity for free.
 */
export async function checkCreditBalance(
  tenantId: string,
  pool: pg.Pool = getPool(),
): Promise<CreditBalanceResult> {
  try {
    const res = await pool.query<{ balance_micro: string; unlimited: boolean }>(BALANCE_QUERY, [tenantId])
    const row = res.rows[0]
    if (row?.unlimited) {
      return { allowed: true, balanceMicro: 0n, unlimited: true }
    }
    const balanceMicro = BigInt(row?.balance_micro ?? '0')
    return { allowed: balanceMicro > 0n, balanceMicro, unlimited: false }
  } catch (err) {
    console.error('[credits] checkCreditBalance error tenantId=' + tenantId + ':', (err as Error).message)
    return { allowed: false, balanceMicro: 0n, unlimited: false }
  }
}

export interface DebitChatTurnArgs {
  tenantId: string
  agentId: string
  messageId: string
  model: string
  inputTokens: number
  outputTokens: number
}

// Same model-key normalization cost.ts uses (mastra/cost.ts:keyFor) — strip a
// provider prefix, and route self-hosted ollama/* models to the 'ollama' rate
// subject rather than their bare model name. Exported: task call sites need it
// too, to resolve a rate for chargeTaskEstimate's rateId/rateVersion.
export function rateSubjectFor(model: string): string {
  if (model.startsWith('ollama/')) return 'ollama'
  return model.includes('/') ? model.split('/').pop()! : model
}

// Test seam — same reason `checkCreditBalance` takes an injectable `pool`:
// lets a unit test assert exactly what debitChatTurn calls (or skips calling)
// without pulling in drizzle/a live DB. Defaults are the real
// @serverless-saas/credits functions; production call sites never pass this.
export interface DebitChatTurnDeps {
  isUnlimited?: typeof isUnlimited
  resolveRate?: typeof resolveRate
  spendCredits?: typeof spendCredits
}

/**
 * Post-turn debit, called beside persistCost() after the stream finishes.
 * Fire-and-forget by contract: never throws out — any failure is logged and
 * swallowed so a credits problem can never take down an already-delivered
 * chat stream.
 *
 * Unlimited tenants are skipped entirely here: no debit, and deliberately no
 * synthetic infinite grant — that would break the invariant that
 * balance_micro equals the sum of live grant remainders. They still get their
 * usage_records row from recordUsage(), called by the same call site.
 */
export async function debitChatTurn(args: DebitChatTurnArgs, deps: DebitChatTurnDeps = {}): Promise<void> {
  const { tenantId, agentId, messageId, model, inputTokens, outputTokens } = args
  const isUnlimitedFn = deps.isUnlimited ?? isUnlimited
  const resolveRateFn = deps.resolveRate ?? resolveRate
  const spendCreditsFn = deps.spendCredits ?? spendCredits
  try {
    if (await isUnlimitedFn(tenantId)) return

    const subject = rateSubjectFor(model)
    const rate = await resolveRateFn('llm_tokens', subject)
    if (!rate) {
      // Unmetered by omission: usage_records still gets its row (recorded by
      // the same chatStream.ts call site), but this turn is never billed —
      // seed a credit_rates row for this subject or it stays free forever.
      console.error(`[credits] UNBILLED CHAT TURN: no active llm_tokens rate for model=${model} subject=${subject} tenantId=${tenantId} messageId=${messageId} — turn was NOT debited`)
      return
    }

    const amountMicro = costMicro(rate.schema, { inputTokens, outputTokens })
    if (amountMicro <= 0n) return

    await spendCreditsFn({
      tenantId,
      amountMicro: -amountMicro,
      key: `chat:${messageId}`,
      kind: 'debit',
      actorId: agentId,
      actorType: 'agent',
      rateId: rate.id,
      rateVersion: rate.version,
      jobType: 'chat_message',
    })
  } catch (err) {
    console.error(`[credits] debitChatTurn failed tenantId=${tenantId} messageId=${messageId}:`, (err as Error).message)
  }
}

// ─── Task metering: estimate → charge → settle → refund ──────────────────────
//
// Chat charges after the fact because token counts only exist once the stream
// finishes (debitChatTurn above). Tasks are the opposite: cost is estimable up
// front, so the authoritative balance check happens INSIDE spend_credits() at
// submit time, under the account lock — chargeTaskEstimate's call to
// spend_credits() *is* the check. Overdraft on this path is therefore zero,
// unlike the chat balance>0 pre-check, which N concurrent streams can each
// pass independently. Never add a separate balance pre-check in front of
// chargeTaskEstimate — that reopens exactly the race this design closes.

/** Tokens assumed per workflow step when no better estimate exists. Tune from token_costs. */
const AVERAGE_STEP_TOKENS = { input: 4000, output: 1000 }

/** Default model used for the up-front charge/settle when an agent has no
 * explicit model selection row yet — matches the '*' wildcard credit_rates subject. */
export const DEFAULT_TASK_MODEL = 'gemini-2.5-flash'


export interface EstimateTaskMicroDeps {
  resolveRate?: typeof resolveRate
}

/** Rough up-front cost for a task with `stepCount` steps, at `model`'s current rate. */
export async function estimateTaskMicro(
  stepCount: number,
  model: string,
  deps: EstimateTaskMicroDeps = {},
): Promise<bigint> {
  const resolveRateFn = deps.resolveRate ?? resolveRate
  const rate = await resolveRateFn('llm_tokens', rateSubjectFor(model))
  if (!rate) return 0n
  return costMicro(rate.schema, {
    inputTokens: AVERAGE_STEP_TOKENS.input * stepCount,
    outputTokens: AVERAGE_STEP_TOKENS.output * stepCount,
  })
}

export interface ResolveTaskRateDeps {
  resolveRate?: typeof resolveRate
}

/**
 * The active llm_tokens rate for `model`, normalized through the same
 * subject key estimateTaskMicro/settleTask use. Route call sites use this to
 * get the rateId/rateVersion to pass into chargeTaskEstimate for ledger
 * audit metadata — a null return means the task/document is charged at 0
 * estimate (no active rate for that model), matching estimateTaskMicro's own
 * `if (!rate) return 0n` fallback.
 */
export async function resolveTaskRate(
  model: string,
  deps: ResolveTaskRateDeps = {},
): Promise<{ id: string; version: number } | null> {
  const resolveRateFn = deps.resolveRate ?? resolveRate
  const rate = await resolveRateFn('llm_tokens', rateSubjectFor(model))
  return rate ? { id: rate.id, version: rate.version } : null
}

export interface ChargeTaskEstimateArgs {
  tenantId: string
  taskId: string
  agentId: string
  estimateMicro: bigint
  rateId?: string | null
  rateVersion?: number | null
  /** Idempotency key. Defaults to `task:{taskId}`; Task 10 (documents) overrides this. */
  key?: string
  /** credit_ledger.job_type. Defaults to 'agent_task'; Task 10 overrides with 'document'. */
  jobType?: string
}

export interface ChargeTaskEstimateDeps {
  isUnlimited?: typeof isUnlimited
  spendCredits?: typeof spendCredits
}

/**
 * Charges the up-front estimate for a task run. This call IS the balance
 * check: spend_credits() throws InsufficientCreditsError under the account
 * lock when the estimate can't be covered, and that throw MUST propagate
 * uncaught here so the route boundary can map it to HTTP 402 — unlike
 * debitChatTurn/settleTask, this function is not fire-and-forget.
 *
 * Unlimited tenants skip the credit layer entirely: no charge, no synthetic
 * grant.
 */
export async function chargeTaskEstimate(
  args: ChargeTaskEstimateArgs,
  deps: ChargeTaskEstimateDeps = {},
): Promise<void> {
  const isUnlimitedFn = deps.isUnlimited ?? isUnlimited
  const spendCreditsFn = deps.spendCredits ?? spendCredits
  if (await isUnlimitedFn(args.tenantId)) return

  await spendCreditsFn({
    tenantId: args.tenantId,
    amountMicro: -args.estimateMicro,
    key: args.key ?? `task:${args.taskId}`,
    kind: 'debit',
    actorId: args.agentId,
    actorType: 'agent',
    rateId: args.rateId ?? null,
    rateVersion: args.rateVersion ?? null,
    jobId: args.taskId,
    jobType: args.jobType ?? 'agent_task',
  })
}

/**
 * Positive credits the tenant back (actual came in under estimate); negative
 * debits the shortfall (actual ran over); 0n means the estimate was exact and
 * nothing should be written. Pure — no I/O, trivially unit-testable.
 */
export function settleAmount(args: { estimateMicro: bigint; actualMicro: bigint }): bigint {
  return args.estimateMicro - args.actualMicro
}

export interface SettleTaskArgs {
  tenantId: string
  taskId: string
  agentId: string
  /** Fallback model, used ONLY when the original charge's debit rows carry no
   * rate_id (an unmetered charge — no active rate existed at charge time). */
  model: string
  inputTokens: number
  outputTokens: number
  /** Idempotency key of the ORIGINAL charge to settle against. Defaults to `task:{taskId}`; Task 10 (documents) overrides this. */
  chargeKey?: string
  /** Idempotency key for the settle write itself. Defaults to `{chargeKey}:settle`
   * — NOT `task:{taskId}:settle` directly, so an attempt-scoped chargeKey
   * (taskChargeKey()) still lands its settle write beside the charge it is
   * reconciling. Task 10 (documents) overrides this explicitly. */
  key?: string
  jobType?: string
}

export interface SettleTaskDeps {
  isUnlimited?: typeof isUnlimited
  resolveRate?: typeof resolveRate
  spendCredits?: typeof spendCredits
  pool?: pg.Pool
}

/**
 * Reconciles the estimate charged by chargeTaskEstimate against actual token
 * usage once the run ends.
 *
 * The baseline for the delta is READ BACK from credit_ledger — never
 * recomputed from "current" inputs (step count, model selection) — because
 * this function can run in a different request than the one that charged
 * (e.g. after an approval resume), possibly minutes later, by which point
 * the step count or the agent's model may have changed. Recomputing would
 * silently settle against a number nobody was ever actually charged.
 * Summed and rate-sourced from the tenant-scoped `task:{taskId}` debit
 * row(s) (same scoping discipline as refundTask, for the same migration-0071
 * reason) — the rate_id/rate_version on those rows is the rate that priced
 * the ORIGINAL charge, so actual usage is settled at that historical rate,
 * not today's active rate. `args.model` is only a fallback, used if the
 * original charge landed with no rate at all (rateId null — e.g. an
 * unmetered subject at charge time).
 *
 * Fire-and-forget like debitChatTurn: never throws out — any failure is
 * logged and swallowed, because by the time this runs the task has already
 * been reported complete and a credits hiccup here must not undo that.
 * Skips the round trip entirely when settleAmount is 0n, or when no debit
 * row exists at all (nothing was ever charged — unlimited tenant, or a
 * charge that never landed).
 *
 * Skipped if a refund already ran against this chargeKey — the mirror of
 * refundTask's settled-row guard below. A settle must never land on top of
 * an estimate that was already refunded: refundTask fires on every early
 * termination (a clarify-and-resume pause, onStepFail, or the workflow's own
 * non-success branch), not only the ones a caller's attempt-key derivation
 * expects, so this guard is the belt to that derivation's braces — it holds
 * even if the derivation is wrong and a settle is attempted against an
 * already-refunded key.
 */
export async function settleTask(args: SettleTaskArgs, deps: SettleTaskDeps = {}): Promise<void> {
  const isUnlimitedFn = deps.isUnlimited ?? isUnlimited
  const resolveRateFn = deps.resolveRate ?? resolveRate
  const spendCreditsFn = deps.spendCredits ?? spendCredits
  const pool = deps.pool ?? getPool()
  try {
    if (await isUnlimitedFn(args.tenantId)) return

    const chargeKey = args.chargeKey ?? `task:${args.taskId}`

    const refundKey = `${chargeKey}:refund`
    const refunded = await pool.query<{ exists: boolean }>(
      `select exists(select 1 from credit_ledger where tenant_id = $1 and idempotency_key = $2) as exists`,
      [args.tenantId, refundKey],
    )
    if (refunded.rows[0]?.exists) return

    const chargeRows = await pool.query<{
      amount_micro: string
      rate_id: string | null
      rate_version: number | null
      pricing_schema: PricingSchema | null
      expires_at: string | null
    }>(
      `select cl.amount_micro, cl.rate_id, cl.rate_version, cr.pricing_schema, cg.expires_at
         from credit_ledger cl
         left join credit_rates cr on cr.id = cl.rate_id
         left join credit_grants cg on cg.id = cl.grant_id
        where cl.tenant_id = $1 and cl.idempotency_key = $2 and cl.kind = 'debit'`,
      [args.tenantId, chargeKey],
    )
    if (chargeRows.rows.length === 0) return // nothing was ever charged — nothing to settle

    const estimateMicro = -chargeRows.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n)
    // The grants the original debit drew from — used only when this settle
    // turns out to be a refund (delta > 0n) below.
    const originalGrantExpiresAt = shortestExpiresAt(chargeRows.rows.map(row => row.expires_at))
    const priced = chargeRows.rows.find(row => row.pricing_schema != null)
    let schema = priced?.pricing_schema ?? null
    let rateId = priced?.rate_id ?? null
    let rateVersion = priced?.rate_version ?? null

    if (!schema) {
      // The original charge landed with no rate (unmetered at charge time) —
      // fall back to today's active rate for args.model so actual usage is
      // still priced somehow, rather than settling blind.
      const fallback = await resolveRateFn('llm_tokens', rateSubjectFor(args.model))
      if (!fallback) return
      schema = fallback.schema
      rateId = fallback.id
      rateVersion = fallback.version
    }

    const actualMicro = costMicro(schema, {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
    })
    const delta = settleAmount({ estimateMicro, actualMicro })
    if (delta === 0n) return

    await spendCreditsFn({
      tenantId: args.tenantId,
      amountMicro: delta,
      // Was hardcoded off args.taskId directly (`task:{taskId}:settle`),
      // which silently diverged from an attempt-scoped chargeKey once
      // taskChargeKey() started varying the charge key per attempt — the
      // read above (chargeRows) already correctly scopes by `chargeKey`,
      // only the default write key didn't follow it.
      key: args.key ?? `${chargeKey}:settle`,
      kind: 'settle',
      actorId: args.agentId,
      actorType: 'agent',
      rateId,
      rateVersion,
      jobId: args.taskId,
      jobType: args.jobType ?? 'agent_task',
      grantType: delta > 0n ? 'refund' : null,
      // Only meaningful when delta > 0 (spend_credits() ignores expiresAt on
      // a negative amount) — the new refund grant can never outlive the
      // shortest-lived grant the original estimate charge drew from.
      expiresAt: delta > 0n ? originalGrantExpiresAt : null,
      reason: 'settle estimate to actual',
    })
  } catch (err) {
    console.error(`[credits] settleTask failed tenantId=${args.tenantId} taskId=${args.taskId}:`, (err as Error).message)
  }
}

// refundTask now lives in @serverless-saas/agent-credits, because the watchdog
// (which runs in the API Lambda) has to be able to refund a task it blocks, and
// neither package can import the other. Re-exported here, pre-bound to this
// process's pool, so every existing call site in the orchestrator keeps working
// unchanged and no caller has to know where the pool comes from.
export { taskChargeKey, attemptFromChargeKey, shortestExpiresAt } from '@serverless-saas/agent-credits'
export type { RefundTaskArgs, RefundTaskDeps } from '@serverless-saas/agent-credits'

export function refundTask(
  args: RefundTaskArgs,
  deps: Partial<RefundTaskDeps> = {},
): Promise<void> {
  // getPool() only when the caller did not bring its own — a unit test that
  // injects a fake pool must not cause a real one to be constructed.
  return sharedRefundTask(args, { ...deps, pool: deps.pool ?? getPool() })
}

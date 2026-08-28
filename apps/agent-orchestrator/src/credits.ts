import type pg from 'pg'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
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
// subject rather than their bare model name.
function rateSubjectFor(model: string): string {
  if (model.startsWith('ollama/')) return 'ollama'
  return model.includes('/') ? model.split('/').pop()! : model
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
export async function debitChatTurn(args: DebitChatTurnArgs): Promise<void> {
  const { tenantId, agentId, messageId, model, inputTokens, outputTokens } = args
  try {
    if (await isUnlimited(tenantId)) return

    const subject = rateSubjectFor(model)
    const rate = await resolveRate('llm_tokens', subject)
    if (!rate) {
      console.error(`[credits] debitChatTurn: no active llm_tokens rate for subject=${subject} tenantId=${tenantId} — skipping debit`)
      return
    }

    const amountMicro = costMicro(rate.schema, { inputTokens, outputTokens })
    if (amountMicro <= 0n) return

    await spendCredits({
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

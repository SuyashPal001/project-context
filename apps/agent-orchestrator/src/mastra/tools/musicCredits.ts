import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

// Shared by generateSong.ts — mirrors refundImageCharge's read-back pattern
// (imageCredits.ts) and refundTask's (products/agent-platform/packages/credits/refund.ts):
// the refund amount and expiry are read back from the ledger, never trusted
// from in-memory state, and the refund grant inherits the SHORTEST expiry
// among the grants the original debit drew from.
export async function refundMusicCharge(
  tenantId: string, agentId: string, chargeKey: string,
  rateId: string | null, rateVersion: number | null,
): Promise<void> {
  try {
    const pool = getPool()
    const res = await pool.query<{ amount_micro: string; expires_at: string | null }>(
      `select cl.amount_micro, cg.expires_at
         from credit_ledger cl
         left join credit_grants cg on cg.id = cl.grant_id
        where cl.tenant_id = $1 and cl.idempotency_key = $2 and cl.kind = 'debit'`,
      [tenantId, chargeKey],
    )
    const net = res.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n)
    if (net >= 0n) return
    const expiresAt = shortestExpiresAt(res.rows.map(row => row.expires_at))
    const refundKey = `${chargeKey}:refund`

    try {
      await spendCredits({
        tenantId, amountMicro: -net, key: refundKey, kind: 'refund',
        actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'music_generation',
        grantType: 'refund', expiresAt,
      })
    } catch (err) {
      console.error(
        `[credits] UNREFUNDED MUSIC CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} amountMicro=${-net} — ` +
        `refund write failed and was swallowed; tenant is still down ${-net} micro-credits for a ` +
        `generation that could not be saved. Replay by hand: ` +
        `spend_credits('${tenantId}', ${-net}, '${refundKey}', 'refund', ...) ` +
        `(idempotent per tenant on this key, safe to retry). Cause:`,
        (err as Error).message,
      )
    }
  } catch (err) {
    console.error(
      `[credits] refundMusicCharge failed tenantId=${tenantId} chargeKey=${chargeKey}:`,
      (err as Error).message,
    )
  }
}

import { spendCredits } from '@serverless-saas/credits'
import { shortestExpiresAt } from '../../credits.js'
import { getPool } from '../../usage.js'

// Shared by generateImage.ts and editImage.ts — both charge under
// jobType 'image_generation', so that's fixed here rather than threaded
// through as a parameter both callers would just pass the same value for.
//
// Mirrors refundTask's read-back pattern
// (products/agent-platform/packages/credits/refund.ts:109-169): the refund
// amount and expiry are read back from the ledger, never trusted from
// in-memory state, and the refund grant inherits the SHORTEST expiry among
// the grants the original debit drew from (via shortestExpiresAt, the same
// helper refundTask uses) — a refund must never hand back a permanent grant
// for what was an expiring one.
export async function refundImageCharge(
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
    const net = res.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n) // negative — what was charged
    if (net >= 0n) return // nothing was actually charged
    const expiresAt = shortestExpiresAt(res.rows.map(row => row.expires_at))
    await spendCredits({
      tenantId, amountMicro: -net, key: `${chargeKey}:refund`, kind: 'refund',
      actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'image_generation',
      grantType: 'refund', expiresAt,
    })
  } catch (err) {
    console.error(
      `[credits] UNREFUNDED IMAGE CHARGE: tenantId=${tenantId} chargeKey=${chargeKey} — ` +
      `refund write failed and was swallowed; tenant is still down for a generation that ` +
      `could not be saved. Cause:`, (err as Error).message,
    )
  }
}

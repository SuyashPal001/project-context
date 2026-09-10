import { getPool } from '../../usage.js'

export interface DelegationRecord {
  tenantId: string
  agentId: string | null
  conversationId: string | null
  primitiveId: string
  runId: string
  toolCallId: string
  success: boolean
  durationMs: number
  rejectionReason?: string | null
  errorMessage?: string | null
}

interface QueryablePool { query: (text: string, values: unknown[]) => Promise<unknown> }

const INSERT = `
  insert into agent_delegations
    (tenant_id, agent_id, conversation_id, primitive_id, run_id, tool_call_id, success, duration_ms, rejection_reason, error_message)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`

/**
 * One row per delegation, success or failure. Swallows its own errors: this
 * runs inside onDelegationComplete under hookErrorStrategy 'throw', where a
 * throw fails the delegation itself. A lost audit row must not cost the user
 * work that already happened — so the failure is logged loudly and the
 * delegation stands.
 */
export async function recordDelegation(
  record: DelegationRecord,
  deps: { pool?: QueryablePool } = {},
): Promise<void> {
  if (!record.tenantId) return
  try {
    const pool = deps.pool ?? getPool()
    await pool.query(INSERT, [
      record.tenantId,
      record.agentId || null,
      record.conversationId || null,
      record.primitiveId,
      record.runId,
      record.toolCallId,
      record.success,
      record.durationMs,
      record.rejectionReason ?? null,
      record.errorMessage ?? null,
    ])
  } catch (err) {
    console.error(
      `[subagents] delegation link row lost tenantId=${record.tenantId} primitive=${record.primitiveId} runId=${record.runId}:`,
      (err as Error).message,
    )
  }
}

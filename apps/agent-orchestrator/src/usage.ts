import pg from 'pg'
import { makeAppPool } from './db.js'

// DDL (run once at deploy time):
//
// CREATE TABLE IF NOT EXISTS usage_records (
//   id          BIGSERIAL PRIMARY KEY,
//   tenant_id   UUID        NOT NULL,
//   actor_id    UUID        NOT NULL,
//   actor_type  TEXT        NOT NULL,   -- 'human' | 'agent'
//   metric      TEXT        NOT NULL,   -- 'messages' | 'input_tokens' | 'output_tokens'
//   quantity    NUMERIC     NOT NULL,
//   api_key_id  UUID,
//   recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
// );

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!pool) {
    pool = makeAppPool(5)
    pool.on('error', (err) => {
      console.error('[usage] pool error:', err.message)
    })
  }
  return pool
}

export interface UsageRecord {
  tenantId: string
  actorId: string
  apiKeyId?: string
  inputTokens?: number
  outputTokens?: number
}

export interface AgentSkill {
  systemPrompt: string | null
  tools: string[] | null
  config: unknown
}

export async function fetchAgentSkill(agentId: string): Promise<AgentSkill | null> {
  const p = getPool()
  const res = await p.query<{ system_prompt: string | null; tools: unknown; config: unknown }>(
    `SELECT system_prompt, tools, config FROM agent_skills
     WHERE agent_id = $1 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [agentId],
  )
  const row = res.rows[0]
  if (!row) return null
  const rawTools = row.tools
  const tools = Array.isArray(rawTools)
    ? (rawTools as string[])
    : null
  return { systemPrompt: row.system_prompt, tools, config: row.config }
}

// Lightweight cache — agent names are immutable after creation
const agentNameCache = new Map<string, string>()

export async function fetchAgentName(agentId: string): Promise<string | null> {
  if (!agentId) return null
  const cached = agentNameCache.get(agentId)
  if (cached !== undefined) return cached
  const p = getPool()
  const res = await p.query<{ name: string }>(
    'SELECT name FROM agents WHERE id = $1 LIMIT 1',
    [agentId],
  )
  const name = res.rows[0]?.name ?? null
  if (name) agentNameCache.set(agentId, name)
  return name
}

export async function fetchAgentSlug(agentId: string): Promise<string | null> {
  // agentId is now the immutable container slug — no DB lookup needed
  return agentId || null
}

export interface QuotaCheckResult {
  allowed: boolean
  used: number
  limit: number | null
  unlimited: boolean
}

export async function checkMessageQuota(tenantId: string): Promise<QuotaCheckResult> {
  const p = getPool()
  try {
    // 1. Active plan — trialing counts the same as active for quota purposes
    const subRes = await p.query<{ plan: string }>(
      `SELECT plan FROM subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing')
       LIMIT 1`,
      [tenantId],
    )
    const plan = subRes.rows[0]?.plan ?? 'free'

    // 2. Tenant-specific override wins over plan entitlement
    const overrideRes = await p.query<{ value_limit: number | null; unlimited: boolean }>(
      `SELECT tfo.value_limit, tfo.unlimited
       FROM tenant_feature_overrides tfo
       JOIN features f ON f.id = tfo.feature_id
       WHERE tfo.tenant_id = $1
         AND f.key = 'messages'
         AND tfo.revoked_at IS NULL
         AND tfo.deleted_at IS NULL
         AND (tfo.expires_at IS NULL OR tfo.expires_at > NOW())
       LIMIT 1`,
      [tenantId],
    )

    let valueLimit: number | null = null
    let unlimited = false

    if (overrideRes.rows.length > 0) {
      valueLimit = overrideRes.rows[0].value_limit
      unlimited = overrideRes.rows[0].unlimited
    } else {
      const planRes = await p.query<{ value_limit: number | null; unlimited: boolean }>(
        `SELECT pe.value_limit, pe.unlimited
         FROM plan_entitlements pe
         JOIN features f ON f.id = pe.feature_id
         WHERE pe.plan = $1
           AND f.key = 'messages'
           AND f.status = 'active'
         LIMIT 1`,
        [plan],
      )
      if (planRes.rows.length > 0) {
        valueLimit = planRes.rows[0].value_limit
        unlimited = planRes.rows[0].unlimited
      }
    }

    if (unlimited) return { allowed: true, used: 0, limit: null, unlimited: true }

    // 3. Count messages recorded this calendar month
    const usageRes = await p.query<{ used: string }>(
      `SELECT COALESCE(SUM(quantity), 0) AS used
       FROM usage_records
       WHERE tenant_id = $1
         AND metric = 'messages'
         AND recorded_at >= date_trunc('month', NOW())`,
      [tenantId],
    )
    const used = parseInt(usageRes.rows[0]?.used ?? '0', 10)

    if (valueLimit === null) {
      // Missing entitlement config — fail open so quota DB gaps never block users
      console.warn(`[quota] no messages entitlement for tenantId=${tenantId} plan=${plan} — allowing`)
      return { allowed: true, used, limit: null, unlimited: false }
    }

    return { allowed: used < valueLimit, used, limit: valueLimit, unlimited: false }
  } catch (err) {
    // Fail open — a quota DB error must never block a legitimate user request
    console.error('[quota] checkMessageQuota error:', (err as Error).message)
    return { allowed: true, used: 0, limit: null, unlimited: false }
  }
}

export interface ToolGovernance {
  requiresApprovalTools: string[]
  highStakeTools: string[]
}

// Returns provider names for all active integrations the tenant has connected.
export async function fetchConnectedProviders(tenantId: string): Promise<string[]> {
  const p = getPool()
  try {
    const res = await p.query<{ provider: string }>(
      `SELECT provider FROM integrations WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
    )
    return res.rows.map(r => r.provider)
  } catch (err) {
    console.error('[tools] fetchConnectedProviders error:', (err as Error).message)
    return []
  }
}

// Returns tool governance data for an agent:
//   requiresApprovalTools — tool names that need human approval before use
//   highStakeTools        — tool names that are high or critical stakes
//
// Mirrors getAgentTools() logic from @serverless-saas/ai/tools but uses raw pg.
// Assigned tools (explicit agent_tool_assignments) take precedence over platform tools.
// Platform tools are only included if:
//   - provider IS NULL (generic tools like web_search), or
//   - provider is in connectedProviders (tenant has that integration active)
export async function fetchToolGovernance(
  agentId: string,
  tenantId: string,
  connectedProviders: string[],
): Promise<ToolGovernance> {
  const p = getPool()
  try {
    // Tools explicitly assigned to this agent
    const assignedRes = await p.query<{ name: string; stakes: string; requires_approval: boolean }>(
      `SELECT at.name, at.stakes, at.requires_approval
       FROM agent_tool_assignments ata
       JOIN agent_tools at ON ata.tool_id = at.id
       WHERE ata.agent_id = $1 AND ata.tenant_id = $2 AND at.status = 'active'`,
      [agentId, tenantId],
    )

    // Platform tools (tenant_id IS NULL) scoped to connected providers
    const platformRes = await p.query<{ name: string; stakes: string; requires_approval: boolean }>(
      connectedProviders.length > 0
        ? `SELECT name, stakes, requires_approval
           FROM agent_tools
           WHERE tenant_id IS NULL AND status = 'active'
             AND (provider IS NULL OR provider = ANY($1::text[]))`
        : `SELECT name, stakes, requires_approval
           FROM agent_tools
           WHERE tenant_id IS NULL AND status = 'active' AND provider IS NULL`,
      connectedProviders.length > 0 ? [connectedProviders] : [],
    )

    // Merge — assigned tools take precedence, no duplicates by name
    const assignedNames = new Set(assignedRes.rows.map(r => r.name))
    const allTools = [
      ...assignedRes.rows,
      ...platformRes.rows.filter(r => !assignedNames.has(r.name)),
    ]

    return {
      requiresApprovalTools: allTools.filter(t => t.requires_approval).map(t => t.name),
      highStakeTools: allTools.filter(t => t.stakes === 'high' || t.stakes === 'critical').map(t => t.name),
    }
  } catch (err) {
    // Fail open — governance errors must never block task execution
    console.error('[tools] fetchToolGovernance error:', (err as Error).message)
    return { requiresApprovalTools: [], highStakeTools: [] }
  }
}

export interface AgentPolicy {
  allowedActions: string[]      // if non-empty, ONLY these tools allowed
  blockedActions: string[]      // these tools always blocked
  requiresApproval: string[]    // these tools need human approval
  maxTokensPerMessage: number | null
  maxMessagesPerConversation: number | null
}

export async function fetchAgentPolicy(
  agentId: string,
  tenantId: string,
): Promise<AgentPolicy> {
  const p = getPool()
  try {
    const res = await p.query<{
      allowed_actions: string[]
      blocked_actions: string[]
      requires_approval: string[]
      max_tokens_per_message: number | null
      max_messages_per_conversation: number | null
    }>(
      `SELECT allowed_actions, blocked_actions,
              requires_approval,
              max_tokens_per_message,
              max_messages_per_conversation
       FROM agent_policies
       WHERE agent_id = $1 AND tenant_id = $2
       LIMIT 1`,
      [agentId, tenantId],
    )

    if (res.rows.length === 0) {
      // No policy configured — permissive defaults
      return {
        allowedActions: [],
        blockedActions: [],
        requiresApproval: [],
        maxTokensPerMessage: null,
        maxMessagesPerConversation: null,
      }
    }

    const row = res.rows[0]
    return {
      allowedActions: row.allowed_actions ?? [],
      blockedActions: row.blocked_actions ?? [],
      requiresApproval: row.requires_approval ?? [],
      maxTokensPerMessage: row.max_tokens_per_message,
      maxMessagesPerConversation: row.max_messages_per_conversation,
    }
  } catch (err) {
    // Fail open — policy errors must never block execution
    console.error('[policy] fetchAgentPolicy error:', (err as Error).message)
    return {
      allowedActions: [],
      blockedActions: [],
      requiresApproval: [],
      maxTokensPerMessage: null,
      maxMessagesPerConversation: null,
    }
  }
}

export async function fetchWorkingMemory(
  tenantId: string
): Promise<string | null> {
  const p = getPool()
  try {
    const res = await p.query<{ value: string }>(
      `SELECT value FROM mastra.mastra_resources
       WHERE "resourceId" = $1
       AND type = 'workingMemory'
       LIMIT 1`,
      [tenantId]
    )
    if (!res.rows[0]) return null
    const parsed = JSON.parse(res.rows[0].value)
    return typeof parsed === 'string'
      ? parsed
      : JSON.stringify(parsed)
  } catch {
    return null
  }
}

export async function checkTokenQuota(tenantId: string): Promise<QuotaCheckResult> {
  const p = getPool()
  try {
    const subRes = await p.query<{ plan: string }>(
      `SELECT plan FROM subscriptions
       WHERE tenant_id = $1 AND status IN ('active', 'trialing')
       LIMIT 1`,
      [tenantId],
    )
    const plan = subRes.rows[0]?.plan ?? 'free'

    const overrideRes = await p.query<{ value_limit: number | null; unlimited: boolean }>(
      `SELECT tfo.value_limit, tfo.unlimited
       FROM tenant_feature_overrides tfo
       JOIN features f ON f.id = tfo.feature_id
       WHERE tfo.tenant_id = $1
         AND f.key = 'llm_tokens'
         AND tfo.revoked_at IS NULL
         AND tfo.deleted_at IS NULL
         AND (tfo.expires_at IS NULL OR tfo.expires_at > NOW())
       LIMIT 1`,
      [tenantId],
    )

    let valueLimit: number | null = null
    let unlimited = false

    if (overrideRes.rows.length > 0) {
      valueLimit = overrideRes.rows[0].value_limit
      unlimited = overrideRes.rows[0].unlimited
    } else {
      const planRes = await p.query<{ value_limit: number | null; unlimited: boolean }>(
        `SELECT pe.value_limit, pe.unlimited
         FROM plan_entitlements pe
         JOIN features f ON f.id = pe.feature_id
         WHERE pe.plan = $1
           AND f.key = 'llm_tokens'
           AND f.status = 'active'
         LIMIT 1`,
        [plan],
      )
      if (planRes.rows.length > 0) {
        valueLimit = planRes.rows[0].value_limit
        unlimited = planRes.rows[0].unlimited
      }
    }

    if (unlimited) return { allowed: true, used: 0, limit: null, unlimited: true }

    const usageRes = await p.query<{ used: string }>(
      `SELECT COALESCE(SUM(quantity), 0) AS used
       FROM usage_records
       WHERE tenant_id = $1
         AND metric IN ('input_tokens', 'output_tokens')
         AND recorded_at >= date_trunc('month', NOW())`,
      [tenantId],
    )
    const used = parseInt(usageRes.rows[0]?.used ?? '0', 10)

    if (valueLimit === null) {
      // Missing entitlement config — fail open
      console.warn(`[quota] no llm_tokens entitlement for tenantId=${tenantId} plan=${plan} — allowing`)
      return { allowed: true, used, limit: null, unlimited: false }
    }

    return { allowed: used < valueLimit, used, limit: valueLimit, unlimited: false }
  } catch (err) {
    console.error('[quota] checkTokenQuota error:', (err as Error).message)
    return { allowed: true, used: 0, limit: null, unlimited: false }
  }
}

export function recordUsage(record: UsageRecord): void {
  const { tenantId, actorId, apiKeyId = null, inputTokens, outputTokens } = record
  const p = getPool()
  const sql = `INSERT INTO usage_records (tenant_id, actor_id, actor_type, metric, quantity, api_key_id)
               VALUES ($1, $2, 'agent', $3, $4, $5)`

  // one row per metric — all fire-and-forget
  p.query(sql, [tenantId, actorId, 'messages', 1, apiKeyId])
    .catch((err: Error) => { console.error('[usage] failed to record messages:', err.message) })

  if (inputTokens !== undefined) {
    p.query(sql, [tenantId, actorId, 'input_tokens', inputTokens, apiKeyId])
      .catch((err: Error) => { console.error('[usage] failed to record input_tokens:', err.message) })
  }

  if (outputTokens !== undefined) {
    p.query(sql, [tenantId, actorId, 'output_tokens', outputTokens, apiKeyId])
      .catch((err: Error) => { console.error('[usage] failed to record output_tokens:', err.message) })
  }
}

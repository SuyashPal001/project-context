import pg from 'pg'
import { makeAppPool } from './db.js'
import { db } from '@serverless-saas/database'
import { getAgentTools } from '@serverless-saas/ai'

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

/**
 * Composition caps. These are a prompt budget, not a product limit: every
 * composed body is injected into the system prompt on every turn, so an
 * unbounded skill set silently eats the context window the conversation needs.
 * The API enforces the same two numbers at attach time (see the attach route),
 * where exceeding them is a visible rejection rather than a silent drop.
 */
export const MAX_ATTACHED_SKILLS = 8
export const MAX_COMPOSED_SKILL_CHARS = 24_000

export interface ComposedAgentSkills {
  /** Every active skill's body, composed in attachment order. Null when none. */
  systemPrompt: string | null
  /** Every install that made it into the prompt — all of them get a run count. */
  installIds: string[]
  /** Skills excluded by a cap. Non-empty only for agents that predate the caps. */
  droppedNames: string[]
}

/**
 * Every active skill attached to the agent, composed into one prompt section.
 *
 * This used to be `LIMIT 1`, which meant only the newest attached skill ever
 * reached the model and attaching a second one silently switched the first
 * off. Ordering is `created_at ASC` — attachment order — so the composed
 * prompt is stable from turn to turn rather than reshuffling under the model.
 */
export async function fetchAgentSkills(agentId: string): Promise<ComposedAgentSkills> {
  const p = getPool()
  const res = await p.query<{ name: string; system_prompt: string | null; install_id: string | null; version: number }>(
    `SELECT name, system_prompt, install_id, version FROM agent_skills
     WHERE agent_id = $1 AND status = 'active'
     ORDER BY created_at ASC`,
    [agentId],
  )

  // agent_skills is unique on (agent_id, tenant_id, name, version), and the
  // attach route lets a caller re-attach the same skill name at a new version
  // without deactivating the old row — so two active rows can share a name.
  // Dedupe to the highest version per name, before caps are applied, or a
  // superseded version and its replacement both land in the prompt and
  // contradict each other. A Map preserves the key's first-insertion
  // position when its value is overwritten, so this keeps attachment order.
  const byName = new Map<string, (typeof res.rows)[number]>()
  for (const row of res.rows) {
    const existing = byName.get(row.name)
    if (!existing || row.version > existing.version) {
      byName.set(row.name, row)
    }
  }

  const parts: string[] = []
  const installIds: string[] = []
  const droppedNames: string[] = []
  let budget = MAX_COMPOSED_SKILL_CHARS

  for (const row of byName.values()) {
    const body = row.system_prompt?.trim()
    if (!body) continue
    // The composed cost is the body plus its "## Skill: <name>\n\n" header —
    // budgeting body.length alone lets the joined output exceed the cap it's
    // meant to enforce.
    const cost = body.length + row.name.length + 15
    // Gate on how many skills actually compose, not on how many carry an
    // install id — agent_skills.install_id is nullable for hand-authored
    // skills, so keying the cap off installIds.length would let an agent
    // with only hand-authored rows bypass the count cap entirely.
    if (parts.length >= MAX_ATTACHED_SKILLS || cost > budget) {
      droppedNames.push(row.name)
      continue
    }
    budget -= cost
    parts.push(`## Skill: ${row.name}\n\n${body}`)
    if (row.install_id) installIds.push(row.install_id)
  }

  if (droppedNames.length > 0) {
    // Loud on purpose: these skills are attached but not running, and nothing
    // in the UI says so. Attach-time rejection prevents new cases; this only
    // fires for agents that were over the cap before the caps existed.
    console.error(`[skills] agent=${agentId} dropped ${droppedNames.length} skill(s) over cap: ${droppedNames.join(', ')}`)
  }

  return {
    systemPrompt: parts.length > 0 ? parts.join('\n\n') : null,
    installIds,
    droppedNames,
  }
}

/**
 * One run per composed install per chat message. Sequential rather than
 * parallel: this is fire-and-forget bookkeeping behind a live stream, and a
 * burst of concurrent writes is not worth the pool pressure.
 */
export async function recordSkillRuns(installIds: string[], tenantId: string): Promise<void> {
  const p = getPool()
  for (const installId of installIds) {
    await p.query(
      `UPDATE skill_installs SET run_count = run_count + 1, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [installId, tenantId],
    )
  }
}

export async function fetchAgentPersonality(agentId: string): Promise<string | null> {
  const p = getPool()
  const res = await p.query<{
    base_personality: string | null
    identity_file: string | null
    soul_file: string | null
    agents_file: string | null
    bootstrap_file: string | null
    user_file: string | null
  }>(
    `SELECT p.base_personality, p.identity_file, p.soul_file, p.agents_file, p.bootstrap_file, p.user_file
     FROM agents a
     JOIN personas p ON p.id = a.persona_id
     WHERE a.id = $1`,
    [agentId],
  )
  const row = res.rows[0]
  if (!row?.base_personality) return null
  // Fixed composition order: identity, soul, operating instructions, bootstrap,
  // then user-facing context — matches the Core Files tab order in the UI.
  const layers = [row.base_personality, row.identity_file, row.soul_file, row.agents_file, row.bootstrap_file, row.user_file]
  return layers.filter((layer): layer is string => Boolean(layer)).join('\n\n')
}

export async function fetchAgentMemory(agentId: string): Promise<string | null> {
  const p = getPool()
  const res = await p.query<{ content: string }>(
    `SELECT content FROM agent_memories WHERE agent_id = $1`,
    [agentId],
  )
  return res.rows[0]?.content ?? null
}

export interface AgentModelSelection {
  provider: string
  model: string
  status: string
}

export async function fetchAgentModelSelection(agentId: string): Promise<AgentModelSelection | null> {
  const p = getPool()
  const res = await p.query<{ provider: string; model: string; status: string }>(
    `SELECT lp.provider, lp.model, lp.status
     FROM agents a
     JOIN llm_providers lp ON lp.id = a.llm_provider_id
     WHERE a.id = $1
       AND (lp.is_platform = true OR lp.tenant_id = a.tenant_id)`,
    [agentId],
  )
  const row = res.rows[0]
  if (!row) return null
  return { provider: row.provider, model: row.model, status: row.status }
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
  try {
    const { requiresApprovalTools, highStakeTools } = await getAgentTools(db, tenantId, agentId, connectedProviders)
    return { requiresApprovalTools, highStakeTools }
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

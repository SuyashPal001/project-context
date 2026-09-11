import pg from 'pg'
import { makeAppPool } from './db.js'
import { db } from '@serverless-saas/database'
import { getAgentTools } from '@serverless-saas/ai'
import { createSkill } from '@mastra/core/skills'
import type { InlineSkill } from '@mastra/core/skills'
import { CODE_SPEC_IDS } from './mastra/subagents/ids.js'

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
 * Mastra requires a skill `name` of 1-64 lowercase letters/numbers/hyphens
 * (InlineSkillInput, @mastra/core/skills types.d.ts) — createSkill() throws
 * otherwise. agent_skills.name and the skills catalog's display name are
 * free text ("UGC Ad Production"), never guaranteed to already be in that
 * shape, so every name is slugified before it reaches createSkill().
 */
export function toMastraSkillName(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64).replace(/^-+|-+$/g, '')
  return slug || 'skill'
}

/**
 * Resolves an installed skill's current, pinned-version content — name,
 * agent-facing description, and body. The description comes from
 * skill_versions.manifest->>'description' (the frontmatter description the
 * quality bar enforces — see 2026-09-08-skill-quality-bar-design.md), never
 * skills.description, which is a separate cosmetic dashboard subtitle.
 * Shared by fetchTestSkill and fetchAttachedSkills so both read content the
 * same way. Mirrors resolveInstall/resolveInstalledSkillBody in the API
 * package's agent-skills.ts, via the orchestrator's raw pg pool since it has
 * no drizzle access. Tenant-scoped: a wrong-tenant or unready installId
 * resolves to null rather than leaking cross-tenant content.
 */
async function resolveInstalledSkillContent(installId: string, tenantId: string): Promise<{ name: string; description: string; body: string } | null> {
  const p = getPool()
  try {
    const res = await p.query<{ name: string; description: string | null; body: string | null }>(
      `SELECT s.name, sv.manifest->>'description' AS description, sv.manifest->>'body' AS body
       FROM skill_installs si
       JOIN skills s ON s.id = si.skill_id
       JOIN skill_versions sv ON sv.skill_id = si.skill_id AND sv.version = si.installed_version
       WHERE si.id = $1 AND si.tenant_id = $2 AND si.status = 'active' AND sv.status = 'ready'
       LIMIT 1`,
      [installId, tenantId],
    )
    const row = res.rows[0]
    const body = row?.body?.trim()
    if (!row || !body) return null
    const description = (row.description?.trim() || `Use when the task matches "${row.name}".`).slice(0, 1024)
    return { name: row.name, description, body }
  } catch (err) {
    console.error('[usage] resolveInstalledSkillContent error:', (err as Error).message)
    return null
  }
}

/**
 * Resolves ONE skill for a Test-in-chat conversation — bypassing
 * agent_skills entirely. Testing a skill must never touch the agent's real,
 * permanent skillset (see fetchConversationTestSkillInstallId in
 * persistence.ts), so this never reads or writes that table. Records a run
 * immediately since this call IS the run — there is no later composition
 * step to attach it to.
 */
export async function fetchTestSkill(installId: string, tenantId: string): Promise<InlineSkill | null> {
  const content = await resolveInstalledSkillContent(installId, tenantId)
  if (!content) return null
  recordSkillRuns([installId], tenantId).catch((err) => console.warn('[usage] fetchTestSkill recordSkillRuns failed:', (err as Error).message))
  try {
    return createSkill({ name: toMastraSkillName(content.name), description: content.description, instructions: content.body })
  } catch (err) {
    console.error('[usage] fetchTestSkill createSkill validation failed:', (err as Error).message)
    return null
  }
}

/**
 * Every active skill attached to the agent (excluding "default" — the
 * onboarding bootstrap row holding the agent's base persona, not a real
 * skill; read separately by fetchAgentPersonaPrompt), as native Mastra Skill
 * objects for the agent's `skills:` resolver.
 *
 * `tenantId` is required and filtered on, not just passed for logging:
 * agent_skills carries agent_id and tenant_id as two independent foreign
 * keys, so a row whose agent belongs to another tenant is representable.
 * Querying by agent_id alone would hand that row to this tenant's agent.
 *
 * Two content sources, by row shape:
 * - install_id set (the normal case — dashboard/"/" picker attach): content
 *   is resolved fresh from the pinned skill_installs/skill_versions, same as
 *   fetchTestSkill — the row's own stored system_prompt is never read, so an
 *   installed skill always reflects its current pinned version.
 * - install_id null (hand-authored — the in-chat create_skill path can
 *   attach a skill with no catalog install, per agent-skills.ts's POST
 *   schema): there is no install to resolve, so the row's own name/
 *   system_prompt IS the content. No stored "when to use" description exists
 *   for this case, so one is synthesized from the name — a known limitation
 *   versus an installed skill's real frontmatter description.
 */
export async function fetchAttachedSkills(agentId: string, tenantId: string): Promise<InlineSkill[]> {
  const p = getPool()
  const res = await p.query<{ name: string; system_prompt: string | null; install_id: string | null; version: number }>(
    `SELECT name, system_prompt, install_id, version FROM agent_skills
     WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active' AND name != 'default'
     ORDER BY created_at ASC, id ASC`,
    [agentId, tenantId],
  )

  // agent_skills is unique on (agent_id, tenant_id, name, version), and the
  // attach route lets a caller re-attach the same skill name at a new
  // version without deactivating the old row — so two active rows can share
  // a name. Dedupe to the highest version per name. A Map preserves the
  // key's first-insertion position when its value is overwritten, so this
  // keeps attachment order.
  const byName = new Map<string, (typeof res.rows)[number]>()
  for (const row of res.rows) {
    const existing = byName.get(row.name)
    if (!existing || row.version > existing.version) byName.set(row.name, row)
  }

  const skills: InlineSkill[] = []
  const installIds: string[] = []
  for (const row of byName.values()) {
    if (row.install_id) {
      const content = await resolveInstalledSkillContent(row.install_id, tenantId)
      if (!content) continue
      try {
        skills.push(createSkill({ name: toMastraSkillName(content.name), description: content.description, instructions: content.body }))
      } catch (err) {
        console.error('[usage] fetchAttachedSkills createSkill validation failed for', row.name, ':', (err as Error).message)
        continue
      }
      installIds.push(row.install_id)
    } else {
      const body = row.system_prompt?.trim()
      if (!body) continue
      try {
        skills.push(createSkill({
          name: toMastraSkillName(row.name),
          description: `Use when the task matches "${row.name}".`,
          instructions: body,
        }))
      } catch (err) {
        console.error('[usage] fetchAttachedSkills createSkill validation failed for', row.name, ':', (err as Error).message)
        continue
      }
    }
  }

  if (installIds.length > 0) {
    recordSkillRuns(installIds, tenantId).catch((err) => console.warn('[usage] fetchAttachedSkills recordSkillRuns failed:', (err as Error).message))
  }

  return skills
}

/**
 * The agent's base prompt, from agents.system_prompt. Null means the
 * agent uses the platform prompt (platformAgent's fetchPlatformPrompt).
 * Used by chatStream.ts and mastra/agent.ts as the agentSystemPrompt
 * override. It used to live on a 'default' agent_skills row; see
 * docs/superpowers/specs/2026-09-11-agent-skills-model-design.md.
 */
export async function fetchAgentPersonaPrompt(agentId: string, tenantId: string): Promise<string | null> {
  const p = getPool()
  try {
    const res = await p.query<{ system_prompt: string | null }>(
      `SELECT system_prompt FROM agents
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [agentId, tenantId],
    )
    const body = res.rows[0]?.system_prompt?.trim()
    return body || null
  } catch (err) {
    console.error('[usage] fetchAgentPersonaPrompt error:', (err as Error).message)
    return null
  }
}

/**
 * Does this agent belong to this tenant? The chat route takes `agentId` off the
 * request body while `tenantId` comes from the verified JWT, so without this the
 * two are never compared and a user in tenant A can drive tenant B's agent —
 * and, via create_skill, write a skill row pointed at it. Fails closed: a query
 * error is treated as "no", because the only caller is a security gate.
 */
export async function agentBelongsToTenant(agentId: string, tenantId: string): Promise<boolean> {
  if (!agentId || !tenantId) return false
  const p = getPool()
  try {
    const res = await p.query<{ id: string }>(
      'SELECT id FROM agents WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [agentId, tenantId],
    )
    return res.rows.length > 0
  } catch (err) {
    console.error('[usage] agentBelongsToTenant error:', (err as Error).message)
    return false
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

/**
 * The sub-agent ids this tenant may use: every platform-owned spec, plus any
 * published template this tenant owns. Ownership only — install rows are not
 * built until tenants can share sub-agents with each other, and when they are,
 * only this function changes.
 *
 * Fails OPEN, unlike the credit checks: a bad filter here is invisible — Olmo
 * silently lacks a capability and does the job badly, with no signal to anyone
 * that something was hidden.
 */
type AllowedSetPool = { query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ name: string }> }> }

export async function fetchAllowedSubAgents(
  tenantId: string,
  // Resolved inside the try, not as a default parameter: a default is
  // evaluated before the body runs, so a throwing getPool() would reject this
  // function instead of failing open — and on SSE that rejects the whole
  // Promise.all and the turn with it.
  pool?: AllowedSetPool,
): Promise<string[]> {
  const codeSpecIds = [...CODE_SPEC_IDS]
  if (!tenantId) return codeSpecIds
  try {
    const p: AllowedSetPool = pool ?? (getPool() as never)
    const res = await p.query(
      `SELECT name FROM agent_templates
        WHERE (tenant_id IS NULL OR tenant_id = $1)
          AND status = 'published'`,
      [tenantId],
    )
    return [...new Set([...codeSpecIds, ...res.rows.map(r => r.name)])]
  } catch (err) {
    console.error(`[subagents] allowed-set lookup failed tenantId=${tenantId}, failing open:`, (err as Error).message)
    return codeSpecIds
  }
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

/**
 * String form of the agent's attached skills, for background-task agents
 * created fresh via createTenantAgent (Tasks execution, document planning)
 * — these are NOT live per-request Mastra Agents, so they can't use the
 * skills: resolver's InlineSkill[] directly; they need a plain instructions
 * string at creation time instead. Thin wrapper over fetchAttachedSkills —
 * reuses its tenant-scoped query and recordSkillRuns wiring rather than
 * re-querying or re-composing. Returns null (not '') when there are no
 * attached skills, matching the old fetchAgentSkills().systemPrompt
 * contract these callers already null-coalesce against.
 */
export async function fetchAgentSkillsPrompt(agentId: string, tenantId: string): Promise<string | null> {
  const skills = await fetchAttachedSkills(agentId, tenantId)
  if (skills.length === 0) return null
  return skills.map((s) => `## Skill: ${s.name}\n\n${s.instructions}`).join('\n\n')
}

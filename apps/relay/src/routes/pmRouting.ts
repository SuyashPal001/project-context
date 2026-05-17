import pg from 'pg'

// ── PM session tracking ───────────────────────────────────────────────────────
// Keeps routing to pmAgent through the clarifying-questions phase, before any
// draft is saved to the DB. Lost on relay restart (acceptable for ~minute sessions).

const _pmSessions = new Map<string, number>() // conversationId → expiresAt ms
const PM_SESSION_TTL_MS = 2 * 60 * 60 * 1000  // 2 hours

export function markPmSession(conversationId: string): void {
  _pmSessions.set(conversationId, Date.now() + PM_SESSION_TTL_MS)
}

export function isPmSession(conversationId: string): boolean {
  const exp = _pmSessions.get(conversationId)
  if (!exp) return false
  if (Date.now() > exp) { _pmSessions.delete(conversationId); return false }
  return true
}

// ── PM intent routing ────────────────────────────────────────────────────────

const PM_SIGNALS = [
  // PRD
  'create a prd', 'write a prd', 'draft a prd', 'generate a prd',
  'product requirements', 'prd for', 'requirements document', 'i need a prd',
  'product spec', 'feature spec',
  // Roadmap / plan
  'create a roadmap', 'build a roadmap', 'write a roadmap',
  'generate a roadmap', 'generate roadmap', 'make a roadmap',
  'roadmap from', 'roadmap for',
  'create a plan', 'build a plan', 'generate a plan', 'generate plan',
  'project plan', 'release plan', 'execution plan',
  'create milestones', 'generate milestones', 'build milestones',
  'now generate', 'next step', 'next phase',
  // Tasks
  'create tasks', 'generate tasks', 'break down into tasks',
  'create a task list', 'generate a task list', 'break it down',
  'create subtasks', 'break down the', 'task breakdown',
]

export function isPmIntent(msg: string): boolean {
  const lower = msg.toLowerCase()
  return PM_SIGNALS.some(s => lower.includes(s))
}

// ── Draft PRD fetch ──────────────────────────────────────────────────────────

let _pmPool: pg.Pool | null = null

function getPmPool(): pg.Pool {
  if (!_pmPool) {
    _pmPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pmPool.on('error', (err) => { console.error('[pm] pool error:', err.message) })
  }
  return _pmPool
}

export async function fetchPrdDraft(
  agentId: string,
  tenantId: string,
): Promise<{ id: string; content: string; status: string } | null> {
  const client = await getPmPool().connect()
  try {
    // Include 'approved' so post-approval roadmap requests still route to pmAgent
    const { rows } = await client.query<{ id: string; content: string; status: string }>(
      `SELECT id, content, status FROM agent_prds
       WHERE agent_id = $1 AND tenant_id = $2 AND status IN ('draft', 'approved')
       ORDER BY updated_at DESC LIMIT 1`,
      [agentId, tenantId],
    )
    return rows[0] ?? null
  } finally {
    client.release()
  }
}

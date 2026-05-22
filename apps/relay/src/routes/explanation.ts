import { Hono } from 'hono'
import { validateToken } from '../auth.js'
import { getPool } from '../usage.js'

export const explanationRouter = new Hono()

interface SpanRow {
  threadId: string
  resourceId: string
  name: string
  spanType: string
  input: unknown
  output: unknown
  startedAt: string
  endedAt: string | null
}

interface ExplanationStep {
  type: 'memory_recall' | 'tool_call' | 'llm_generation' | 'memory_save' | 'agent_run'
  at: string
  detail: Record<string, unknown>
}

explanationRouter.get('/api/conversations/:conversationId/explanation', async (c) => {
  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  let payload: Awaited<ReturnType<typeof validateToken>>
  try { payload = await validateToken(token) } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const tenantId = payload['custom:tenantId'] ?? ''
  const conversationId = c.req.param('conversationId')
  if (!conversationId) return c.json({ error: 'conversationId required' }, 400)

  const pool = getPool()

  // Fetch all spans for this conversation — resourceId check enforces tenant isolation
  const { rows } = await pool.query<SpanRow>(
    `SELECT "threadId", "resourceId", name, "spanType",
            input, output,
            "startedAt"::text, "endedAt"::text
     FROM mastra.mastra_ai_spans
     WHERE "threadId" = $1
       AND "resourceId" = $2
     ORDER BY "startedAt" ASC`,
    [conversationId, tenantId],
  )

  if (rows.length === 0) {
    return c.json({ error: 'Conversation not found or access denied' }, 404)
  }

  // Build structured explanation from raw spans
  const steps: ExplanationStep[] = []
  let agentName = 'unknown'
  let startedAt = rows[0].startedAt
  let endedAt = rows[rows.length - 1].endedAt ?? rows[rows.length - 1].startedAt

  for (const row of rows) {
    switch (row.spanType) {
      case 'agent_run': {
        agentName = String(row.name).replace(/^agent run: '|'$/g, '')
        startedAt = row.startedAt
        if (row.endedAt) endedAt = row.endedAt
        steps.push({ type: 'agent_run', at: row.startedAt, detail: { agent: agentName } })
        break
      }
      case 'memory_operation': {
        if (row.name === 'memory: recall') {
          steps.push({ type: 'memory_recall', at: row.startedAt, detail: {} })
        } else if (row.name === 'memory: save') {
          steps.push({ type: 'memory_save', at: row.startedAt, detail: {} })
        }
        break
      }
      case 'tool_call': {
        const toolName = String(row.name).replace(/^tool: '|'$/g, '')
        const inp = (row.input ?? {}) as Record<string, unknown>
        const out = (row.output ?? {}) as Record<string, unknown>

        if (toolName === 'retrieve_knowledge') {
          // Truncate retrieved context — can be very large
          const context = typeof out.context === 'string'
            ? out.context.slice(0, 800) + (out.context.length > 800 ? '…' : '')
            : null
          steps.push({
            type: 'tool_call', at: row.startedAt,
            detail: { tool: toolName, query: inp.query ?? inp.input, retrievedContext: context },
          })
        } else {
          steps.push({
            type: 'tool_call', at: row.startedAt,
            detail: { tool: toolName, input: inp },
          })
        }
        break
      }
      case 'model_generation': {
        const model = String(row.name).replace(/^llm: '|'$/g, '')
        steps.push({ type: 'llm_generation', at: row.startedAt, detail: { model } })
        break
      }
    }
  }

  return c.json({
    conversationId,
    tenantId,
    agentName,
    startedAt,
    endedAt,
    totalSpans: rows.length,
    steps,
  })
})

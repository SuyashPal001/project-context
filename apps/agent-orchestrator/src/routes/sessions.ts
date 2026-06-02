import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { getAllowedOrigin, INTERNAL_SERVICE_KEY, sseApprovalChannels, pendingMcpApprovals } from '../types.js'
import { validateToken } from '../auth.js'

export const sessionsRouter = new Hono()

sessionsRouter.options('/api/chat/approval', (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})

// ─── MCP write-tool approval — called by mcp-server before executing a write tool ──
sessionsRouter.post('/mcp/approval-request', async (c) => {
  const serviceKey = c.req.header('x-internal-service-key') ?? ''
  const keyA = Buffer.from(serviceKey)
  const keyB = Buffer.from(INTERNAL_SERVICE_KEY)
  if (!serviceKey || keyA.length !== keyB.length || !timingSafeEqual(keyA, keyB)) {
    return c.json({ approved: false, reason: 'unauthorized' }, 401)
  }

  let body: { tenantId?: unknown; sessionId?: unknown; approvalId?: unknown; toolName?: unknown; args?: unknown }
  try { body = await c.req.json() } catch { return c.json({ approved: false, reason: 'invalid_body' }, 400) }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : ''
  const toolName   = typeof body.toolName  === 'string' ? body.toolName  : 'unknown_tool'
  const args       = (typeof body.args === 'object' && body.args !== null) ? body.args as Record<string, unknown> : {}

  if (!approvalId) return c.json({ approved: false, reason: 'approvalId_required' }, 400)

  const send = sseApprovalChannels.get(sessionId)
  if (!send) {
    console.log(`[mcp-approval] no active session sessionId=${sessionId} tool=${toolName} — auto-deny`)
    return c.json({ approved: false, reason: 'no_active_session' })
  }

  console.log(`[mcp-approval] approval_request sessionId=${sessionId} approvalId=${approvalId} tool=${toolName}`)
  send({ type: 'approval_request', approvalId, toolName, description: `Agent wants to ${toolName.replace(/_/g, ' ')}`, arguments: args })

  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingMcpApprovals.delete(approvalId)
      console.log(`[mcp-approval] timeout approvalId=${approvalId} tool=${toolName} — auto-deny`)
      resolve(false)
    }, 30_000)
    pendingMcpApprovals.set(approvalId, { resolve, timer })
  })

  console.log(`[mcp-approval] resolved approvalId=${approvalId} tool=${toolName} approved=${approved}`)
  return c.json({ approved })
})

// ─── MCP approval decision — called by frontend after user approves/denies ──
sessionsRouter.post('/api/chat/approval', async (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }

  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)

  try { await validateToken(token) } catch {
    return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)
  }

  let body: { approvalId?: unknown; decision?: unknown }
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid_body' }, 400, corsHeaders) }

  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : ''
  const decision   = typeof body.decision   === 'string' ? body.decision.trim()   : ''
  if (!approvalId) return c.json({ ok: false, error: 'approvalId required' }, 400, corsHeaders)

  const pending = pendingMcpApprovals.get(approvalId)
  if (!pending) return c.json({ ok: false, error: 'approval_not_found' }, 404, corsHeaders)

  clearTimeout(pending.timer)
  pendingMcpApprovals.delete(approvalId)
  pending.resolve(decision === 'allow' || decision === 'approved')

  return c.json({ ok: true }, 200, corsHeaders)
})

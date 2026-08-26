import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { getAllowedOrigin, INTERNAL_SERVICE_KEY, sseApprovalChannels, pendingMcpApprovals, pendingClarifications, type ClarificationAnswer } from '../types.js'
import { validateToken } from '../auth.js'
import { updateClarificationRequest, saveApprovalRequest, updateApprovalRequest } from '../persistence.js'

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

sessionsRouter.options('/api/chat/clarification', (c) => {
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
  const tenantId   = typeof body.tenantId === 'string' ? body.tenantId : ''

  if (!approvalId) return c.json({ approved: false, reason: 'approvalId_required' }, 400)

  const session = sseApprovalChannels.get(sessionId)
  if (!session) {
    console.log(`[mcp-approval] no active session sessionId=${sessionId} tool=${toolName} — auto-deny`)
    return c.json({ approved: false, reason: 'no_active_session' })
  }

  const description = `Agent wants to ${toolName.replace(/_/g, ' ')}`
  const approvalMessageId = crypto.randomUUID()
  console.log(`[mcp-approval] approval_request sessionId=${sessionId} approvalId=${approvalId} tool=${toolName}`)
  session.send({ type: 'approval_request', approvalId, toolName, description, arguments: args })

  saveApprovalRequest(session.idToken, session.conversationId, approvalMessageId, {
    id: approvalId,
    toolName,
    arguments: args,
    description,
    status: 'pending',
  })

  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingMcpApprovals.get(approvalId)
      pendingMcpApprovals.delete(approvalId)
      console.log(`[mcp-approval] timeout approvalId=${approvalId} tool=${toolName} — auto-deny`)
      resolve(false)

      if (pending?.messageId && pending?.conversationId && pending?.idToken) {
        updateApprovalRequest(pending.idToken, pending.conversationId, pending.messageId, {
          status: 'dismissed',
          decisionAt: new Date().toISOString(),
        })
      }
    }, 30_000)
    pendingMcpApprovals.set(approvalId, {
      resolve, timer, tenantId,
      messageId: approvalMessageId,
      conversationId: session.conversationId,
      idToken: session.idToken,
    })
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

  let callerTenantId = ''
  try {
    const payload = await validateToken(token)
    callerTenantId = payload['custom:tenantId'] ?? ''
  } catch {
    return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)
  }

  let body: { approvalId?: unknown; decision?: unknown }
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid_body' }, 400, corsHeaders) }

  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : ''
  const decision   = typeof body.decision   === 'string' ? body.decision.trim()   : ''
  if (!approvalId) return c.json({ ok: false, error: 'approvalId required' }, 400, corsHeaders)

  const pending = pendingMcpApprovals.get(approvalId)
  if (!pending) return c.json({ ok: false, error: 'approval_not_found' }, 404, corsHeaders)
  if (!callerTenantId || pending.tenantId !== callerTenantId) {
    return c.json({ ok: false, error: 'approval_not_found' }, 404, corsHeaders)
  }

  clearTimeout(pending.timer)
  pendingMcpApprovals.delete(approvalId)
  const wasApproved = decision === 'allow' || decision === 'approved'
  pending.resolve(wasApproved)

  if (pending.messageId && pending.conversationId && pending.idToken) {
    updateApprovalRequest(pending.idToken, pending.conversationId, pending.messageId, {
      status: wasApproved ? 'approved' : 'dismissed',
      decisionAt: new Date().toISOString(),
    })
  }

  return c.json({ ok: true }, 200, corsHeaders)
})

// ─── Clarification answer — called by frontend as each ClarificationCard question is answered ──
sessionsRouter.post('/api/chat/clarification', async (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }

  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)

  let callerTenantId = ''
  try {
    const payload = await validateToken(token)
    callerTenantId = payload['custom:tenantId'] ?? ''
  } catch {
    return c.json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders)
  }

  let body: { clarificationId?: unknown; questionIndex?: unknown; selectedIndex?: unknown; freeText?: unknown; skipped?: unknown }
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: 'invalid_body' }, 400, corsHeaders) }

  const clarificationId = typeof body.clarificationId === 'string' ? body.clarificationId.trim() : ''
  const questionIndex = typeof body.questionIndex === 'number' ? body.questionIndex : -1
  if (!clarificationId || !Number.isInteger(questionIndex) || questionIndex < 0) {
    return c.json({ ok: false, error: 'clarificationId and questionIndex required' }, 400, corsHeaders)
  }

  const pending = pendingClarifications.get(clarificationId)
  if (!pending) return c.json({ ok: false, error: 'clarification_not_found' }, 404, corsHeaders)
  // Tenant-scoped only, matching /api/chat/approval just above — pending.userId
  // is the internal auth-service UUID (resolved via /auth/me when the
  // clarification was created) while callerUserId here is the raw Cognito
  // `sub` straight off the JWT. Those are different identifier spaces and are
  // essentially never equal, so comparing them made every real answer 404.
  if (!callerTenantId || pending.tenantId !== callerTenantId) {
    return c.json({ ok: false, error: 'clarification_not_found' }, 404, corsHeaders)
  }

  // We only have `expectedCount` at this layer (the question/option definitions
  // live in the tool that issued the clarification, not in pendingClarifications),
  // so this is the one bound we can enforce here. `questionIndex` out of range
  // would otherwise sit in `pending.collected` as a phantom answer that never
  // matches a real question and can never be overwritten by a corrected retry.
  if (questionIndex >= pending.expectedCount) {
    return c.json({ ok: false, error: 'questionIndex out of range' }, 400, corsHeaders)
  }

  const MAX_FREE_TEXT_LEN = 2000
  if (typeof body.freeText === 'string' && body.freeText.length > MAX_FREE_TEXT_LEN) {
    return c.json({ ok: false, error: 'freeText too long' }, 400, corsHeaders)
  }

  const answer: ClarificationAnswer = {
    questionIndex,
    // selectedIndex isn't bounds-checked here — this layer doesn't know the
    // target question's option count (only `expectedCount`, the question
    // total). askClarifyingQuestions.ts's optional chaining on
    // `questions[a.questionIndex]?.options[a.selectedIndex]?.label` already
    // degrades an out-of-range value to `undefined` rather than crashing.
    selectedIndex: typeof body.selectedIndex === 'number' && Number.isInteger(body.selectedIndex) && body.selectedIndex >= 0
      ? body.selectedIndex
      : undefined,
    freeText: typeof body.freeText === 'string' ? body.freeText : undefined,
    skipped: body.skipped === true,
  }
  const existingIndex = pending.collected.findIndex((a) => a.questionIndex === questionIndex)
  if (existingIndex >= 0) {
    pending.collected[existingIndex] = answer
  } else {
    pending.collected.push(answer)
  }

  // Persist partial progress after every answer so a page reload can restore
  // mid-flow state. Fire-and-forget — don't block the response on this.
  if (pending.messageId && pending.conversationId && pending.idToken && pending.collected.length < pending.expectedCount) {
    const partialAnswers: Record<number, { selectedIndex?: number; freeText?: string; skipped?: boolean }> = {}
    for (const a of pending.collected) {
      partialAnswers[a.questionIndex] = { selectedIndex: a.selectedIndex, freeText: a.freeText, skipped: a.skipped }
    }
    updateClarificationRequest(pending.idToken, pending.conversationId, pending.messageId, {
      status: 'pending',
      answers: partialAnswers,
    })
  }

  if (pending.collected.length >= pending.expectedCount) {
    clearTimeout(pending.timer)
    pendingClarifications.delete(clarificationId)
    pending.resolve(pending.collected)

    if (pending.messageId && pending.conversationId && pending.idToken) {
      const allSkipped = pending.collected.every((a) => a.skipped === true)
      const answersMap: Record<number, { selectedIndex?: number; freeText?: string; skipped?: boolean }> = {}
      for (const a of pending.collected) {
        answersMap[a.questionIndex] = { selectedIndex: a.selectedIndex, freeText: a.freeText, skipped: a.skipped }
      }
      updateClarificationRequest(pending.idToken, pending.conversationId, pending.messageId, {
        status: allSkipped ? 'skipped' : 'answered',
        answers: answersMap,
        answeredAt: new Date().toISOString(),
      })
    }
  }

  return c.json({ ok: true, remaining: Math.max(0, pending.expectedCount - pending.collected.length) }, 200, corsHeaders)
})

import { Hono } from 'hono'
import type { AuthPayload } from '../auth.js'
import { validateToken } from '../auth.js'
import { checkMessageQuota, fetchAgentMemory } from '../usage.js'
import { filterPII } from '../pii-filter.js'
import { runChatStream } from './chatStream.js'
import { isInternalServiceKey } from '../service-key.js'
import {
  Attachment,
  getAllowedOrigin, INTERNAL_SERVICE_KEY, API_BASE_URL,
  sseApprovalChannels,
  sessionActiveClarification, pendingClarifications,
  checkRateLimit,
} from '../types.js'
import { updateClarificationRequest } from '../persistence.js'

// ─── SSE chat endpoint ────────────────────────────────────────────────────────

export const chatRouter = new Hono()

chatRouter.options('/api/chat', (c) => {
  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Id-Token, Accept',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})

chatRouter.post('/api/chat', async (c) => {
  // 1. Auth — same JWT validation as WebSocket upgrade
  const serviceKey = c.req.header('X-Service-Key') ?? ''
  const isInternalCall = isInternalServiceKey(serviceKey)

  let payload: AuthPayload
  let idToken = ''

  if (isInternalCall) {
    // Internal Lambda bypass — skip Cognito validation
    // tenantId must be in request body; parsed below
    payload = {
      sub: 'internal-service',
      email: 'internal@service',
      'custom:tenantId': '',  // overwritten after body parse
    } as AuthPayload
  } else {
    const authHeader = c.req.header('Authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    // idToken used for API persistence calls
    idToken = c.req.header('X-Id-Token') ?? token

    if (!token) return c.json({ error: 'Unauthorized' }, 401)

    try {
      payload = await validateToken(token)
    } catch {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }
  // 2a. Rate limit — per authenticated user
  const rateLimitUserId = payload.sub ?? payload['cognito:username'] ?? 'unknown'
  if (!checkRateLimit(rateLimitUserId)) {
    return c.json({ error: 'Too many requests. Please wait a moment.' }, 429)
  }
  // 2. Parse + validate body
  let body: { conversationId?: unknown; message?: unknown; attachments?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
  const rawMessage = typeof body.message === 'string' ? body.message.trim() : ''
  const attachments: Attachment[] = Array.isArray(body.attachments) ? body.attachments : []
  const agentId = typeof (body as Record<string, unknown>).agentId === 'string' ? (body as Record<string, unknown>).agentId as string : ''
  const bodyTenantId = typeof (body as Record<string, unknown>).tenantId === 'string'
    ? (body as Record<string, unknown>).tenantId as string
    : ''
  const folderId = typeof (body as Record<string, unknown>).folderId === 'string'
    ? (body as Record<string, unknown>).folderId as string
    : undefined

  if (!conversationId || (!rawMessage && attachments.length === 0)) {
    return c.json({ error: 'conversationId and message or attachments are required' }, 400)
  }

  const { sanitized: filteredMessage, detections: chatPiiDetections } = filterPII(rawMessage)
  if (chatPiiDetections.length > 0) {
    console.log(`[pii-filter] chat userId=${payload.sub} masked: ${chatPiiDetections.map(d => `${d.type}×${d.count}`).join(' ')}`)
  }
  const message = filteredMessage || '[attachment]'

  const userId = payload.sub
  let internalUserId: string = userId

  const tenantId = isInternalCall
    ? (bodyTenantId || (payload['custom:tenantId'] ?? userId))
    : (payload['custom:tenantId'] ?? userId)

  if (isInternalCall && !tenantId) {
    return c.json({ error: 'tenantId required for internal service calls' }, 400)
  }

  // Parallel pre-stream fetches — auth/me, quota check, working memory run concurrently.
  // Per-agent memory (MEMORY.md), not per-tenant — each hired employee keeps
  // its own working notes rather than sharing one blob across a tenant's agents.
  const workingMemoryPromise = fetchAgentMemory(agentId)
  const [, chatQuota] = await Promise.all([
    // auth/me — resolve Cognito sub → internal UUID
    !isInternalCall
      ? fetch(`${API_BASE_URL}/api/v1/auth/me`, { headers: { 'Authorization': `Bearer ${idToken}` } })
          .then(async (meResp) => {
            if (meResp.ok) {
              const me = await meResp.json() as { id?: string }
              if (typeof me.id === 'string' && me.id) internalUserId = me.id
            } else {
              console.warn(`[sse] auth/me returned ${meResp.status} — falling back to Cognito sub`)
            }
          })
          .catch((err) => {
            console.warn('[sse] auth/me fetch failed — falling back to Cognito sub:', (err as Error).message)
          })
      : Promise.resolve(),
    // quota check
    !isInternalCall
      ? checkMessageQuota(tenantId)
      : Promise.resolve({ allowed: true, used: 0, limit: 0 } as const),
    // working memory runs concurrently; awaited inside the async handler below
    workingMemoryPromise,
  ])

  // Quota guard — checked before ReadableStream setup so we can return plain 429, not SSE error.
  if (!isInternalCall && !chatQuota.allowed) {
    console.warn(`[sse] tenantId=${tenantId} userId=${userId} quota exceeded used=${chatQuota.used} limit=${chatQuota.limit}`)
    return c.json({ error: 'Message quota exceeded', used: chatQuota.used, limit: chatQuota.limit }, 429)
  }

  const sessionId = crypto.randomUUID()

  console.log(`[sse:${sessionId}] user=${userId} conversationId=${conversationId}`)

  const startTime = Date.now()

  // 3. Set up SSE ReadableStream
  const encoder = new TextEncoder()
  let streamClosed = false
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  const sendEvent = (event: string, data: object): void => {
    if (streamClosed) return
    try {
      streamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    } catch {
      // enqueue after close — swallow
    }
  }

  const closeStream = (): void => {
    if (streamClosed) return
    streamClosed = true
    sseApprovalChannels.delete(sessionId)
    try { streamController.close() } catch {}
  }

  sseApprovalChannels.set(sessionId, {
    send: (payload) => sendEvent('approval_request', payload),
    conversationId,
    idToken,
  })

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
    },
    cancel() {
      console.log(`[sse:${sessionId}] client disconnected`)
      streamClosed = true
      sseApprovalChannels.delete(sessionId)
      // Resolve any pending clarification immediately so the server-side agent
      // doesn't stay blocked for up to 120s after the client has gone away.
      const clarId = sessionActiveClarification.get(sessionId)
      if (clarId) {
        const pending = pendingClarifications.get(clarId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingClarifications.delete(clarId)
          sessionActiveClarification.delete(sessionId)
          const collected = pending.collected
          pending.resolve(collected)
          if (pending.messageId && pending.conversationId && pending.idToken) {
            const allSkipped = collected.length === 0 || collected.every((a) => a.skipped === true)
            const answersMap: Record<number, { selectedIndex?: number; freeText?: string; skipped?: boolean }> = {}
            for (const a of collected) {
              answersMap[a.questionIndex] = { selectedIndex: a.selectedIndex, freeText: a.freeText, skipped: a.skipped }
            }
            updateClarificationRequest(pending.idToken, pending.conversationId, pending.messageId, {
              status: allSkipped ? 'skipped' : 'answered',
              answers: Object.keys(answersMap).length > 0 ? answersMap : undefined,
              answeredAt: new Date().toISOString(),
            })
          }
        }
      }
    },
  })

  // 4. Async handler — runs concurrently while response streams to client
  runChatStream({
    message, attachments, conversationId, tenantId,
    internalUserId, idToken, agentId, sessionId, startTime,
    workingMemoryPromise, sendEvent, closeStream,
    isStreamClosed: () => streamClosed,
    folderId,
  })

  const origin = getAllowedOrigin(c.req.header('Origin'))
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  })
})

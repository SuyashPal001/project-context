import { Hono } from 'hono'
import { resolveFolderPrefix } from '../folderScopeContext.js'
import type { AuthPayload } from '../auth.js'
import { validateToken } from '../auth.js'
import { agentBelongsToTenant, fetchAgentMemory } from '../usage.js'
import { checkCreditBalance } from '../credits.js'
import { filterPII } from '../pii-filter.js'
import { runChatStream } from './chatStream.js'
import { isInternalServiceKey } from '../service-key.js'
import { releaseMCPClientForSession } from '../mastra/tools.js'
import {
  Attachment,
  getAllowedOrigin, INTERNAL_SERVICE_KEY, API_BASE_URL,
  sseApprovalChannels,
  sessionActiveClarification, pendingClarifications,
  sessionActiveToolApprovals, pendingToolApprovals,
  sessionActiveUpload, pendingUploads,
  checkRateLimit,
} from '../types.js'
import { updateClarificationRequest, updateUploadRequest, fetchConversationAllowMode } from '../persistence.js'

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
  const folderPrefix = resolveFolderPrefix(body)
  const bodyAllowMode: 'ask' | 'auto' = (body as Record<string, unknown>).allowMode === 'auto' ? 'auto' : 'ask'
  const rawSkillsUsed = (body as Record<string, unknown>).skillsUsed
  const skillsUsed: Array<{ id: string; name: string }> = Array.isArray(rawSkillsUsed)
    ? rawSkillsUsed.filter((s): s is { id: string; name: string } =>
        !!s && typeof s === 'object' && typeof (s as any).id === 'string' && typeof (s as any).name === 'string')
    : []

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

  // agentId is client-supplied; tenantId is not. Compared here rather than in
  // each consumer, because this closes the whole class: everything downstream
  // (skills, persona, memory, model selection, MCP scoping, and create_skill's
  // write into agent_skills) trusts the pair it is handed. Without this check a
  // user authenticated in tenant A can name tenant B's agent and — by asking it
  // to save a skill — get their own text composed into B's system prompt.
  // 404, not 403: a foreign agent id must not be distinguishable from a
  // nonexistent one.
  if (agentId && !(await agentBelongsToTenant(agentId, tenantId))) {
    console.warn(`[sse] agent/tenant mismatch tenantId=${tenantId} agentId=${agentId} userId=${payload.sub}`)
    return c.json({ error: 'Agent not found' }, 404)
  }

  // Parallel pre-stream fetches — auth/me, credit pre-check, working memory run concurrently.
  // Per-agent memory (MEMORY.md), not per-tenant — each hired employee keeps
  // its own working notes rather than sharing one blob across a tenant's agents.
  const workingMemoryPromise = fetchAgentMemory(agentId)
  const [, creditCheck, , allowMode] = await Promise.all([
    // auth/me — resolve Cognito sub → internal UUID
    !isInternalCall
      ? fetch(`${API_BASE_URL}/api/v1/auth/me`, { headers: { 'Authorization': `Bearer ${idToken}` } })
          .then(async (meResp) => {
            if (meResp.ok) {
              // /api/v1/auth/me returns the field as `userId`, not `id` (see
              // apps/api/src/routes/auth.ts). Checking `me.id` here always read
              // undefined, so this assignment never fired and internalUserId
              // silently stayed at the raw Cognito sub for every request —
              // breaking anything keyed off the real internal users.id
              // (permission checks via memberships.user_id, audit logs, etc).
              const me = await meResp.json() as { userId?: string }
              if (typeof me.userId === 'string' && me.userId) internalUserId = me.userId
            } else {
              console.warn(`[sse] auth/me returned ${meResp.status} — falling back to Cognito sub`)
            }
          })
          .catch((err) => {
            console.warn('[sse] auth/me fetch failed — falling back to Cognito sub:', (err as Error).message)
          })
      : Promise.resolve(),
    // credit pre-check
    !isInternalCall
      ? checkCreditBalance(tenantId)
      : Promise.resolve({ allowed: true, balanceMicro: 0n, unlimited: true } as const),
    // working memory runs concurrently; awaited inside the async handler below
    workingMemoryPromise,
    // allowMode: fetched from the conversation row, not trusted off the wire —
    // an internal service call (watchdog etc.) has no per-user conversation
    // ownership to check against, so it keeps trusting its own body like
    // bodyTenantId already does above.
    isInternalCall ? Promise.resolve(bodyAllowMode) : fetchConversationAllowMode(idToken, conversationId),
  ])

  // Credit guard — checked before ReadableStream setup so we can return plain 402, not SSE error.
  if (!isInternalCall && !creditCheck.allowed) {
    console.warn(`[sse] tenantId=${tenantId} userId=${userId} insufficient credits balanceMicro=${creditCheck.balanceMicro}`)
    return c.json({ error: 'Insufficient credits', balanceMicro: String(creditCheck.balanceMicro) }, 402)
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

  // A bare SSE comment line — no "event:"/"data:" — so it's invisible to the
  // client's event listeners but still puts bytes on the wire. Used while a
  // tool call is in flight: between `tool_call` and `tool_done`, the stream
  // would otherwise go fully silent for the tool's entire duration (up to the
  // 150s deep-mode budget on analyze_audio/analyze_video), which is the same
  // silent-stream condition that made Cloudflare kill the original synchronous
  // media pipeline this plan replaced — just moved mid-stream instead of
  // pre-stream.
  const sendHeartbeat = (): void => {
    if (streamClosed) return
    try {
      streamController.enqueue(encoder.encode(': heartbeat\n\n'))
    } catch {
      // enqueue after close — swallow
    }
  }

  const closeStream = (): void => {
    if (streamClosed) return
    streamClosed = true
    sseApprovalChannels.delete(sessionId)
    releaseMCPClientForSession(sessionId)
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
      releaseMCPClientForSession(sessionId)
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

      // Resolve every pending tool-call approval for this session
      // immediately on disconnect — same reasoning as the clarification
      // block above, don't leave the agent's Mastra run suspended
      // indefinitely waiting on an in-process await nobody can answer
      // anymore. The underlying Mastra run stays suspended in storage;
      // only this local await is resolved (as a decline) so the request
      // handler can finish. The watchdog's 24h sweep is what eventually
      // declines the Mastra-side run itself if it's never revisited.
      const approvalIds = sessionActiveToolApprovals.get(sessionId)
      if (approvalIds) {
        for (const toolCallId of Array.from(approvalIds)) {
          const pending = pendingToolApprovals.get(toolCallId)
          if (pending) {
            pendingToolApprovals.delete(toolCallId)
            // Resolve only — no 'declined' PATCH here. chatStream.ts's
            // turnLoop writes that PATCH unconditionally as soon as this
            // promise resolves, from any resolver (the frontend decision
            // route or this disconnect handler), so writing it here too
            // would double every disconnect write.
            pending.resolve({ confirmed: false })
          }
        }
        sessionActiveToolApprovals.delete(sessionId)
      }

      // Resolve any pending upload request immediately, same reasoning as the
      // clarification block above — don't leave the agent blocked for up to
      // UPLOAD_TIMEOUT_MS after the client is gone.
      const uploadId = sessionActiveUpload.get(sessionId)
      if (uploadId) {
        const pending = pendingUploads.get(uploadId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingUploads.delete(uploadId)
          sessionActiveUpload.delete(sessionId)
          pending.resolve({ files: [], skipped: true })
          if (pending.messageId && pending.conversationId && pending.idToken) {
            updateUploadRequest(pending.idToken, pending.conversationId, pending.messageId, {
              status: 'skipped',
              answeredAt: new Date().toISOString(),
            })
          }
        }
      }
    },
  })

  // 4. Async handler — runs concurrently while response streams to client
  runChatStream({
    message, displayMessage: filteredMessage, attachments, conversationId, tenantId,
    internalUserId, idToken, agentId, sessionId, startTime,
    workingMemoryPromise, sendEvent, sendHeartbeat, closeStream,
    isStreamClosed: () => streamClosed,
    folderId, folderPrefix, allowMode, skillsUsed,
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

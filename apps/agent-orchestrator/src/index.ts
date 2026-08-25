import 'dotenv/config'
import dns from 'dns'
// GCP VM has no IPv6 route to Neon/AWS. Force all DNS lookups (including pg
// node-postgres connections) to prefer IPv4, bypassing Happy Eyeballs ETIMEDOUT.
dns.setDefaultResultOrder('ipv4first')
import type { Server } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { serve } from '@hono/node-server'
import { WebSocketServer, WebSocket, RawData } from 'ws'
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { app } from './app.js'
import { fireToolCallLog } from './events.js'
import { API_BASE_URL, sessions } from './types.js'
import { downloadMediaAttachment, buildAttachmentNote } from './media.js'
import type { RelaySessionCtx, DownloadedMedia } from './types.js'
import { validateToken } from './auth.js'
import { createConversation, saveUserMessage, saveAssistantMessage } from './persistence.js'
import { fetchAgentMemory } from './usage.js'
import { filterPII } from './pii-filter.js'
import { platformAgent } from './mastra/index.js'
import { getMCPClientForTenant } from './mastra/tools.js'
import { getThinkingBudget } from './mastra/thinking.js'

// WebSocket server — noServer mode; upgrade events wired below
const wss = new WebSocketServer({ noServer: true })

async function handleSession(
  ws: WebSocket,
  userId: string,
  internalUserId: string,
  email: string | undefined,
  sessionId: string,
  idToken: string,
  tenantId: string,
): Promise<void> {
  const apiToken = idToken
  let pendingUserMessage = ''
  let pendingAttachments: Array<{ fileId?: string; name: string; type: string; size?: number }> = []
  let conversationId: string | null = null
  let firstMessage = true
  let streamingActive = false

  sessions.set(sessionId, {
    ws,
    apiToken,
    getConversationId: () => conversationId,
    getPendingUserMessage: () => pendingUserMessage,
    getPendingAttachments: () => pendingAttachments,
  } as RelaySessionCtx)

  ws.on('message', (data: RawData) => {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }

    if (body.type === 'ping') return

    const rawWsMessage = typeof body.message === 'string' ? body.message.trim() : ''
    console.log(`[session:${sessionId}] raw body:`, JSON.stringify(body))
    console.log(`[session:${sessionId}] firstMessage=${firstMessage} message=${JSON.stringify(rawWsMessage)} agentId=${typeof body.agentId === 'string' ? body.agentId : '(missing)'}`)
    const attachments0 = Array.isArray(body.attachments) ? body.attachments : []
    if (!rawWsMessage && attachments0.length === 0) return

    const { sanitized: filteredWsMsg, detections: wsPiiDetections } = filterPII(rawWsMessage)
    if (wsPiiDetections.length > 0) {
      console.log(`[pii-filter] ws sessionId=${sessionId} masked: ${wsPiiDetections.map(d => `${d.type}×${d.count}`).join(' ')}`)
    }
    const effectiveMessage = filteredWsMsg || '[voice message]'
    const agentId = typeof body.agentId === 'string' ? body.agentId : ''
    const folderId = typeof body.folderId === 'string' && body.folderId ? body.folderId : undefined

    pendingUserMessage = effectiveMessage
    pendingAttachments = (attachments0 as Array<{ fileId?: string; name: string; type: string; size?: number }>)
      .map(({ fileId, name, type, size }) => ({
        fileId,
        name: name ?? fileId ?? 'attachment',
        type: type ?? '',
        size,
      }))

    ;(async () => {
      let mcpClient: ReturnType<typeof getMCPClientForTenant> | null = null
      try {
        if (firstMessage) {
          firstMessage = false
          const incomingConversationId = body.conversationId as string | undefined
          if (incomingConversationId) {
            conversationId = incomingConversationId
            console.log(`[session:${sessionId}] continuing conversation ${conversationId}`)
          } else {
            conversationId = await createConversation(apiToken, agentId)
            console.log(`[session:${sessionId}] created conversation ${conversationId}`)
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ready', conversationId }))
          }
        }

        if (streamingActive) {
          console.warn(`[session:${sessionId}] message received while stream active — dropped`)
          return
        }
        streamingActive = true

        const workingMemory = await fetchAgentMemory(agentId)
        const memPreamble = workingMemory
          ? `[AGENT MEMORY]\nYou have remembered the following about this agent from previous sessions:\n${workingMemory}\n\n`
          : ''
        if (workingMemory) console.log(`[session:${sessionId}] injected working memory agentId=${agentId}`)

        const sessionContext = `<session_context>\ntenant_id: ${tenantId}${folderId ? `\nfolder_id: ${folderId}` : ''}\n</session_context>\n\n`

        // audio/* and video/* are intentionally excluded from synchronous download —
        // see the buildAttachmentNote doc comment in media.ts for why, and how the
        // agent is told about them instead so it can call analyze_audio/analyze_video
        // on demand. Kept in sync with routes/chatStream.ts's identical filter.
        const mediaAttachments = (attachments0 as any[]).filter((a: any) =>
          a.type?.startsWith('image/') ||
          a.type === 'application/pdf' ||
          a.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )

        const attachmentNote = buildAttachmentNote(attachments0 as any[])

        type ContentPart =
          | { type: 'text'; text: string }
          | { type: 'image'; image: string; mimeType: string }

        let mastraMessage: string | { role: 'user'; content: ContentPart[] }

        if (mediaAttachments.length > 0) {
          const downloaded = (await Promise.all(
            mediaAttachments.map((a: any) => downloadMediaAttachment(a, sessionId))
          ))
            .filter((d): d is DownloadedMedia | DownloadedMedia[] => d !== null)
            .flatMap(d => Array.isArray(d) ? d : [d])

          const textDocs = downloaded.filter(d => d.mimeType === 'text/plain')
          const imageFiles = downloaded.filter(d => d.mimeType !== 'text/plain')

          let finalMessage = attachmentNote + memPreamble + sessionContext + effectiveMessage
          for (const doc of textDocs) {
            const text = Buffer.from(doc.base64.replace(/^data:text\/plain;base64,/, ''), 'base64').toString('utf8')
            finalMessage = `[File: ${doc.name} | path: ${doc.filePath}]\n${text}\n\n${finalMessage}`
          }

          console.log(`[session:${sessionId}] ${imageFiles.length} image attachment(s), ${textDocs.length} doc(s) injected`)

          if (imageFiles.length > 0) {
            const parts: ContentPart[] = imageFiles.map(img => ({
              type: 'image' as const,
              image: img.base64.replace(/^data:[^;]+;base64,/, ''),
              mimeType: img.mimeType,
            }))
            parts.push({ type: 'text', text: finalMessage })
            mastraMessage = { role: 'user', content: parts }
          } else {
            mastraMessage = finalMessage
          }
        } else {
          mastraMessage = attachmentNote + memPreamble + sessionContext + effectiveMessage
        }

        const requestContext = new RequestContext()
        requestContext.set(MASTRA_RESOURCE_ID_KEY, tenantId)
        requestContext.set(MASTRA_THREAD_ID_KEY, conversationId ?? crypto.randomUUID())
        requestContext.set('tenantId', tenantId)
        requestContext.set('agentId', agentId)
        // Mirrors chatStream.ts's resolution: internalUserId is already resolved
        // once per connection in the upgrade handler below (auth/me, falling back
        // to the Cognito sub on failure) — without this, start_task/get_task_thread
        // are advertised to the model on this path but can never succeed, since
        // requireToolAssignment's human-caller branch and any userId-scoped logic
        // downstream have nothing to read.
        requestContext.set('userId', internalUserId)
        // Mirrors chatStream.ts: analyze_audio/analyze_video (Mastra tools) read
        // sessionId + idToken off the requestContext to fetch a presigned URL and
        // cache the download — without these, both tools return
        // { success: false, error: 'no_active_session' } on this path.
        requestContext.set('sessionId', sessionId)
        requestContext.set('idToken', idToken)
        if (folderId) requestContext.set('folderId', folderId)
        mcpClient = getMCPClientForTenant(tenantId, agentId)
        requestContext.set('__mcpClient', mcpClient as any)

        const thinkingBudget = getThinkingBudget(effectiveMessage)
        console.log(`[session:${sessionId}] streaming via platformAgent conversationId=${conversationId} thinkingBudget=${thinkingBudget}`)

        const agentStream = await (platformAgent as any).stream(mastraMessage, {
          memory: { thread: conversationId ?? crypto.randomUUID(), resource: tenantId },
          requestContext,
          providerOptions: { google: { thinkingConfig: { thinkingBudget } } },
        })

        let fullText = ''
        let deltasSent = 0

        for await (const part of agentStream.fullStream as AsyncIterable<any>) {
          if (ws.readyState !== WebSocket.OPEN) break
          switch (part.type) {
            case 'text-delta': {
              const text = (part.payload?.text ?? part.textDelta ?? '') as string
              fullText += text
              deltasSent++
              ws.send(JSON.stringify({ type: 'delta', text, conversationId }))
              break
            }
            case 'tool-call': {
              const p = part.payload ?? part
              const toolName = (p.toolName ?? '') as string
              const args = (p.args ?? {}) as Record<string, unknown>
              const toolCallId = (p.toolCallId ?? toolName) as string
              ws.send(JSON.stringify({ type: 'tool_call', toolName, toolCallId, args, conversationId }))
              fireToolCallLog({
                tenantId,
                conversationId: conversationId ?? '',
                userId: internalUserId,
                toolName,
                success: true,
                latencyMs: 0,
                args,
              })
              break
            }
          }
        }

        if (ws.readyState !== WebSocket.OPEN) return

        if (deltasSent === 0 && fullText) {
          ws.send(JSON.stringify({ type: 'delta', text: fullText, conversationId }))
        }

        ws.send(JSON.stringify({ type: 'done', text: fullText, conversationId }))

        const userMsg = pendingUserMessage
        pendingUserMessage = ''
        if (conversationId) {
          saveUserMessage(apiToken, conversationId, userMsg, pendingAttachments)
          pendingAttachments = []
          saveAssistantMessage(apiToken, conversationId, fullText)
        }
      } catch (err) {
        console.error(`[session:${sessionId}] stream error:`, (err as Error).message)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Internal server error', conversationId }))
        }
      } finally {
        streamingActive = false
        // mcpClient is now a persistent singleton per tenant — do not disconnect
      }
    })()
  })

  ws.on('close', () => {
    sessions.delete(sessionId)
    console.log(`[session:${sessionId}] closed`)
  })
}

const port = Number(process.env.PORT ?? 3001)

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`agent-orchestrator listening on port ${port}`)
}) as unknown as Server

server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const url = new URL(req.url ?? '/', `http://localhost`)

  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }

  const token = url.searchParams.get('token') ?? ''
  const idToken = url.searchParams.get('idToken') ?? ''

  if (!idToken) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }

  validateToken(token).then(async (payload) => {
    const userId = payload.sub
    const email = payload.email
    const tenantId = payload['custom:tenantId'] ?? userId
    const sessionId = crypto.randomUUID()
    console.log('[session] tenantId from JWT:', tenantId)

    let internalUserId: string = userId
    try {
      const meResp = await fetch(`${API_BASE_URL}/api/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${idToken}` },
      })
      if (meResp.ok) {
        const me = await meResp.json() as { id?: string }
        if (typeof me.id === 'string' && me.id) internalUserId = me.id
      } else {
        console.warn(`[session] auth/me returned ${meResp.status} — falling back to Cognito sub`)
      }
    } catch (err) {
      console.warn('[session] auth/me fetch failed — falling back to Cognito sub:', (err as Error).message)
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      handleSession(ws, userId, internalUserId, email, sessionId, idToken, tenantId).catch((err: Error) => {
        console.error('[session] handleSession error:', err.message)
        ws.close()
      })
    })
  }).catch(() => {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })
})

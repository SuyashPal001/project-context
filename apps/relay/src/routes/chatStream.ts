import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { saveUserMessage, saveAssistantMessage } from '../persistence.js'
import { downloadMediaAttachment } from '../media.js'
import { fireMetrics, fireAutoEval, fireToolCallLog, fireKnowledgeGap } from '../events.js'
import { platformAgent } from '../mastra/index.js'
import { pmAgent } from '../mastra/agents/pmAgent.js'
import { getMCPClientForTenant } from '../mastra/tools.js'
import { getThinkingBudget } from '../mastra/thinking.js'
import { fetchAgentSkill } from '../usage.js'
import type { Attachment, DownloadedMedia } from '../types.js'
import { lastRagResult } from '../types.js'
import { isPmIntent, fetchPrdDraft, markPmSession, isPmSession } from './pmRouting.js'

export interface ChatStreamOpts {
  message: string
  attachments: Attachment[]
  conversationId: string
  tenantId: string
  internalUserId: string
  idToken: string
  agentId: string
  sessionId: string
  startTime: number
  workingMemoryPromise: Promise<string | null>
  sendEvent: (event: string, data: object) => void
  closeStream: () => void
  isStreamClosed: () => boolean
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mimeType: string }

async function buildMastraMessage(
  attachments: Attachment[],
  preamble: string,
  sessionCtx: string,
  message: string,
  sessionId: string,
): Promise<string | { role: 'user'; content: ContentPart[] }> {
  const mediaAttachments = attachments.filter(
    (a) =>
      a.type?.startsWith('image/') ||
      a.type?.startsWith('video/') ||
      a.type?.startsWith('audio/') ||
      a.type === 'application/pdf' ||
      a.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )

  if (mediaAttachments.length === 0) return preamble + sessionCtx + message

  const downloaded = (await Promise.all(
    mediaAttachments.map((a) => downloadMediaAttachment(a, sessionId))
  ))
    .filter((d): d is DownloadedMedia | DownloadedMedia[] => d !== null)
    .flatMap(d => Array.isArray(d) ? d : [d])

  const textDocs = downloaded.filter(d => d.mimeType === 'text/plain')
  const imageFiles = downloaded.filter(d => d.mimeType !== 'text/plain')

  let finalMessage = preamble + sessionCtx + message
  for (const doc of textDocs) {
    const text = Buffer.from(doc.base64.replace(/^data:text\/plain;base64,/, ''), 'base64').toString('utf8')
    finalMessage = `[File: ${doc.name} | path: ${doc.filePath}]\n${text}\n\n${finalMessage}`
  }

  console.log(`[sse:${sessionId}] ${imageFiles.length} image attachment(s), ${textDocs.length} doc(s) injected`)

  if (imageFiles.length > 0) {
    const parts: ContentPart[] = imageFiles.map(img => ({
      type: 'image' as const,
      image: img.base64.replace(/^data:[^;]+;base64,/, ''),
      mimeType: img.mimeType,
    }))
    parts.push({ type: 'text', text: finalMessage })
    return { role: 'user', content: parts }
  }

  return finalMessage
}

// ---------------------------------------------------------------------------
// Plan JSON extraction — parse agent text response for structured plan data.
// Looks for a fenced ```json block first, then falls back to raw {...}.
// Returns the parsed object if it has both `plan` and `milestones` keys,
// otherwise null (normal message, not a PRD analysis response).
// ---------------------------------------------------------------------------
function extractPlanJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = []

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) candidates.push(fenceMatch[1])

  const rawMatch = text.match(/\{[\s\S]*\}/)
  if (rawMatch) candidates.push(rawMatch[0])

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim())
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.plan === 'object' &&
        Array.isArray(parsed.milestones)
      ) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // not valid JSON — try next candidate
    }
  }
  return null
}

export async function runChatStream(opts: ChatStreamOpts): Promise<void> {
  const {
    message, attachments, conversationId, tenantId,
    internalUserId, idToken, agentId, sessionId, startTime,
    workingMemoryPromise, sendEvent, closeStream, isStreamClosed,
  } = opts

  let ragFired = false
  let ragChunksRetrieved = 0
  let ragChunks: string[] = []
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  const costUsd: number | undefined = undefined
  let pendingMetrics: Parameters<typeof fireMetrics>[0] | null = null
  let pendingEval: Parameters<typeof fireAutoEval>[0] | null = null
  // Cache toolCallId → toolName so tool-result events can resolve the name
  // (Mastra's tool-result stream parts don't always include toolName)
  const toolCallNames = new Map<string, string>()

  const flushMetrics = (): void => {
    if (pendingMetrics) { fireMetrics(pendingMetrics); pendingMetrics = null }
    if (pendingEval) { fireAutoEval(pendingEval); pendingEval = null }
  }

  try {
    const workingMemory = await workingMemoryPromise
    if (workingMemory) console.log(`[sse:${sessionId}] injected working memory tenantId=${tenantId}`)

    const memPreamble = workingMemory
      ? `[AGENT MEMORY]\nYou have remembered the following about this tenant from previous sessions:\n${workingMemory}\n\n`
      : ''
    const sessionCtx = `<session_context>\ntenant_id: ${tenantId}\n</session_context>\n\n`

    const mastraMessage = await buildMastraMessage(attachments, memPreamble, sessionCtx, message, sessionId)

    if (isStreamClosed()) return

    const requestContext = new RequestContext()
    requestContext.set(MASTRA_RESOURCE_ID_KEY, tenantId)
    requestContext.set(MASTRA_THREAD_ID_KEY, conversationId)
    requestContext.set('tenantId', tenantId)
    requestContext.set('agentId', agentId)
    requestContext.set('userId', internalUserId)
    const mcpClient = getMCPClientForTenant(tenantId)
    requestContext.set('__mcpClient', mcpClient as any)

    // Inject per-agent system prompt so platformAgent.instructions uses it
    // instead of the global agent_templates prompt (ADR: agent branding fix).
    const agentSkill = await fetchAgentSkill(agentId)
    if (agentSkill?.systemPrompt) {
      requestContext.set('agentSystemPrompt', agentSkill.systemPrompt)
    }

    const thinkingBudget = getThinkingBudget(message)
    requestContext.set('thinkingBudget', thinkingBudget)
    console.log(`[sse:${sessionId}] streaming tenantId=${tenantId} conversationId=${conversationId} thinkingBudget=${thinkingBudget} model=${thinkingBudget === 0 ? 'lite' : 'flash'}`)

    // Skip memory recall for conversational turns — nothing useful to recall for "hi"/"thanks".
    // lastMessages: false disables the 0.57s recall step; memory:save still runs (history kept).
    const memoryOptions = thinkingBudget === 0 ? { lastMessages: false as const } : undefined

    let agentStream: any

    // Route to pmAgent if:
    //   1. explicit PM intent keywords in message, OR
    //   2. in-process session flag (tracks clarifying-questions phase before draft is saved), OR
    //   3. existing draft in DB (handles cross-session "continue my PRD" scenarios)
    const pmSession = isPmSession(conversationId)
    const draft = (isPmIntent(message) || pmSession) ? await fetchPrdDraft(agentId, tenantId) : null
    const usePmAgent = isPmIntent(message) || pmSession || !!draft

    if (usePmAgent) {
      markPmSession(conversationId)  // keep session alive through clarifying questions
      if (draft) {
        requestContext.set('existingPrdDraft', draft.content)
        requestContext.set('existingPrdId', draft.id)
      }
      console.log(`[sse:${sessionId}] PM routing — intent=${isPmIntent(message)} session=${pmSession} draft=${!!draft}`)
      agentStream = await pmAgent.stream(mastraMessage, {
        maxSteps: 10,
        requestContext,
        delegation: { onDelegationStart: async () => ({ proceed: true }) },
      })
    } else {
      agentStream = await (platformAgent as any).stream(mastraMessage, {
        memory: { thread: conversationId || crypto.randomUUID(), resource: tenantId, ...(memoryOptions ? { options: memoryOptions } : {}) },
        requestContext,
        providerOptions: { google: { thinkingConfig: { thinkingBudget } } },
      })
    }

    let fullText = ''
    let planResult: unknown

    for await (const part of agentStream.fullStream as AsyncIterable<any>) {
      if (isStreamClosed()) break
      switch (part.type) {
        case 'text-delta': {
          const text = (part.payload?.text ?? part.textDelta ?? '') as string
          fullText += text
          sendEvent('delta', { text, conversationId })
          break
        }
        // Delegated sub-agent (e.g. prdAgent) text — Mastra wraps inner stream parts
        // as agent-execution-event-{inner.type}. Forward text deltas so the artifact
        // panel streams in real time instead of waiting for the outer finish event.
        case 'agent-execution-event-text-delta': {
          const text = (part.payload?.textDelta ?? part.payload?.text ?? '') as string
          if (text) {
            fullText += text
            sendEvent('delta', { text, conversationId })
          }
          break
        }
        case 'tool-call': {
          const p = part.payload ?? part
          const toolName = (p.toolName ?? '') as string
          const args = (p.args ?? {}) as Record<string, unknown>
          const toolCallId = (p.toolCallId ?? toolName) as string
          if (toolCallId && toolName) toolCallNames.set(toolCallId, toolName)
          sendEvent('tool_call', { toolName, toolCallId, args, conversationId })
          if (toolName === 'retrieve_documents') ragFired = true
          fireToolCallLog({ tenantId, conversationId, userId: internalUserId, toolName, success: true, latencyMs: Date.now() - startTime, args })
          break
        }
        case 'tool-result': {
          const p = part.payload ?? part
          const toolCallId = (p.toolCallId ?? '') as string
          const rawToolName = (p.toolName ?? '') as string
          const resolvedToolName = rawToolName || toolCallNames.get(toolCallId) || ''
          toolCallNames.delete(toolCallId)
          const result = (p.result ?? p.output ?? {}) as Record<string, unknown>
          console.log(`[sse:${sessionId}] tool-result toolName=${resolvedToolName} resultKeys=${Object.keys(result).join(',')}`)
          sendEvent('tool_done', { toolCallId, toolName: resolvedToolName, result, conversationId })
          break
        }
        case 'finish': {
          const usage = part.payload?.output?.usage ?? part.usage
          inputTokens = (usage?.promptTokens as number | undefined) ?? 0
          outputTokens = (usage?.completionTokens as number | undefined) ?? 0
          totalTokens = inputTokens + outputTokens

          // Fire done immediately — don't wait for memory:save (~2.5s)
          const messageId = crypto.randomUUID()
          const responseTimeMs = Date.now() - startTime

          const cached = lastRagResult.get(tenantId)
          if (cached && Date.now() - cached.ts < 60_000) {
            ragFired = true
            ragChunksRetrieved = cached.count
            ragChunks = cached.chunks
          }
          if (ragFired && (ragChunksRetrieved === 0 || (cached && cached.topScore < 0.5))) {
            fireKnowledgeGap({ tenantId, conversationId, query: message, ragScore: cached?.topScore ?? 0 })
          }

          const prdData = extractPlanJson(fullText)
          if (prdData) {
            planResult = { summary: fullText, dodPassed: true, prdData }
            console.log(`[sse:${sessionId}] plan JSON extracted from agent response`)
          }

          sendEvent('done', { text: fullText, conversationId, messageId, planResult })

          const atts = attachments.map(a => ({ fileId: a.fileId, name: a.name ?? a.fileId ?? 'attachment', type: a.type ?? '', size: a.size }))
          saveUserMessage(idToken, conversationId, message, atts)
          saveAssistantMessage(idToken, conversationId, fullText)

          pendingMetrics = { conversationId, tenantId, ragFired, ragChunksRetrieved, responseTimeMs, totalTokens, inputTokens, outputTokens, userMessageCount: 1, costUsd }
          if (ragFired) pendingEval = { conversationId, messageId, tenantId, question: message, retrievedChunks: ragChunks, answer: fullText }
          flushMetrics()
          break
        }
      }
    }

    // Loop complete — memory:save has finished
    closeStream()
  } catch (err) {
    console.error(`[sse:${sessionId}] fatal error:`, (err as Error).message)
    sendEvent('error', { message: 'Internal server error', conversationId })
    closeStream()
  }
}

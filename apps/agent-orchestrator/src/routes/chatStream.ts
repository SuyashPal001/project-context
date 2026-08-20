import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { saveUserMessage, saveAssistantMessage, fireArtifactNotification, type ArtifactRefPayload } from '../persistence.js'
import { downloadMediaAttachment } from '../media.js'
import { fireMetrics, fireAutoEval, fireToolCallLog, fireKnowledgeGap } from '../events.js'
import { resolveAgent, resolveAgentLabel } from '../mastra/registry.js'
import { runWithGuardrailContext } from '../mastra/guardrails.js'
import { runFairnessCheck } from '../fairness/index.js'
import { getMCPClientForTenant } from '../mastra/tools.js'
import { getThinkingBudget } from '../mastra/thinking.js'
import { calculateCostUsd, persistCost } from '../mastra/cost.js'
import { fetchAgentSkill, fetchAgentName, fetchAgentPersonality, fetchAgentModelSelection } from '../usage.js'
import { buildGatewayModelString } from '../mastra/model.js'
import { quickGeminiCall } from '../llm/quickCall.js'
import type { Attachment, DownloadedMedia } from '../types.js'
import { lastRagResult } from '../types.js'

async function generateFollowUps(userMessage: string, assistantReply: string): Promise<string[]> {
  const prompt = `Based on this conversation turn, generate exactly 3 short, natural follow-up questions the user might want to ask next.

User asked: ${userMessage.slice(0, 400)}

Assistant replied: ${assistantReply.slice(0, 600)}

Rules:
- Output ONLY a JSON array of 3 strings, no other text
- Each question must be under 60 characters
- Questions should be genuinely useful next steps, not restatements
- Example format: ["How do I deploy this?", "What are the trade-offs?", "Can you show an example?"]

JSON array:`

  const raw = await quickGeminiCall(prompt)
  const match = raw.match(/\[[\s\S]*?\]/)
  if (!match) return []
  const parsed = JSON.parse(match[0])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((s: unknown) => typeof s === 'string').slice(0, 3)
}

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
  folderId?: string
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
  // audio/* and video/* intentionally excluded: both require slow processing
  // (Speech-to-Text, ffmpeg frame extraction) that has no business blocking a live
  // chat turn. Routing them through this synchronous path held the SSE connection
  // open with no bytes flowing for the length of the processing call, which
  // Cloudflare's edge would kill as a QUIC protocol error. Both attachment types
  // still reach chat history via saveUserMessage() below (finish and error paths).
  // Real agent understanding of audio/video belongs in an async artifact pipeline
  // (queue job -> worker -> result delivered as a follow-up), not this request path.
  const mediaAttachments = attachments.filter(
    (a) =>
      a.type?.startsWith('image/') ||
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

function extractPlanJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = []
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) candidates.push(fenceMatch[1])
  const rawMatch = text.match(/\{[\s\S]*\}/)
  if (rawMatch) candidates.push(rawMatch[0])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim())
      if (parsed && typeof parsed === 'object' && typeof parsed.plan === 'object' && Array.isArray(parsed.milestones)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* not valid JSON — try next */ }
  }
  return null
}

export async function runChatStream(opts: ChatStreamOpts): Promise<void> {
  const {
    message, attachments, conversationId, tenantId,
    internalUserId, idToken, agentId, sessionId, startTime,
    workingMemoryPromise, sendEvent, closeStream, isStreamClosed,
    folderId,
  } = opts

  let ragFired = false
  let ragChunksRetrieved = 0
  let ragChunks: string[] = []
  let ragSources: Array<{ name: string; score: number }> = []
  let suggestedFollowUps: string[] = []
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let pendingMetrics: Parameters<typeof fireMetrics>[0] | null = null
  let pendingEval: Parameters<typeof fireAutoEval>[0] | null = null
  const toolCallNames = new Map<string, string>()
  const assistantMessageId = crypto.randomUUID()
  let pendingArtifactRef: ArtifactRefPayload | null = null
  const SAVE_TOOL_NAMES = new Set(['saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks', 'rendercanvas', 'render-canvas', 'render_canvas'])

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
    console.log('[session] tenantId:', tenantId, 'folderId:', folderId ?? '(none)')
    const sessionCtx = `<session_context>\ntenant_id: ${tenantId}${folderId ? `\nfolder_id: ${folderId}` : ''}\n</session_context>\n\n`
    const mastraMessage = await buildMastraMessage(attachments, memPreamble, sessionCtx, message, sessionId)

    if (isStreamClosed()) return

    const requestContext = new RequestContext()
    requestContext.set(MASTRA_RESOURCE_ID_KEY, tenantId)
    requestContext.set(MASTRA_THREAD_ID_KEY, conversationId)
    requestContext.set('tenantId', tenantId)
    requestContext.set('agentId', agentId)
    requestContext.set('userId', internalUserId)
    requestContext.set('sendEvent', sendEvent)
    requestContext.set('sessionId', sessionId)
    requestContext.set('conversationId', conversationId)
    requestContext.set('idToken', idToken)
    if (folderId) requestContext.set('folderId', folderId)

    const mcpClient = getMCPClientForTenant(tenantId, agentId)
    requestContext.set('__mcpClient', mcpClient as any)

    const [agentSkill, agentName, personaPersonality, agentModelSelection] = await Promise.all([
      fetchAgentSkill(agentId),
      fetchAgentName(agentId),
      fetchAgentPersonality(agentId),
      fetchAgentModelSelection(agentId).catch((err) => {
        console.warn(`[sse:${sessionId}] fetchAgentModelSelection failed, falling back to default model:`, (err as Error).message)
        return null
      }),
    ])
    if (agentSkill?.systemPrompt) {
      requestContext.set('agentSystemPrompt', agentSkill.systemPrompt)
    }
    if (personaPersonality) {
      requestContext.set('personaPersonality', personaPersonality)
    }
    if (agentModelSelection && agentModelSelection.status === 'live') {
      const modelString = buildGatewayModelString(agentModelSelection.provider, agentModelSelection.model)
      if (modelString) requestContext.set('selectedModel', modelString)
    }

    const thinkingBudget = getThinkingBudget(message)
    requestContext.set('thinkingBudget', thinkingBudget)

    // Agent routing — determined entirely by the conversation's assigned agent.
    // Saarthi conversations always go to platformAgent; PM agent conversations
    // always go to pmAgent. No keyword detection — the user chose the agent
    // when starting the conversation. Internal sub-agent delegation (pmAgent →
    // prdAgent → roadmapAgent → taskAgent) is handled by Mastra internally.
    const activeAgent = resolveAgent(agentName ?? '')
    console.log(`[sse:${sessionId}] agent="${agentName}" → ${resolveAgentLabel(activeAgent)} thinkingBudget=${thinkingBudget}`)

    const memoryOptions = thinkingBudget === 0 ? { lastMessages: false as const } : undefined

    let fullText = ''
    let planResult: unknown
    let toolCallCount = 0
    let reasoningText = ''
    // First/last reasoning-delta timestamps — separate from the whole turn's
    // elapsedSec, powers the persisted "Thought for Ns" label (see reasoningElapsedSec
    // in completedTrace below).
    let reasoningStartMs: number | null = null
    let reasoningLastMs: number | null = null

    await runWithGuardrailContext({ tenantId, conversationId }, async () => {
      const agentStream = await (activeAgent as any).stream(mastraMessage, {
        memory: {
          thread: conversationId || crypto.randomUUID(),
          resource: tenantId,
          ...(memoryOptions ? { options: memoryOptions } : {}),
        },
        requestContext,
        providerOptions: { 'inference-gateway': { thinkingBudget } },
      })

    for await (const part of agentStream.fullStream as AsyncIterable<any>) {
      if (isStreamClosed()) break

      switch (part.type) {
        case 'text-delta': {
          const text = (part.payload?.text ?? part.textDelta ?? '') as string
          fullText += text
          sendEvent('delta', { text, conversationId })
          break
        }
        // Extended-thinking trace — never part of fullText/the persisted message,
        // just forwarded live for the "thinking it through" UI. See thinkingBudget
        // above and includeThoughts in the inference-gateway Vertex/Gemini adapters.
        case 'reasoning-delta': {
          const text = (part.payload?.text ?? part.delta ?? part.textDelta ?? '') as string
          if (text) {
            reasoningText += text
            if (reasoningStartMs === null) reasoningStartMs = Date.now()
            reasoningLastMs = Date.now()
            sendEvent('reasoning', { text, conversationId })
          }
          break
        }
        // Text streamed from a delegated sub-agent
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
          toolCallCount++
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

          // Capture citations from RAG tool
          if (resolvedToolName === 'retrieve_documents' && Array.isArray(result.sources)) {
            ragSources = result.sources as Array<{ name: string; score: number }>
          }

          // Inject summary as synthetic text when route_to_officer returns one
          if (resolvedToolName === 'route_to_officer' && typeof result.summary === 'string' && result.summary) {
            fullText += result.summary
            sendEvent('delta', { text: result.summary, conversationId })
          }

          // Capture artifact ref when a save tool (savePRD / savePlan / saveTasks) completes.
          // render-canvas has no entityId (ephemeral display only) — skip pendingArtifactRef for it.
          const normName = resolvedToolName.toLowerCase().replace(/_/g, '-')
          if (SAVE_TOOL_NAMES.has(normName) && normName !== 'render-canvas') {
            const entityId = (result.prdId ?? result.planId ?? result.taskBoardId) as string | undefined
            if (entityId) {
              const artifactType = normName.includes('prd') ? 'prd' : normName.includes('plan') ? 'roadmap' : 'tasks'
              pendingArtifactRef = {
                type: artifactType as ArtifactRefPayload['type'],
                entityId,
                title: String(result.title ?? artifactType.toUpperCase()),
              }
            }
          }
          break
        }
        case 'finish': {
          const usage = part.payload?.output?.usage ?? part.usage
          inputTokens = (usage?.inputTokens as number | undefined) ?? (usage?.promptTokens as number | undefined) ?? 0
          outputTokens = (usage?.outputTokens as number | undefined) ?? (usage?.completionTokens as number | undefined) ?? 0
          totalTokens = inputTokens + outputTokens
          const modelName = thinkingBudget === 0
            ? (process.env.MASTRA_LITE_MODEL ?? 'gemini-2.5-flash-lite')
            : (process.env.MASTRA_MODEL ?? 'gemini-2.5-flash')
          costUsd = calculateCostUsd(modelName, inputTokens, outputTokens)
          persistCost({ tenantId, agentId: agentName ?? agentId, model: modelName, inputTokens, outputTokens })
          console.log(`[tokens] model=${modelName} input=${inputTokens} output=${outputTokens} total=${totalTokens} cost=$${costUsd.toFixed(6)} fullTextLen=${fullText.length}`)

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

          // Generate follow-up suggestions in parallel with a 4s timeout
          if (fullText.length > 50) {
            try {
              suggestedFollowUps = await Promise.race([
                generateFollowUps(message, fullText),
                new Promise<string[]>(resolve => setTimeout(() => resolve([]), 4000)),
              ])
            } catch {
              suggestedFollowUps = []
            }
          }

          sendEvent('done', { text: fullText, conversationId, messageId: assistantMessageId, planResult, artifactRef: pendingArtifactRef ?? undefined, citations: ragSources.length > 0 ? ragSources : undefined, suggestedFollowUps: suggestedFollowUps.length > 0 ? suggestedFollowUps : undefined })

          // Guard against ghost messages: if the client disconnected (Stop button
          // or navigation) before the agent finished, isStreamClosed() is already
          // true here. Skip persistence so a cancelled turn can't write an
          // out-of-order message into the conversation after the user has moved on.
          if (isStreamClosed()) break

          const atts = attachments.map(a => ({ fileId: a.fileId, name: a.name ?? a.fileId ?? 'attachment', type: a.type ?? '', size: a.size }))
          saveUserMessage(idToken, conversationId, message, atts)
          // Mirrors the frontend's own hadTrace gate (useChatStream.ts onDone) so a
          // turn that's too fast/toolless to show a summary live doesn't get one
          // materialize after a reload either.
          const elapsedSec = Math.max(0, Math.floor(responseTimeMs / 1000))
          const reasoningElapsedSec = reasoningStartMs !== null && reasoningLastMs !== null
            ? Math.max(1, Math.round((reasoningLastMs - reasoningStartMs) / 1000))
            : undefined
          const completedTrace = (toolCallCount > 0 || elapsedSec >= 2 || !!reasoningText)
            ? { elapsedSec, toolCallCount, ...(reasoningText ? { reasoningText } : {}), ...(reasoningElapsedSec !== undefined ? { reasoningElapsedSec } : {}) }
            : null
          saveAssistantMessage(idToken, conversationId, fullText, assistantMessageId, pendingArtifactRef, completedTrace)
          if (pendingArtifactRef) fireArtifactNotification(tenantId, internalUserId, pendingArtifactRef)

          // FREE-AI Sutra 1 — non-blocking, runs after client already received `done`
          runFairnessCheck({ tenantId, conversationId, messageId: assistantMessageId, agentId, agentName: agentName ?? agentId, responseText: fullText, toolsUsed: toolCallCount })

          pendingMetrics = { conversationId, tenantId, ragFired, ragChunksRetrieved, responseTimeMs, totalTokens, inputTokens, outputTokens, userMessageCount: 1, costUsd }
          if (ragFired) pendingEval = { conversationId, messageId: assistantMessageId, tenantId, question: message, retrievedChunks: ragChunks, answer: fullText }
          flushMetrics()
          break
        }
      }
    }
    }) // end runWithGuardrailContext

    closeStream()
  } catch (err) {
    console.error(`[sse:${sessionId}] fatal error:`, (err as Error).message)
    sendEvent('error', { message: 'Internal server error', conversationId })
    // Save the user message even on error so attachments aren't lost.
    // The finish path is never reached when the turn throws, so this is the only
    // opportunity to durably persist the user turn.
    const atts = attachments.map(a => ({ fileId: a.fileId, name: a.name ?? a.fileId ?? 'attachment', type: a.type ?? '', size: a.size }))
    saveUserMessage(idToken, conversationId, message, atts)
    closeStream()
  }
}

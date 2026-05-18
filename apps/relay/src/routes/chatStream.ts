import { z } from 'zod'
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { saveUserMessage, saveAssistantMessage, fireArtifactNotification, type ArtifactRefPayload } from '../persistence.js'
import { downloadMediaAttachment } from '../media.js'
import { fireMetrics, fireAutoEval, fireToolCallLog, fireKnowledgeGap } from '../events.js'
import { platformAgent, mastra } from '../mastra/index.js'
import { getMCPClientForTenant } from '../mastra/tools.js'
import { getThinkingBudget } from '../mastra/thinking.js'
import { fetchAgentSkill } from '../usage.js'
import type { Attachment, DownloadedMedia } from '../types.js'
import { lastRagResult } from '../types.js'
import { isPmIntent } from './pmRouting.js'

// ─── Pending PM workflow sessions (Option B: chat-based approval/revision) ────
// Tracks workflows suspended mid-run so the user can approve or revise via chat.
// In-memory: cleared on restart (acceptable — user can re-trigger from UI).

type PendingPmPhase = 'prd-clarify' | 'prd' | 'roadmap' | 'tasks'
interface PendingPmSession { pmRunId: string; pmStepId: string; phase: PendingPmPhase }
const pendingPmSessions = new Map<string, PendingPmSession>()

const APPROVAL_WORDS = ['approve', 'approved', 'yes', 'lgtm', 'looks good', 'go ahead', 'proceed', 'accept', 'perfect', 'great', 'confirm', 'confirmed']
function isApprovalMessage(msg: string): boolean {
  const lower = msg.toLowerCase().trim()
  return APPROVAL_WORDS.some(w => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ','))
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
  // Pre-generate the assistant messageId so relay and DB share the same UUID
  const assistantMessageId = crypto.randomUUID()
  // Artifact produced during this turn (set when a save tool completes)
  let pendingArtifactRef: ArtifactRefPayload | null = null
  // Mastra HITL workflow run info — set after PRD saved, included in done event
  let pmRunId: string | undefined
  let pmStepId: string | undefined
  const SAVE_TOOL_NAMES = new Set(['saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks'])

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
    let isPmWorkflow = false

    // ── Option B: chat-based PM workflow resume ──────────────────────────────
    // If a PM workflow is suspended for this conversation, intercept the chat
    // message and resume the workflow (answers, revision, or approval) instead
    // of routing to the platform agent or starting a new workflow.
    const pendingPm = pendingPmSessions.get(conversationId)
    if (pendingPm) {
      const { pmRunId: existingRunId, pmStepId: existingStepId, phase } = pendingPm
      const approval = isApprovalMessage(message)

      let resumePayload: Record<string, unknown>
      if (phase === 'prd-clarify') {
        resumePayload = { answers: message }          // any message = clarification answers
      } else if (phase === 'prd') {
        resumePayload = approval ? { approved: true } : { revise: message }
      } else if (phase === 'tasks') {
        resumePayload = { confirmed: approval }
      } else {
        resumePayload = { approved: approval }        // roadmap: only act on explicit approval
      }

      // For roadmap/tasks, skip if not an explicit approval (let platformAgent handle it)
      const shouldResume = phase === 'prd-clarify' || phase === 'prd' || approval
      if (shouldResume) {
        pendingPmSessions.delete(conversationId)

        const statusText = phase === 'prd-clarify'
          ? 'Got it — generating your PRD...'
          : approval ? 'Approved! Working on the next step...' : 'Revising your PRD...'
        sendEvent('delta', { text: statusText, conversationId })
        fullText = statusText

        const workflow = mastra.getWorkflow('pm-workflow')
        const run = workflow.createRun({ runId: existingRunId })
        const result = await run.resume({ resumeData: resumePayload, step: existingStepId, requestContext })

        if (result.status === 'suspended') {
          for (const [sid, step] of Object.entries(result.steps ?? {})) {
            const s = step as any
            if (s.status !== 'suspended') continue
            const sp = s.suspendPayload ?? {}
            pmRunId = existingRunId
            pmStepId = sid
            if (sp.phase === 'prd') {
              fullText = approval ? `PRD ready for review: "${sp.title}"` : `PRD revised: "${sp.title}"`
              pendingArtifactRef = { type: 'prd', entityId: sp.prdId, title: sp.title || 'PRD', pmRunId, pmStepId }
              pendingPmSessions.set(conversationId, { pmRunId, pmStepId, phase: 'prd' })
            } else if (sp.phase === 'roadmap') {
              fullText = `Roadmap ready for review: "${sp.title}"`
              pendingArtifactRef = { type: 'roadmap', entityId: sp.planId, title: sp.title || 'Roadmap', pmRunId, pmStepId }
              pendingPmSessions.set(conversationId, { pmRunId, pmStepId, phase: 'roadmap' })
            } else if (sp.phase === 'tasks') {
              fullText = `${sp.taskCount} tasks ready for review`
              pendingArtifactRef = { type: 'tasks', entityId: sp.planId, title: `${sp.taskCount} tasks`, pmRunId, pmStepId }
              pendingPmSessions.set(conversationId, { pmRunId, pmStepId, phase: 'tasks' })
            }
            break
          }
        } else if (result.status === 'success') {
          fullText = 'PM workflow completed.'
        }

        const responseTimeMs = Date.now() - startTime
        const atts = attachments.map(a => ({ fileId: a.fileId, name: a.name ?? a.fileId ?? 'attachment', type: a.type ?? '', size: a.size }))
        sendEvent('done', { text: fullText, conversationId, messageId: assistantMessageId, planResult: undefined, artifactRef: pendingArtifactRef ?? undefined })
        saveUserMessage(idToken, conversationId, message, atts)
        saveAssistantMessage(idToken, conversationId, fullText, assistantMessageId, pendingArtifactRef)
        if (pendingArtifactRef) fireArtifactNotification(tenantId, internalUserId, pendingArtifactRef)
        pendingMetrics = { conversationId, tenantId, ragFired: false, ragChunksRetrieved: 0, responseTimeMs, totalTokens: 0, inputTokens: 0, outputTokens: 0, userMessageCount: 1, costUsd: undefined }
        flushMetrics()
        closeStream()
        return
      }
    }

    // Route to pmWorkflow if PM intent is detected
    if (isPmIntent(message)) {
      // Step 1: routing supervisor — pmAgent classifies intent and extracts context
      console.log(`[sse:${sessionId}] PM intent detected — consulting pmAgent for routing`)
      const pmRoutingSchema = z.object({
        intent: z.enum(['prd', 'roadmap', 'tasks']),
        existingPrdId: z.string().nullable().optional(),
        existingPlanId: z.string().nullable().optional(),
      })
      let routing: z.infer<typeof pmRoutingSchema> = { intent: 'prd', existingPrdId: null, existingPlanId: null }
      try {
        const routingResult = await (mastra.getAgent('pm') as any).generate(
          `Classify this PM request: "${message}"`,
          { requestContext, structuredOutput: { schema: pmRoutingSchema } },
        )
        if (routingResult.object) routing = routingResult.object
      } catch (err) {
        console.warn(`[sse:${sessionId}] pmAgent routing failed, defaulting to prd:`, (err as Error).message)
      }

      // Step 2: inject routing context for workflow steps to read
      if (routing.existingPrdId) requestContext.set('existingPrdId', routing.existingPrdId)
      if (routing.existingPlanId) requestContext.set('existingPlanId', routing.existingPlanId)

      console.log(`[sse:${sessionId}] PM routing: intent=${routing.intent} prdId=${routing.existingPrdId ?? 'none'} planId=${routing.existingPlanId ?? 'none'}`)

      // Step 3: start pmWorkflow — steps read existingPrdId/planId from requestContext
      const workflow = mastra.getWorkflow('pm-workflow')
      const run = workflow.createRun()
      agentStream = run.stream({
        inputData: { userPrompt: mastraMessage },
        requestContext,
      })
      isPmWorkflow = true
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

      // Handle workflow-specific events
      if (isPmWorkflow) {
        switch (part.type) {
          case 'workflow-step-start': {
            const stepId = part.payload?.stepId
            console.log(`[sse:${sessionId}] workflow step started: ${stepId}`)
            break
          }
          case 'workflow-step-complete': {
            const stepId = part.payload?.stepId
            console.log(`[sse:${sessionId}] workflow step completed: ${stepId}`)
            break
          }
          case 'workflow-suspended': {
            const suspendPayload = part.payload?.suspendPayload
            const suspendedStep = part.payload?.stepId
            pmRunId = (agentStream as any).runId
            pmStepId = suspendedStep

            if (suspendPayload) {
              const { phase, questions, prdId, planId, taskCount, title } = suspendPayload
              if (phase === 'prd-clarify' && questions) {
                // Emit questions as visible chat text — no card needed, Option B chat handles answers
                sendEvent('delta', { text: questions, conversationId })
                fullText = questions
                // pendingArtifactRef stays null; session tracked in post-loop block via pmRunId/pmStepId
              } else if (phase === 'prd' && prdId) {
                fullText = `PRD draft ready for review: "${title || 'PRD'}"`
                pendingArtifactRef = { type: 'prd', entityId: prdId, title: title || 'PRD', pmRunId, pmStepId }
              } else if (phase === 'roadmap' && planId) {
                fullText = `Roadmap ready for review: "${title || 'Roadmap'}"`
                pendingArtifactRef = { type: 'roadmap', entityId: planId, title: title || 'Roadmap', pmRunId, pmStepId }
              } else if (phase === 'tasks' && planId) {
                fullText = `${taskCount} tasks generated and ready for review`
                pendingArtifactRef = { type: 'tasks', entityId: planId, title: `${taskCount} tasks`, pmRunId, pmStepId }
              }
            }

            console.log(`[sse:${sessionId}] workflow suspended at ${suspendedStep} phase=${suspendPayload?.phase}, runId=${pmRunId}`)
            break
          }
          case 'finish': {
            console.log(`[sse:${sessionId}] workflow completed`)
            fullText = fullText || 'Workflow completed successfully'
            break
          }
        }
        continue
      }

      // Handle agent events
      switch (part.type) {
        case 'text-delta': {
          const text = (part.payload?.text ?? part.textDelta ?? '') as string
          fullText += text
          sendEvent('delta', { text, conversationId })
          break
        }
        // Delegated sub-agent text
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

          // Capture artifact ref when a save tool completes so we can persist it on the message
          const normName = resolvedToolName.toLowerCase().replace(/_/g, '-')
          if (SAVE_TOOL_NAMES.has(normName)) {
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
          inputTokens = (usage?.promptTokens as number | undefined) ?? 0
          outputTokens = (usage?.completionTokens as number | undefined) ?? 0
          totalTokens = inputTokens + outputTokens

          // Fire done immediately — don't wait for memory:save (~2.5s)
          const messageId = assistantMessageId
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

          sendEvent('done', { text: fullText, conversationId, messageId, planResult, artifactRef: pendingArtifactRef ?? undefined })

          const atts = attachments.map(a => ({ fileId: a.fileId, name: a.name ?? a.fileId ?? 'attachment', type: a.type ?? '', size: a.size }))
          saveUserMessage(idToken, conversationId, message, atts)
          saveAssistantMessage(idToken, conversationId, fullText, messageId, pendingArtifactRef)
          if (pendingArtifactRef) {
            fireArtifactNotification(tenantId, internalUserId, pendingArtifactRef)
          }

          pendingMetrics = { conversationId, tenantId, ragFired, ragChunksRetrieved, responseTimeMs, totalTokens, inputTokens, outputTokens, userMessageCount: 1, costUsd }
          if (ragFired) pendingEval = { conversationId, messageId, tenantId, question: message, retrievedChunks: ragChunks, answer: fullText }
          flushMetrics()
          break
        }
      }
    }

    // For PM workflows, the done event and persistence happen here (not inside the loop,
    // because workflow events use `continue` and skip the agent-finish case).
    if (isPmWorkflow) {
      const responseTimeMs = Date.now() - startTime
      const atts = attachments.map(a => ({
        fileId: a.fileId,
        name: a.name ?? a.fileId ?? 'attachment',
        type: a.type ?? '',
        size: a.size,
      }))
      sendEvent('done', {
        text: fullText,
        conversationId,
        messageId: assistantMessageId,
        planResult: undefined,
        artifactRef: pendingArtifactRef ?? undefined,
      })
      saveUserMessage(idToken, conversationId, message, atts)
      saveAssistantMessage(idToken, conversationId, fullText, assistantMessageId, pendingArtifactRef)
      if (pendingArtifactRef) {
        fireArtifactNotification(tenantId, internalUserId, pendingArtifactRef)
      }
      pendingMetrics = {
        conversationId, tenantId, ragFired: false, ragChunksRetrieved: 0,
        responseTimeMs, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        userMessageCount: 1, costUsd: undefined,
      }
      flushMetrics()

      // Register pending session for Option B chat-based resume on next message
      if (pendingArtifactRef?.pmRunId && pendingArtifactRef?.pmStepId) {
        // prd / roadmap / tasks — tracked via artifactRef
        pendingPmSessions.set(conversationId, {
          pmRunId: pendingArtifactRef.pmRunId,
          pmStepId: pendingArtifactRef.pmStepId,
          phase: pendingArtifactRef.type as PendingPmPhase,
        })
      } else if (pmRunId && pmStepId && !pendingArtifactRef) {
        // prd-clarify — questions shown as text, no card; session still needs tracking
        pendingPmSessions.set(conversationId, { pmRunId, pmStepId, phase: 'prd-clarify' })
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

import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { saveUserMessage, saveAssistantMessage, fireArtifactNotification, type ArtifactRefPayload, type AttachmentPayload } from '../persistence.js'
import { downloadMediaAttachment, buildAttachmentNote } from '../media.js'
import { fireMetrics, fireAutoEval, fireToolCallLog, fireKnowledgeGap } from '../events.js'
import { resolveAgent, resolveAgentLabel, platformAgent } from '../mastra/registry.js'
import { olmoDelegationOptions } from '../mastra/subagents/streamOptions.js'
import { runWithGuardrailContext } from '../mastra/guardrails.js'
import { runFairnessCheck } from '../fairness/index.js'
import { getMCPClientForTenant } from '../mastra/tools.js'
import { getThinkingBudget } from '../mastra/thinking.js'
import { applyFolderScope, folderScopeLine } from '../folderScopeContext.js'
import { calculateCostUsd, persistCost } from '../mastra/cost.js'
import { fetchAgentPersonaPrompt, fetchAgentName, fetchAgentPersonality, fetchAgentModelSelection, fetchAllowedSubAgents, recordUsage, resolveInvokedSkills, recordSkillRuns, toMastraSkillName } from '../usage.js'
import { fetchConversationSkillSettings, saveConversationInvokedSkills } from '../persistence.js'
import { mergeInvokedSkills } from '../mastra/skillInvocation.js'
import { debitChatTurn } from '../credits.js'
import { buildGatewayModelString } from '../mastra/model.js'
import { quickGeminiCall } from '../llm/quickCall.js'
import type { Attachment, DownloadedMedia } from '../types.js'
import { lastRagResult } from '../types.js'
import { pendingToolApprovals, sessionActiveToolApprovals } from '../types.js'
import { GENERATION_APPROVAL_METADATA, detectSkillPii } from '../mastra/tools/generationApproval.js'
import { saveGenerationConfirmRequest, updateGenerationConfirmRequest } from '../persistence.js'

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
  // The actual user-typed text (may be empty) — persisted as the message's
  // display content. `message` itself carries the '[attachment]' fallback
  // used to give the agent something to reason over; that placeholder must
  // never reach the chat bubble as literal text.
  displayMessage: string
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
  sendHeartbeat: () => void
  closeStream: () => void
  isStreamClosed: () => boolean
  folderId?: string
  folderPrefix?: string
  allowMode?: 'ask' | 'auto'
  skillsUsed?: Array<{ id: string; name: string }>
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mimeType: string }

export async function buildMastraMessage(
  attachments: Attachment[],
  preamble: string,
  sessionCtx: string,
  message: string,
  sessionId: string,
): Promise<string | { role: 'user'; content: ContentPart[] }> {
  // audio/* and video/* are intentionally excluded from synchronous download —
  // see the buildAttachmentNote doc comment in media.ts for why, and how the
  // agent is told about them instead so it can call analyze_audio/analyze_video
  // on demand.
  const mediaAttachments = attachments.filter(
    (a) =>
      a.type?.startsWith('image/') ||
      a.type === 'application/pdf' ||
      a.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )

  const attachmentNote = buildAttachmentNote(attachments)

  if (mediaAttachments.length === 0) return attachmentNote + preamble + sessionCtx + message

  const downloaded = (await Promise.all(
    mediaAttachments.map((a) => downloadMediaAttachment(a, sessionId))
  ))
    .filter((d): d is DownloadedMedia | DownloadedMedia[] => d !== null)
    .flatMap(d => Array.isArray(d) ? d : [d])

  const textDocs = downloaded.filter(d => d.mimeType === 'text/plain')
  const imageFiles = downloaded.filter(d => d.mimeType !== 'text/plain')

  let finalMessage = attachmentNote + preamble + sessionCtx + message
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

/**
 * Turns one render-canvas tool-result into an AttachmentPayload, or null if
 * this result isn't a persisted canvas output. Pure — callers push the
 * result onto pendingAttachments themselves, so N canvas outputs in one turn
 * each get their own call and their own array entry; nothing here dedupes
 * or overwrites across calls.
 */
export function attachmentFromCanvasToolResult(
  normalizedToolName: string,
  result: Record<string, unknown>,
): AttachmentPayload | null {
  if (!['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video'].includes(normalizedToolName)) return null
  if (typeof result.fileId !== 'string') return null
  const attachment: AttachmentPayload = {
    fileId: result.fileId,
    name: String(result.name ?? 'document.md'),
    type: String(result.fileType ?? 'text/markdown'),
    size: typeof result.size === 'number' ? result.size : 0,
  }
  if (typeof result.creditsUsedMicro === 'string' && typeof result.model === 'string') {
    attachment.generation = { creditsUsedMicro: result.creditsUsedMicro, model: result.model }
  }
  return attachment
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
    message, displayMessage, attachments, conversationId, tenantId,
    internalUserId, idToken, agentId, sessionId, startTime,
    workingMemoryPromise, sendEvent, sendHeartbeat, closeStream, isStreamClosed,
    folderId, folderPrefix, allowMode, skillsUsed,
  } = opts

  // Heartbeat while any tool call is in flight — see sendHeartbeat's doc
  // comment in chat.ts. activeToolCalls tracks concurrent calls (tool-call
  // without a matching tool-result yet) since more than one can be in flight
  // at once; the interval runs only while that count is > 0.
  let activeToolCalls = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const HEARTBEAT_INTERVAL_MS = 15_000
  const onToolCallStart = (): void => {
    activeToolCalls++
    if (!heartbeatTimer) heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
  }
  const onToolCallEnd = (): void => {
    activeToolCalls = Math.max(0, activeToolCalls - 1)
    if (activeToolCalls === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }
  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    activeToolCalls = 0
  }

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
  const pendingAttachments: AttachmentPayload[] = []
  const SAVE_TOOL_NAMES = new Set(['saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks', 'rendercanvas', 'render-canvas', 'render_canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video'])

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
    const sessionCtx = `<session_context>\ntenant_id: ${tenantId}${folderId ? `\nfolder_id: ${folderId}` : ''}${folderScopeLine(folderPrefix)}\n</session_context>\n\n`
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
    applyFolderScope(requestContext, folderPrefix)
    if (allowMode) requestContext.set('allowMode', allowMode)

    const mcpClient = getMCPClientForTenant(tenantId, agentId, sessionId)
    requestContext.set('__mcpClient', mcpClient as any)

    // Test-in-chat conversations carry the tested skill's install id on
    // their own metadata (see startSkillTestChat in the web app) rather
    // than an agent_skills row. Setting it on requestContext is the only
    // thing this route does with it — platformAgent.ts's skills: resolver
    // reads it and composes just that one skill instead of the agent's
    // real attached ones. The agent's persona (below) is unaffected either
    // way — it's a separate concern, read the same regardless of test mode.
    const [skillSettings, agentPersonaPrompt, agentName, personaPersonality, agentModelSelection, allowedSubAgents] = await Promise.all([
      fetchConversationSkillSettings(idToken, conversationId),
      fetchAgentPersonaPrompt(agentId, tenantId),
      fetchAgentName(agentId),
      fetchAgentPersonality(agentId),
      fetchAgentModelSelection(agentId).catch((err) => {
        console.warn(`[sse:${sessionId}] fetchAgentModelSelection failed, falling back to default model:`, (err as Error).message)
        return null
      }),
      fetchAllowedSubAgents(tenantId),
    ])
    if (skillSettings.testSkillInstallId) requestContext.set('testSkillInstallId', skillSettings.testSkillInstallId)
    if (agentPersonaPrompt) {
      requestContext.set('agentSystemPrompt', agentPersonaPrompt)
    }
    requestContext.set('agentName', agentName ?? '')
    if (personaPersonality) {
      requestContext.set('personaPersonality', personaPersonality)
    }
    if (agentModelSelection && agentModelSelection.status === 'live') {
      const modelString = buildGatewayModelString(agentModelSelection.provider, agentModelSelection.model)
      if (modelString) requestContext.set('selectedModel', modelString)
    }
    requestContext.set('allowedSubAgents', allowedSubAgents)

    const thinkingBudget = getThinkingBudget(message)
    requestContext.set('thinkingBudget', thinkingBudget)

    // Agent routing — determined entirely by the conversation's assigned agent.
    // Saarthi conversations always go to platformAgent; PM agent conversations
    // always go to pmAgent. No keyword detection — the user chose the agent
    // when starting the conversation. Internal sub-agent delegation (pmAgent →
    // prdAgent → roadmapAgent → taskAgent) is handled by Mastra internally.
    const activeAgent = resolveAgent(agentName ?? '')
    console.log(`[sse:${sessionId}] agent="${agentName}" → ${resolveAgentLabel(activeAgent)} thinkingBudget=${thinkingBudget}`)

    // "/" turns a skill on for this conversation — never attaches it to the
    // agent. Only Olmo resolves skills, a Test-in-chat conversation runs
    // exactly its one skill, and a failed conversation read (skillSettings.ok
    // false) must not wipe or falsely gate anything — so all three skip the
    // whole block. Both the stored entries and this turn's picks are
    // re-resolved through resolveInvokedSkills, so a forged, foreign, or
    // no-longer-installed stored entry drops out and the saved list
    // self-heals instead of permanently filling the 8-skill cap.
    let skillsInvokedThisTurn: string[] = []
    if ((activeAgent as unknown) === (platformAgent as unknown) && !skillSettings.testSkillInstallId && skillSettings.ok) {
      const [storedResolved, picked] = await Promise.all([
        resolveInvokedSkills(skillSettings.invokedSkills.map((s) => s.skillId), tenantId),
        resolveInvokedSkills((skillsUsed ?? []).map((s) => s.id), tenantId),
      ])
      const { merged, newlyInvoked } = mergeInvokedSkills(storedResolved, picked)
      const pruned = storedResolved.length !== skillSettings.invokedSkills.length
      if (newlyInvoked.length > 0 || pruned) saveConversationInvokedSkills(idToken, conversationId, merged)
      if (newlyInvoked.length > 0) {
        recordSkillRuns(newlyInvoked.map((s) => s.installId), tenantId)
          .catch((err) => console.warn(`[sse:${sessionId}] recordSkillRuns failed:`, (err as Error).message))
      }
      skillsInvokedThisTurn = newlyInvoked.map((s) => toMastraSkillName(s.name))
      requestContext.set('invokedSkillInstallIds', merged.map((s) => s.installId))
      requestContext.set('skillsInvokedThisTurn', skillsInvokedThisTurn)
    }

    const memoryOptions = thinkingBudget === 0 ? { lastMessages: false as const } : undefined

    // Olmo ONLY. The delegation hooks refuse any primitive that is not a
    // registered sub-agent spec, so handing them to another agent that
    // delegates on its own — pmAgent's static prd/roadmap/task map — would
    // refuse every one of its delegations. maxSteps: 20 is Olmo's supervisor
    // budget and is scoped the same way. The same object goes into the
    // approve/decline resumes below: a resumed run rebuilds its tools and
    // step limit from the options passed to it, and restores only memory and
    // stream state from the snapshot, so omitting it there drops both.
    const olmoOptions = (activeAgent as unknown) === (platformAgent as unknown)
      ? olmoDelegationOptions({ tenantId, conversationId, agentId })
      : {}

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
      let currentStream: any = await (activeAgent as any).stream(mastraMessage, {
        memory: {
          thread: conversationId || crypto.randomUUID(),
          resource: tenantId,
          ...(memoryOptions ? { options: memoryOptions } : {}),
        },
        requestContext,
        providerOptions: { 'inference-gateway': { thinkingBudget } },
        ...olmoOptions,
      })

    turnLoop: while (true) {
    for await (const part of currentStream.fullStream as AsyncIterable<any>) {
      if (isStreamClosed()) break turnLoop

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
          onToolCallStart()
          if (toolName === 'retrieve_documents') ragFired = true
          fireToolCallLog({ tenantId, conversationId, userId: internalUserId, toolName, success: true, latencyMs: Date.now() - startTime, args })
          break
        }
        case 'tool-call-approval': {
          const p = part.payload ?? part
          const toolName = (p.toolName ?? '') as string
          const toolCallId = (p.toolCallId ?? '') as string
          const args = (p.args ?? {}) as Record<string, unknown>
          const runId = (currentStream.runId ?? '') as string
          const meta = GENERATION_APPROVAL_METADATA[toolName]

          // A tool paused for approval that this migration doesn't know how
          // to render a card for (shouldn't happen — only the 5 gated tools
          // set requireApproval, and all 5 have a metadata entry from Task
          // 1). Fail open rather than hang the turn on an invisible card.
          if (!meta || !toolCallId) {
            console.error(`[sse:${sessionId}] tool-call-approval for unmapped tool="${toolName}" toolCallId="${toolCallId}" — auto-approving`)
            currentStream = await (activeAgent as any).approveToolCall({ runId, toolCallId, requestContext, ...olmoOptions })
            continue turnLoop
          }

          // The approval card is persisted as a row in the `messages` table,
          // whose `id` column is a uuid (and the save route validates it with
          // Zod `.uuid()`). Mastra's toolCallId is a short nanoid, so it can
          // never be that id — it stays the SSE/pendingToolApprovals
          // correlation key only, and the message gets its own uuid.
          const approvalMessageId = crypto.randomUUID()

          const preview = meta.buildPreview?.(args)
          const piiNote = toolName === 'create_skill' && typeof args.body === 'string' ? detectSkillPii(args.body) : ''
          const label = piiNote ? `${meta.label}${piiNote}` : meta.label

          sendEvent('generation_confirm_request', {
            confirmationId: toolCallId, resourceType: meta.resourceType, subject: meta.subject, label,
            ...(preview ? { preview } : {}),
          })

          if (conversationId && idToken) {
            saveGenerationConfirmRequest(idToken, conversationId, approvalMessageId, {
              id: toolCallId, resourceType: meta.resourceType, subject: meta.subject, label, status: 'pending',
              ...(preview ? { preview } : {}),
            })
          }

          let approvalSet = sessionActiveToolApprovals.get(sessionId)
          if (!approvalSet) {
            approvalSet = new Set()
            sessionActiveToolApprovals.set(sessionId, approvalSet)
          }
          approvalSet.add(toolCallId)

          // No timeout here — unlike the old CONFIRM_TIMEOUT_MS, this waits
          // until the human answers (sessions.ts's /api/chat/generation-confirm
          // route resolves this entry), the connection drops (chat.ts's
          // cancel() handler resolves it), or neither happens and the
          // watchdog's 24h sweep declines the underlying Mastra run directly
          // — which this in-process await never sees resolve, matching the
          // spec's accepted trade-off for a connection abandoned that long.
          const { confirmed, declineReason } = await new Promise<{ confirmed: boolean; declineReason?: string }>((resolve) => {
            pendingToolApprovals.set(toolCallId, {
              resolve, tenantId, runId, toolCallId,
              messageId: approvalMessageId, conversationId, idToken,
            })
          })

          sessionActiveToolApprovals.get(sessionId)?.delete(toolCallId)
          if (sessionActiveToolApprovals.get(sessionId)?.size === 0) sessionActiveToolApprovals.delete(sessionId)

          if (conversationId && idToken) {
            updateGenerationConfirmRequest(idToken, conversationId, approvalMessageId, {
              status: confirmed ? 'approved' : 'declined',
              decisionAt: new Date().toISOString(),
              ...(declineReason ? { declineReason } : {}),
            })
          }

          // The live `requestContext` must be passed back in on resume. Mastra
          // rehydrates a resumed run from its persisted snapshot, and
          // RequestContext.toJSON() drops every function value — including
          // `sendEvent`, which createSkill.ts's live-session guard requires.
          // Without this, approving a create_skill draft resumes with no
          // sendEvent and the skill is never saved.
          currentStream = confirmed
            ? await (activeAgent as any).approveToolCall({ runId, toolCallId, requestContext, ...olmoOptions })
            : await (activeAgent as any).declineToolCall({ runId, toolCallId, reason: declineReason ?? 'Declined by user', requestContext, ...olmoOptions })
          continue turnLoop
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
          onToolCallEnd()

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
          // render-canvas/generate-image/edit-image have no entityId (ephemeral display only) — skip pendingArtifactRef for them.
          const normName = resolvedToolName.toLowerCase().replace(/_/g, '-')
          if (SAVE_TOOL_NAMES.has(normName) && !['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video'].includes(normName)) {
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

          // render-canvas persists its content as a file (see renderCanvas.ts);
          // collect it into the assistant message's attachments alongside any
          // user-uploaded ones, so multiple canvas outputs in one turn all survive.
          const canvasAttachment = attachmentFromCanvasToolResult(normName, result)
          if (canvasAttachment) pendingAttachments.push(canvasAttachment)
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
          debitChatTurn({ tenantId, agentId, messageId: sessionId, model: modelName, inputTokens, outputTokens })
            .catch(err => console.error(`[credits:${sessionId}] debit failed:`, (err as Error).message))
          recordUsage({ tenantId, actorId: agentId, inputTokens, outputTokens })   // the row chat never wrote
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

          sendEvent('done', { text: fullText, conversationId, messageId: assistantMessageId, planResult, artifactRef: pendingArtifactRef ?? undefined, citations: ragSources.length > 0 ? ragSources : undefined, suggestedFollowUps: suggestedFollowUps.length > 0 ? suggestedFollowUps : undefined, attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined })

          // Guard against ghost messages: if the client disconnected (Stop button
          // or navigation) before the agent finished, isStreamClosed() is already
          // true here. Skip persistence so a cancelled turn can't write an
          // out-of-order message into the conversation after the user has moved on.
          if (isStreamClosed()) break

          const atts = attachments.map(a => ({ fileId: a.fileId, name: a.name ?? a.fileId ?? 'attachment', type: a.type ?? '', size: a.size }))
          saveUserMessage(idToken, conversationId, displayMessage, atts, skillsUsed)
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
          saveAssistantMessage(idToken, conversationId, fullText, assistantMessageId, pendingArtifactRef, completedTrace, pendingAttachments)
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
    // The stream ran to completion without a tool-call-approval pause. Every
    // resumption path above uses `continue turnLoop`, so reaching here means
    // the turn is over — without this the while(true) would re-iterate an
    // already-exhausted fullStream forever.
    break turnLoop
    } // end turnLoop while(true)
    }) // end runWithGuardrailContext

    stopHeartbeat()
    closeStream()
  } catch (err) {
    stopHeartbeat()
    console.error(`[sse:${sessionId}] fatal error:`, (err as Error).message)
    sendEvent('error', { message: 'Internal server error', conversationId })
    // Save the user message even on error so attachments aren't lost.
    // The finish path is never reached when the turn throws, so this is the only
    // opportunity to durably persist the user turn.
    const atts = attachments.map(a => ({ fileId: a.fileId, name: a.name ?? a.fileId ?? 'attachment', type: a.type ?? '', size: a.size }))
    saveUserMessage(idToken, conversationId, message, atts, skillsUsed)
    closeStream()
  }
}

import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { saveUserMessage, saveAssistantMessage, fireArtifactNotification, type ArtifactRefPayload, type AttachmentPayload } from '../persistence.js'
import { downloadMediaAttachment, buildAttachmentNote } from '../media.js'
import { fireMetrics, fireAutoEval, fireToolCallLog, fireKnowledgeGap } from '../events.js'
import { resolveAgent, resolveAgentLabel, platformAgent } from '../mastra/registry.js'
import { olmoDelegationOptions } from '../mastra/subagents/streamOptions.js'
import { runWithGuardrailContext } from '../mastra/guardrails.js'
import { runFairnessCheck } from '../fairness/index.js'
import { getMCPClientForTenant } from '../mastra/tools.js'
import { countThreadMessages } from '../mastra/memory.js'
import { getThinkingBudget } from '../mastra/thinking.js'
import { redactReasoningText } from '../mastra/reasoningRedaction.js'
import { applyFolderScope, folderScopeLine } from '../folderScopeContext.js'
import { calculateCostUsd, persistCost } from '../mastra/cost.js'
import { fetchAgentPersonaPrompt, fetchAgentName, fetchAgentOrigin, fetchAgentPersonality, fetchAgentModelSelection, fetchAllowedSubAgents, recordUsage, resolveInvokedSkills, recordSkillRuns, toMastraSkillName } from '../usage.js'
import { fetchConversationSkillSettings, saveConversationInvokedSkills } from '../persistence.js'
import { mergeInvokedSkills, buildSkillInvocationPrepareStep, type InvokedSkill } from '../mastra/skillInvocation.js'
import { debitChatTurn } from '../credits.js'
import { buildGatewayModelString } from '../mastra/model.js'
import { quickGeminiCall } from '../llm/quickCall.js'
import type { Attachment, DownloadedMedia } from '../types.js'
import { lastRagResult } from '../types.js'
import { pendingToolApprovals, sessionActiveToolApprovals } from '../types.js'
import { GENERATION_APPROVAL_METADATA, detectSkillPii } from '../mastra/tools/generationApproval.js'
import { saveGenerationConfirmRequest, updateGenerationConfirmRequest, saveConversationTitle } from '../persistence.js'
import { generateText } from 'ai'
import { liteModel } from '../mastra/model.js'

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

async function generateTitle(userMessage: string): Promise<string> {
  const result = await generateText({
    model: liteModel,
    prompt: `Generate a short conversation title (max 6 words, no quotes, no trailing punctuation) summarizing this user message:\n\n${userMessage.slice(0, 400)}\n\nTitle:`,
  })
  return result.text.trim().replace(/^["']|["']$/g, '').slice(0, 255)
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
  // Client already knows whether this is the first message of the
  // conversation (its own local message list) — cheaper than a DB round
  // trip here to re-derive it.
  isFirstMessage?: boolean
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
  if (!['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video', 'generate-narration', 'lipsync', 'assemble-clips', 'mux-beat-audio', 'composite-end-card', 'burn-captions', 'mix-music-bed', 'trim-clip'].includes(normalizedToolName)) return null
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

const FILE_ID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g

/**
 * Assistant text persisted to messages.content is the leak vector for a
 * fabricated-attachment class of bug: a fileId mentioned in prose (e.g. "File
 * ID: <uuid> was generated and attached above") reads as an authoritative
 * fact to a future turn's model once it's back in context via lastMessages —
 * even when messages.attachments never actually recorded that file (a
 * plumbing gap fixed in e69504b8, an upload failure, etc). Confirmed live
 * 2026-09-17: Olmo cited a real-but-orphaned fileId from an earlier turn's
 * text as if it were a fresh attachment, with zero tool call that turn.
 * The attachments column (not prose) is the only source of truth for what is
 * actually attached, so any raw UUID in the text that isn't one of this
 * turn's real attachment fileIds gets redacted before persisting — with a
 * marker that reads as "don't trust this" to a future model, rather than
 * silently vanishing or (worse) staying verbatim.
 */
export function redactUnverifiedFileIds(text: string, attachments: AttachmentPayload[]): string {
  const verified = new Set(attachments.map((a) => a.fileId.toLowerCase()))
  return text.replace(FILE_ID_PATTERN, (match) =>
    verified.has(match.toLowerCase()) ? match : '[unverified reference removed]'
  )
}

// True iff the two lists carry the same (installId, name) pairs, regardless
// of order. A length-only compare misses a forged/stale stored entry that
// still resolves to a *different* installId or name than what the client had
// stored — this catches that case so it still triggers a save-back.
function sameInvokedSkillSet(a: InvokedSkill[], b: InvokedSkill[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => `${s.installId}::${s.name}`))
  return b.every((s) => setA.has(`${s.installId}::${s.name}`))
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
    folderId, folderPrefix, allowMode, skillsUsed, isFirstMessage,
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
  const SAVE_TOOL_NAMES = new Set(['saveprd', 'saveplan', 'savetasks', 'save-prd', 'save-plan', 'save-tasks', 'rendercanvas', 'render-canvas', 'render_canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video', 'generate-narration', 'lipsync', 'assemble-clips', 'mux-beat-audio', 'composite-end-card', 'burn-captions', 'mix-music-bed', 'trim-clip'])

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
    const [skillSettings, agentPersonaPrompt, agentName, agentOrigin, personaPersonality, agentModelSelection, allowedSubAgents, threadMessageCount] = await Promise.all([
      fetchConversationSkillSettings(idToken, conversationId),
      fetchAgentPersonaPrompt(agentId, tenantId),
      fetchAgentName(agentId),
      fetchAgentOrigin(agentId),
      fetchAgentPersonality(agentId),
      fetchAgentModelSelection(agentId).catch((err) => {
        console.warn(`[sse:${sessionId}] fetchAgentModelSelection failed, falling back to default model:`, (err as Error).message)
        return null
      }),
      fetchAllowedSubAgents(tenantId),
      countThreadMessages(conversationId),
    ])
    if (skillSettings.testSkillInstallId) requestContext.set('testSkillInstallId', skillSettings.testSkillInstallId)
    if (agentPersonaPrompt) {
      requestContext.set('agentSystemPrompt', agentPersonaPrompt)
    }
    requestContext.set('agentName', agentName ?? '')
    requestContext.set('isBuiltInAgent', agentOrigin === 'built_in')
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
      // A database error returns null, not []. Neither lookup's result can be
      // trusted as "nothing resolved" in that case — unverified stored
      // entries must not load, and nothing may be saved over the real list,
      // so a null from either lookup skips the whole rest of the block, same
      // as a failed conversation read does above.
      if (storedResolved !== null && picked !== null) {
        // The resolve query has no ORDER BY, so the resolved rows can come
        // back in any order — reorder to follow the stored list's own order
        // (by skillId) before merging, so order alone never looks like a
        // change to save back.
        const storedOrder = new Map(skillSettings.invokedSkills.map((s, i) => [s.skillId, i]))
        const orderedStoredResolved = [...storedResolved].sort(
          (a, b) => (storedOrder.get(a.skillId) ?? 0) - (storedOrder.get(b.skillId) ?? 0),
        )
        const { merged, newlyInvoked } = mergeInvokedSkills(orderedStoredResolved, picked)
        // A forged/stale stored entry (wrong installId or name) still
        // resolves — the server-truth row just doesn't match what was
        // stored — so a length-only compare would miss it; compare the sets
        // themselves, ignoring order.
        const pruned = !sameInvokedSkillSet(orderedStoredResolved, skillSettings.invokedSkills)
        if (newlyInvoked.length > 0 || pruned) saveConversationInvokedSkills(idToken, conversationId, merged)
        if (newlyInvoked.length > 0) {
          recordSkillRuns(newlyInvoked.map((s) => s.installId), tenantId)
            .catch((err) => console.warn(`[sse:${sessionId}] recordSkillRuns failed:`, (err as Error).message))
        }
        skillsInvokedThisTurn = newlyInvoked.map((s) => toMastraSkillName(s.name))
        requestContext.set('invokedSkillInstallIds', merged.map((s) => s.installId))
        requestContext.set('skillsInvokedThisTurn', skillsInvokedThisTurn)
      }
    }

    // Semantic recall is a pgvector similarity search over the thread's stored
    // messages (measured 2.7–5.4s per turn in mastra_ai_spans). It's dead weight
    // when either (a) the model isn't reasoning anyway — thinkingBudget === 0
    // means a conversational turn where recall content wouldn't be used, or
    // (b) the thread has ≤20 messages, so the loaded `lastMessages: 20` window
    // already contains everything recall could return. Gate only semantic
    // recall, never lastMessages. A `lastMessages: false` gate for budget=0
    // turns used to also apply here on the theory that a short/conversational
    // turn never needs history — but COST_CONFIRMATION_CONTRACT's plan-approval
    // flow (35a8d30c) depends on Olmo seeing its own prior "here's the plan"
    // turn to recognize a short reply like "approve"/"yes"/"go" as an
    // affirmative. Every canonical approval word is short enough to hit
    // thinkingBudget === 0 (see thinking.ts's CONVERSATIONAL set and length<15
    // check), so stripping history on exactly those turns silently broke
    // delegation on approval — confirmed live 2026-09-17. History loading is
    // cheap relative to the model call itself (cheaper still with response
    // caching), so keep it always; only semantic recall's separate pgvector
    // query is worth gating off.
    const SEMANTIC_RECALL_MIN_MESSAGES = 20
    const disableRecall = thinkingBudget === 0 || threadMessageCount <= SEMANTIC_RECALL_MIN_MESSAGES
    const memoryOptions = disableRecall ? { semanticRecall: false as const } : undefined
    if (disableRecall) {
      console.log(`[sse:${sessionId}] semantic-recall gated off (budget=${thinkingBudget}, threadMessages=${threadMessageCount})`)
    }

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

    // Mastra-native: force the built-in skill tool for the first N steps of
    // the turn that invoked N skills, so their instructions load before the
    // answer. Undefined on every other turn, so nothing is forced.
    const skillInvocationPrepareStep = buildSkillInvocationPrepareStep(skillsInvokedThisTurn.length)

    let fullText = ''
    // Three different producers write into fullText: the parent (Olmo) agent's
    // own tokens, a delegated sub-agent's tokens, and tool-result summaries
    // injected as synthetic text. Concatenating them blindly glues unrelated
    // sentences together with no separator at the seam ("...working on.Okay,
    // Google Ads it is." / "PBXGlobalHere are the ad visuals..."). appendText
    // inserts a paragraph break whenever the producer changes and returns the
    // exact string to stream, so the live delta the browser renders and the
    // fullText that gets persisted can never disagree about where the breaks
    // are. Every text append must go through it.
    let lastTextSource: string | null = null
    const appendText = (source: string, text: string): string => {
      // Empty deltas are dropped rather than forwarded (callers skip sendEvent on
      // ''): the 'delta' event carries nothing but `text` and `conversationId` —
      // the browser mints the turn's messageId itself (useChat.ts), so an empty
      // delta establishes no state there and forwarding it only risks pushing an
      // empty assistant row. lastTextSource is deliberately left untouched too:
      // a producer that emitted no characters hasn't taken over the seam.
      if (!text) return ''
      const needsSeparator =
        lastTextSource !== null &&
        lastTextSource !== source &&
        fullText.length > 0 &&
        !/\s$/.test(fullText) &&
        !text.startsWith('\n')
      lastTextSource = source
      const out = needsSeparator ? `\n\n${text}` : text
      fullText += out
      return out
    }
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
        ...(skillInvocationPrepareStep ? { prepareStep: skillInvocationPrepareStep } : {}),
      })

    turnLoop: while (true) {
    for await (const part of currentStream.fullStream as AsyncIterable<any>) {
      if (isStreamClosed()) break turnLoop

      // TEMP INSTRUMENTATION — task 8 delegate approval test
      console.log(`[task8:${sessionId}] chunk type=${part.type}${part.payload?.toolName ? ` toolName=${part.payload.toolName}` : ''}${part.payload?.toolCallId ? ` toolCallId=${part.payload.toolCallId}` : ''}${part.payload?.agentId ? ` agentId=${part.payload.agentId}` : ''}`)

      switch (part.type) {
        case 'text-delta': {
          const text = (part.payload?.text ?? part.textDelta ?? '') as string
          const out = appendText('parent', text)
          if (out) sendEvent('delta', { text: out, conversationId })
          break
        }
        // Extended-thinking trace — never part of fullText/the persisted message,
        // just forwarded live for the "thinking it through" UI. See thinkingBudget
        // above and includeThoughts in the inference-gateway Vertex/Gemini adapters.
        case 'reasoning-delta': {
          const rawText = (part.payload?.text ?? part.delta ?? part.textDelta ?? '') as string
          if (rawText) {
            // Redacted before both the persisted trace and the live UI event —
            // see reasoningRedaction.ts for why the prompt-level instruction
            // alone isn't a guarantee.
            const text = redactReasoningText(rawText)
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
          // Keyed per delegate where the payload identifies one, so two
          // sub-agents speaking back to back are separated too — not just
          // parent-vs-delegate.
          // Identity fields only — never a per-chunk value like a step/run id,
          // which would key a different "source" for every token and break the
          // text apart mid-sentence.
          // primitiveId is what the delegation hooks key a sub-agent by (see
          // olmoDelegationOptions); toolCallId/runId identify the delegation
          // *call* and stay constant for its whole run, so they still separate
          // two back-to-back delegates when no name is carried. Falling through
          // to a constant would key both as the same source and glue their text
          // together — the exact seam this function exists to break.
          const delegate = (part.payload?.agentId
            ?? part.payload?.agentName
            ?? part.payload?.name
            ?? part.payload?.primitiveId
            ?? part.payload?.toolCallId
            ?? part.payload?.runId
            ?? '') as string
          const out = appendText(delegate ? `delegate:${delegate}` : 'delegate', text)
          if (out) sendEvent('delta', { text: out, conversationId })
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
          // to render a card for (shouldn't happen — only the 8 gated tools
          // set requireApproval, and all 8 have a metadata entry from Task
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
          const piiNote = toolName === 'save_skill' && typeof args.body === 'string' ? detectSkillPii(args.body) : ''
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
          // `sendEvent`, which saveSkill.ts's live-session guard requires.
          // Without this, approving a save_skill draft resumes with no
          // sendEvent and the skill is never saved.
          console.log(`[task8:${sessionId}] BEFORE ${confirmed ? 'approveToolCall' : 'declineToolCall'} runId=${runId} toolCallId=${toolCallId} toolName=${toolName} args=${JSON.stringify(args).slice(0, 400)} olmoOptionsKeys=${Object.keys(olmoOptions).join(',')}`)
          currentStream = confirmed
            ? await (activeAgent as any).approveToolCall({ runId, toolCallId, requestContext, ...olmoOptions })
            : await (activeAgent as any).declineToolCall({ runId, toolCallId, reason: declineReason ?? 'Declined by user', requestContext, ...olmoOptions })
          console.log(`[task8:${sessionId}] AFTER ${confirmed ? 'approve' : 'decline'}ToolCall newRunId=${currentStream?.runId ?? 'none'} hasFullStream=${!!currentStream?.fullStream}`)
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
            // Keyed by toolCallId, not just the tool name, so two summaries from
            // the same tool in one turn are still separated from each other.
            const out = appendText(`tool:${resolvedToolName}:${toolCallId}`, result.summary)
            if (out) sendEvent('delta', { text: out, conversationId })
          }

          // Capture artifact ref when a save tool (savePRD / savePlan / saveTasks) completes.
          // render-canvas/generate-image/edit-image have no entityId (ephemeral display only) — skip pendingArtifactRef for them.
          const normName = resolvedToolName.toLowerCase().replace(/_/g, '-')
          if (SAVE_TOOL_NAMES.has(normName) && !['render-canvas', 'generate-image', 'edit-image', 'generate-song', 'generate-video', 'generate-narration', 'lipsync', 'assemble-clips', 'mux-beat-audio', 'composite-end-card', 'burn-captions', 'mix-music-bed', 'trim-clip'].includes(normName)) {
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

          // A delegate wrapper's own tool-result (toolName agent-director/
          // agent-producer) never carries fileId at the top level — the real
          // generate_image/generate_video/edit_image result lives nested in
          // subAgentToolResults (see includeSubAgentToolResultsInModelContext
          // in subagents/hooks.ts, which puts it there for Olmo to read). Without
          // this unwrap, a delegate-produced attachment never reaches the SSE
          // `done` event or saveAssistantMessage — the file exists in S3 and the
          // tenant is charged, but the UI never gets an attachment card for it.
          // Confirmed live 2026-09-17: a real generate_video result was silently
          // dropped this way.
          if (Array.isArray(result.subAgentToolResults)) {
            for (const entry of result.subAgentToolResults as Array<{ toolName?: unknown; result?: unknown }>) {
              const innerName = typeof entry.toolName === 'string' ? entry.toolName.toLowerCase().replace(/_/g, '-') : ''
              const innerResult = (entry.result ?? {}) as Record<string, unknown>
              const innerAttachment = attachmentFromCanvasToolResult(innerName, innerResult)
              if (innerAttachment) pendingAttachments.push(innerAttachment)
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

          // Title generation is fire-and-forget: never let it block the
          // 'done' event, and let saveConversationTitle's own error handling
          // absorb failures — a missing title just falls back to the
          // frontend's "Chat with {agent}" default.
          if (isFirstMessage) {
            Promise.race([
              generateTitle(message),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
            ]).then((title) => {
              if (title) saveConversationTitle(idToken, conversationId, title)
            }).catch(() => {})
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
          saveAssistantMessage(idToken, conversationId, redactUnverifiedFileIds(fullText, pendingAttachments), assistantMessageId, pendingArtifactRef, completedTrace, pendingAttachments)
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

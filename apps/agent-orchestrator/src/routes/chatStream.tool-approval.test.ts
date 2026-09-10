import { describe, it, expect, vi, beforeEach } from 'vitest'

// This is an integration test of runChatStream's turnLoop (Task 5): a fake
// Agent whose .stream() yields a `tool-call-approval` chunk, resumed via
// approveToolCall/declineToolCall once the corresponding pendingToolApprovals
// entry is resolved — the same thing sessions.ts's /generation-confirm route
// does to a live entry. Everything chatStream.ts imports besides the agent
// registry and generationApproval metadata is a DB/network/LLM call that has
// to be stubbed out for the turn to run to completion in-process; the mock
// list below mirrors chatStream.ts's own import list (see chatStream.ts),
// not the unrelated chat-agent-tenant.test.ts fixture (that file mocks
// chatStream.js itself, so it never exercises this code path).
//
// Deliberately NOT mocked: '../types.js' (pendingToolApprovals is the real
// Map under test), '../folderScopeContext.js' (pure string helpers, no
// external deps) and '@mastra/core/request-context' (real RequestContext
// class — safe to construct in-process, no I/O).

const { approveToolCall, declineToolCall, streamMock } = vi.hoisted(() => ({
  approveToolCall: vi.fn(),
  declineToolCall: vi.fn(),
  streamMock: vi.fn(),
}))

function fakeStream(chunks: any[], runId: string) {
  return {
    runId,
    fullStream: (async function* () { for (const c of chunks) yield c })(),
  }
}

vi.mock('../mastra/registry.js', () => ({
  resolveAgent: () => ({
    stream: streamMock,
    approveToolCall,
    declineToolCall,
  }),
  resolveAgentLabel: () => 'test-agent',
}))

vi.mock('../mastra/tools/generationApproval.js', () => ({
  GENERATION_APPROVAL_METADATA: {
    'generate-image': { resourceType: 'image_generation', subject: 'model-x', label: 'Generate image' },
  },
  detectSkillPii: () => '',
}))

vi.mock('../persistence.js', () => ({
  saveUserMessage: vi.fn(),
  saveAssistantMessage: vi.fn(),
  fireArtifactNotification: vi.fn(),
  fetchConversationTestSkillInstallId: vi.fn().mockResolvedValue(null),
  saveGenerationConfirmRequest: vi.fn(),
  updateGenerationConfirmRequest: vi.fn(),
}))

vi.mock('../media.js', async () => {
  const actual = await vi.importActual<typeof import('../media.js')>('../media.js')
  return {
    downloadMediaAttachment: vi.fn(),
    buildAttachmentNote: actual.buildAttachmentNote,
  }
})

vi.mock('../events.js', () => ({
  fireMetrics: vi.fn(),
  fireAutoEval: vi.fn(),
  fireToolCallLog: vi.fn(),
  fireKnowledgeGap: vi.fn(),
}))

vi.mock('../mastra/guardrails.js', () => ({
  runWithGuardrailContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
}))

vi.mock('../fairness/index.js', () => ({
  runFairnessCheck: vi.fn(),
}))

vi.mock('../mastra/tools.js', () => ({
  getMCPClientForTenant: vi.fn().mockReturnValue({}),
}))

vi.mock('../mastra/thinking.js', () => ({
  getThinkingBudget: vi.fn().mockReturnValue(0),
}))

vi.mock('../mastra/cost.js', () => ({
  calculateCostUsd: vi.fn().mockReturnValue(0),
  persistCost: vi.fn(),
}))

vi.mock('../usage.js', () => ({
  fetchAgentPersonaPrompt: vi.fn().mockResolvedValue(null),
  fetchAgentName: vi.fn().mockResolvedValue('test-agent'),
  fetchAgentPersonality: vi.fn().mockResolvedValue(null),
  fetchAgentModelSelection: vi.fn().mockResolvedValue(null),
  fetchAllowedSubAgents: vi.fn().mockResolvedValue(['pm', 'architect', 'director', 'producer']),
  recordUsage: vi.fn(),
}))

vi.mock('../credits.js', () => ({
  debitChatTurn: vi.fn().mockResolvedValue(undefined),
}))

// mastra/model.js and mastra/memory.js were not previously reachable from
// this test — chatStream.ts now imports mastra/subagents/streamOptions.js,
// which transitively pulls in the full delegate registry (pmAgent,
// architectAgent, directorAgent, producerAgent and what they in turn import),
// so these two mocks now need to cover every export that chain touches at
// module-load time, not just buildGatewayModelString. model.js has no
// top-level I/O, so its real exports are spread in via importActual; memory.js
// opens a real Postgres pool at import time (DATABASE_URL, top-level DNS
// resolution) and cannot be loaded in a test process, so it stays a full
// explicit replacement.
vi.mock('../mastra/model.js', async () => {
  const actual = await vi.importActual<typeof import('../mastra/model.js')>('../mastra/model.js')
  return { ...actual, buildGatewayModelString: vi.fn().mockReturnValue(null) }
})
vi.mock('../mastra/memory.js', () => ({
  getMastraStore: vi.fn().mockReturnValue({}),
  getMastraVector: vi.fn().mockReturnValue({}),
  getMastraMemory: vi.fn().mockReturnValue({}),
  getOlmoMemory: vi.fn().mockReturnValue({}),
  truncateMastraThread: vi.fn().mockResolvedValue(0),
  embedder: {},
  resolvedDbHost: 'localhost',
  isNeonDb: false,
  dbUrl: new URL('postgresql://localhost/db'),
}))

vi.mock('../llm/quickCall.js', () => ({
  quickGeminiCall: vi.fn().mockResolvedValue('[]'),
}))

import { runChatStream, type ChatStreamOpts } from './chatStream.js'
import { pendingToolApprovals } from '../types.js'

function baseOpts(overrides: Partial<ChatStreamOpts>): ChatStreamOpts {
  return {
    message: 'draw a cat',
    displayMessage: 'draw a cat',
    attachments: [],
    conversationId: 'conv-1',
    tenantId: 'tenant-1',
    internalUserId: 'user-1',
    idToken: 'id-token',
    agentId: 'agent-1',
    sessionId: 'session-1',
    startTime: Date.now(),
    workingMemoryPromise: Promise.resolve(null),
    sendHeartbeat: vi.fn(),
    closeStream: vi.fn(),
    isStreamClosed: () => false,
    ...overrides,
  } as ChatStreamOpts
}

describe('runChatStream — tool-call-approval round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingToolApprovals.clear()
  })

  it('approves: sends generation_confirm_request, then resumes via approveToolCall', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-1', args: { prompt: 'a cat' } } }],
      'run-1',
    ))
    approveToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-1',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-1' }))
    )
    pendingToolApprovals.get('tc-1')?.resolve({ confirmed: true })

    await runPromise
    // The live requestContext must be forwarded on resume — Mastra rehydrates
    // from the persisted snapshot otherwise, and RequestContext.toJSON() drops
    // every function value (sendEvent included).
    const streamedRequestContext = streamMock.mock.calls[0][1].requestContext
    expect(streamedRequestContext).toBeTruthy()
    expect(approveToolCall).toHaveBeenCalledWith({
      runId: 'run-1',
      toolCallId: 'tc-1',
      requestContext: streamedRequestContext,
    })
    expect(declineToolCall).not.toHaveBeenCalled()
  })

  it('declines: resumes via declineToolCall with the reason', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-2', args: { prompt: 'a dog' } } }],
      'run-2',
    ))
    declineToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-2',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-2' }))
    )
    pendingToolApprovals.get('tc-2')?.resolve({ confirmed: false, declineReason: 'too expensive' })

    await runPromise
    const streamedRequestContext = streamMock.mock.calls[0][1].requestContext
    expect(streamedRequestContext).toBeTruthy()
    expect(declineToolCall).toHaveBeenCalledWith({
      runId: 'run-2',
      toolCallId: 'tc-2',
      reason: 'too expensive',
      requestContext: streamedRequestContext,
    })
    expect(approveToolCall).not.toHaveBeenCalled()
  })
})

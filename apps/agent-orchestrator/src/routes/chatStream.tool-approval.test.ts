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

const { approveToolCall, declineToolCall, streamMock, agents } = vi.hoisted(() => {
  const approveToolCall = vi.fn()
  const declineToolCall = vi.fn()
  const streamMock = vi.fn()
  // Two distinct fake agents sharing the same spies. chatStream.ts gates the
  // Olmo delegation options on `activeAgent === platformAgent`, so which one
  // resolveAgent returns decides whether those options are sent.
  const olmo = { stream: streamMock, approveToolCall, declineToolCall }
  const other = { stream: streamMock, approveToolCall, declineToolCall }
  return { approveToolCall, declineToolCall, streamMock, agents: { olmo, other, current: 'other' as 'olmo' | 'other' } }
})

function fakeStream(chunks: any[], runId: string) {
  return {
    runId,
    fullStream: (async function* () { for (const c of chunks) yield c })(),
  }
}

vi.mock('../mastra/registry.js', () => ({
  resolveAgent: () => agents[agents.current],
  resolveAgentLabel: () => 'test-agent',
  platformAgent: agents.olmo,
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
  fetchConversationSkillSettings: vi.fn().mockResolvedValue({ ok: true, testSkillInstallId: null, invokedSkills: [] }),
  saveConversationInvokedSkills: vi.fn(),
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
  resolveInvokedSkills: vi.fn().mockResolvedValue([]),
  recordSkillRuns: vi.fn().mockResolvedValue(undefined),
  toMastraSkillName: (raw: string) => raw.toLowerCase(),
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
import * as persistence from '../persistence.js'
import * as usage from '../usage.js'

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
    agents.current = 'other'
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

describe('runChatStream — Olmo-only delegation options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingToolApprovals.clear()
  })

  async function runOneApproval(confirmed: boolean) {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-9', args: { prompt: 'x' } } }],
      'run-9',
    ))
    const resumed = fakeStream([{ type: 'finish', payload: { output: { usage: {} } } }], 'run-9')
    if (confirmed) approveToolCall.mockResolvedValueOnce(resumed)
    else declineToolCall.mockResolvedValueOnce(resumed)
    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))
    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-9' }))
    )
    pendingToolApprovals.get('tc-9')?.resolve(confirmed ? { confirmed: true } : { confirmed: false, declineReason: 'no' })
    await runPromise
    return streamMock.mock.calls[0][1]
  }

  it('does not hand the delegation hooks or maxSteps to a non-Olmo agent (e.g. pmAgent)', async () => {
    // pmAgent delegates to its own static prd/roadmap/task map; the hooks
    // would refuse every one of those as an unregistered sub-agent.
    agents.current = 'other'
    const streamOpts = await runOneApproval(true)
    expect(streamOpts).not.toHaveProperty('delegation')
    expect(streamOpts).not.toHaveProperty('maxSteps')
    expect(approveToolCall.mock.calls[0][0]).not.toHaveProperty('delegation')
    expect(approveToolCall.mock.calls[0][0]).not.toHaveProperty('maxSteps')
  })

  it('sends the delegation config and maxSteps to Olmo, and again on the approve resume', async () => {
    agents.current = 'olmo'
    const streamOpts = await runOneApproval(true)
    expect(streamOpts.maxSteps).toBe(20)
    expect(typeof streamOpts.delegation?.onDelegationStart).toBe('function')
    // A resumed run rebuilds tools and the step limit from these options, not
    // from the snapshot — so the same config must be passed back in.
    expect(approveToolCall).toHaveBeenCalledWith({
      runId: 'run-9',
      toolCallId: 'tc-9',
      requestContext: streamOpts.requestContext,
      maxSteps: 20,
      delegation: streamOpts.delegation,
    })
  })

  it('sends the delegation config and maxSteps on the decline resume too', async () => {
    agents.current = 'olmo'
    const streamOpts = await runOneApproval(false)
    expect(declineToolCall).toHaveBeenCalledWith({
      runId: 'run-9',
      toolCallId: 'tc-9',
      reason: 'no',
      requestContext: streamOpts.requestContext,
      maxSteps: 20,
      delegation: streamOpts.delegation,
    })
  })
})

describe('runChatStream — "/" skill invocation gates', () => {
  const STORED = { installId: 'install-stored', skillId: 'skill-stored', name: 'Stored Skill' }
  const PICKED = { installId: 'install-picked', skillId: 'skill-picked', name: 'Picked Skill' }

  function finishOnly(runId: string) {
    return fakeStream([{ type: 'finish', payload: { output: { usage: {} } } }], runId)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    pendingToolApprovals.clear()
    agents.current = 'olmo'
    // Re-establish defaults every time: a prior test's mockImplementation on
    // these two would otherwise leak forward — vi.clearAllMocks() only clears
    // call history, not a previously-set implementation.
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({ testSkillInstallId: null, invokedSkills: [], ok: true })
    vi.mocked(persistence.saveConversationInvokedSkills).mockReturnValue(undefined)
    vi.mocked(usage.resolveInvokedSkills).mockResolvedValue([])
    vi.mocked(usage.recordSkillRuns).mockResolvedValue(undefined)
  })

  it('Test-in-chat: does not resolve or save, even when the request carries skillsUsed', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: 'install-t', invokedSkills: [], ok: true,
    })
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-1'))
    await runChatStream(baseOpts({ sendEvent: vi.fn(), skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    expect(usage.resolveInvokedSkills).not.toHaveBeenCalled()
    expect(persistence.saveConversationInvokedSkills).not.toHaveBeenCalled()
  })

  it('Olmo only: does not resolve or save when activeAgent is not platformAgent', async () => {
    agents.current = 'other'
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-2'))
    await runChatStream(baseOpts({ sendEvent: vi.fn(), skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    expect(usage.resolveInvokedSkills).not.toHaveBeenCalled()
    expect(persistence.saveConversationInvokedSkills).not.toHaveBeenCalled()
  })

  it('read failure (ok: false): does not resolve or save, and leaves both context keys unset', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [], ok: false,
    })
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-3'))
    await runChatStream(baseOpts({ sendEvent: vi.fn(), skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    expect(usage.resolveInvokedSkills).not.toHaveBeenCalled()
    expect(persistence.saveConversationInvokedSkills).not.toHaveBeenCalled()
    const ctx = streamMock.mock.calls[0][1].requestContext
    expect(ctx.get('invokedSkillInstallIds')).toBeUndefined()
    expect(ctx.get('skillsInvokedThisTurn')).toBeUndefined()
  })

  it('stored lookup returning null: no save, no recordSkillRuns, neither context key set', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [STORED], ok: true,
    })
    // The stored-ids lookup fails at the DB; the picks lookup would have
    // succeeded on its own — a database error on one lookup must still gate
    // the whole block, not just the half that failed.
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(STORED.skillId) ? null : [])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-7'))
    await runChatStream(baseOpts({ sendEvent: vi.fn(), skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    expect(persistence.saveConversationInvokedSkills).not.toHaveBeenCalled()
    expect(usage.recordSkillRuns).not.toHaveBeenCalled()
    const ctx = streamMock.mock.calls[0][1].requestContext
    expect(ctx.get('invokedSkillInstallIds')).toBeUndefined()
    expect(ctx.get('skillsInvokedThisTurn')).toBeUndefined()
  })

  it('picks lookup returning null: no save, no recordSkillRuns, neither context key set', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [], ok: true,
    })
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(PICKED.skillId) ? null : [])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-8'))
    await runChatStream(baseOpts({ sendEvent: vi.fn(), skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    expect(persistence.saveConversationInvokedSkills).not.toHaveBeenCalled()
    expect(usage.recordSkillRuns).not.toHaveBeenCalled()
    const ctx = streamMock.mock.calls[0][1].requestContext
    expect(ctx.get('invokedSkillInstallIds')).toBeUndefined()
    expect(ctx.get('skillsInvokedThisTurn')).toBeUndefined()
  })

  it('the stored lookup is called with the verified tenant id, not a body value', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [STORED], ok: true,
    })
    vi.mocked(usage.resolveInvokedSkills).mockResolvedValue([STORED])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-9'))
    await runChatStream(baseOpts({ sendEvent: vi.fn(), tenantId: 'tenant-1' }))
    // baseOpts's tenantId is the only tenant id this route ever threads
    // through — there is no separate client-body tenant field — so the
    // stored lookup (the first resolveInvokedSkills call) must be called
    // with exactly it.
    expect(usage.resolveInvokedSkills).toHaveBeenNthCalledWith(1, [STORED.skillId], 'tenant-1')
  })

  it('a stored entry with a forged name/installId that still resolves saves the server truth', async () => {
    const forgedStored = { installId: 'forged-install-id', skillId: STORED.skillId, name: 'Forged Name' }
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [forgedStored], ok: true,
    })
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(STORED.skillId) ? [STORED] : [])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-10'))
    await runChatStream(baseOpts({ sendEvent: vi.fn() }))
    expect(persistence.saveConversationInvokedSkills).toHaveBeenCalledWith('id-token', 'conv-1', [STORED])
  })

  it('stored entries resolving in a different order do not trigger a save', async () => {
    const A = { installId: 'install-a', skillId: 'skill-a', name: 'A' }
    const B = { installId: 'install-b', skillId: 'skill-b', name: 'B' }
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [A, B], ok: true,
    })
    // Resolves in the opposite order to how they were stored.
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(A.skillId) && ids.includes(B.skillId) ? [B, A] : [])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-11'))
    await runChatStream(baseOpts({ sendEvent: vi.fn() }))
    expect(persistence.saveConversationInvokedSkills).not.toHaveBeenCalled()
  })

  it('saves nothing when every stored entry still resolves and nothing new was picked', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [STORED], ok: true,
    })
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(STORED.skillId) ? [STORED] : [])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-4'))
    await runChatStream(baseOpts({ sendEvent: vi.fn() }))
    expect(persistence.saveConversationInvokedSkills).not.toHaveBeenCalled()
  })

  it('saves the merged list when this turn picks a new skill', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [], ok: true,
    })
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(PICKED.skillId) ? [PICKED] : [])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-5'))
    await runChatStream(baseOpts({ sendEvent: vi.fn(), skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    expect(persistence.saveConversationInvokedSkills).toHaveBeenCalledWith('id-token', 'conv-1', [PICKED])
    expect(usage.recordSkillRuns).toHaveBeenCalledWith([PICKED.installId], 'tenant-1')
  })

  it('saves the pruned list when a stored entry no longer resolves', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [STORED], ok: true,
    })
    // Neither the stored id nor an (absent) picked id resolves to anything —
    // the stored skill was uninstalled/deactivated since it was saved.
    vi.mocked(usage.resolveInvokedSkills).mockResolvedValue([])
    streamMock.mockResolvedValueOnce(finishOnly('run-skill-6'))
    await runChatStream(baseOpts({ sendEvent: vi.fn() }))
    expect(persistence.saveConversationInvokedSkills).toHaveBeenCalledWith('id-token', 'conv-1', [])
    expect(usage.recordSkillRuns).not.toHaveBeenCalled()
  })
})

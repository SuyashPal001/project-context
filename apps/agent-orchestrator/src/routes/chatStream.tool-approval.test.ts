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
    'generate_videos': {
      resourceType: 'video_generation', subject: 'model-v', label: 'Generate videos',
      buildCount: (args: Record<string, unknown>) => (Array.isArray(args.items) ? args.items.length : undefined),
    },
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
  fetchAgentOrigin: vi.fn().mockResolvedValue('custom'),
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
  countThreadMessages: vi.fn().mockResolvedValue(0),
  embedder: {},
  resolvedDbHost: 'localhost',
  isNeonDb: false,
  dbUrl: new URL('postgresql://localhost/db'),
}))

vi.mock('../llm/quickCall.js', () => ({
  quickGeminiCall: vi.fn().mockResolvedValue('[]'),
}))

import { runChatStream, attachmentsFromToolResult, type ChatStreamOpts } from './chatStream.js'
import { pendingToolApprovals } from '../types.js'
import * as persistence from '../persistence.js'
import * as usage from '../usage.js'
import * as quickCall from '../llm/quickCall.js'

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

  it('plain cancel (no reason, nothing generated): replies instantly, then finishes the declined run in the background', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-ic', args: { prompt: 'x', aspectRatio: '16:9' } } }],
      'run-ic',
    ))
    let releaseDecline!: () => void
    declineToolCall.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDecline = () => resolve(fakeStream([{ type: 'finish', payload: { output: { usage: {} } } }], 'run-ic'))
    }))

    const sendEvent = vi.fn()
    const closeStream = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent, closeStream, message: 'generate an image of a tvc character', displayMessage: 'generate an image of a tvc character' }))

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-ic' }))
    )
    pendingToolApprovals.get('tc-ic')?.resolve({ confirmed: false })

    const notice = 'Cancelled: tvc character image (16:9). Nothing was generated. Want to change anything and try again?'
    // The user has their reply and `done` while the declined run is still unresolved.
    await vi.waitFor(() => expect(declineToolCall).toHaveBeenCalled())
    expect(sendEvent).toHaveBeenCalledWith('delta', expect.objectContaining({ text: notice }))
    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({ text: notice }))
    expect(sendEvent.mock.calls.find(([e]) => e === 'done')?.[1]).not.toHaveProperty('suggestedFollowUps')
    expect(closeStream).toHaveBeenCalled()
    expect(persistence.saveAssistantMessage).toHaveBeenCalledTimes(1)
    expect(declineToolCall.mock.calls[0][0].reason).toContain(notice)

    releaseDecline()
    await runPromise
    // The background finish must not persist a second copy of the turn.
    expect(persistence.saveAssistantMessage).toHaveBeenCalledTimes(1)
  })

  it('cancel after an approved generation in the same turn is mid-flow: no instant reply', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-m1', args: { prompt: 'x' } } }],
      'run-m',
    ))
    approveToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate_videos', toolCallId: 'tc-m2', args: { prompt: 'y' } } }],
      'run-m',
    ))
    declineToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-m',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))
    await vi.waitFor(() => expect(pendingToolApprovals.get('tc-m1')).toBeTruthy())
    pendingToolApprovals.get('tc-m1')?.resolve({ confirmed: true })
    await vi.waitFor(() => expect(pendingToolApprovals.get('tc-m2')).toBeTruthy())
    pendingToolApprovals.get('tc-m2')?.resolve({ confirmed: false })
    await runPromise

    expect(sendEvent).not.toHaveBeenCalledWith('delta', expect.objectContaining({ text: expect.stringContaining('Nothing was generated') }))
    expect(declineToolCall.mock.calls[0][0].reason).not.toContain('already been shown')
  })

  it('a thrown tool (tool-error) closes the row as failed instead of leaving it to read as success', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        { type: 'tool-call', payload: { toolName: 'generate-image', toolCallId: 'tc-err', args: {} } },
        { type: 'tool-error', payload: { toolName: 'generate-image', toolCallId: 'tc-err', error: new Error('boom') } },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-err',
    ))
    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))
    expect(sendEvent).toHaveBeenCalledWith('tool_done', expect.objectContaining({ toolCallId: 'tc-err', result: { failed: true } }))
  })

  it('sends done without waiting for follow-up chips, then the chips as a follow_ups event', async () => {
    let releaseChips!: () => void
    vi.mocked(quickCall.quickGeminiCall).mockImplementationOnce(() => new Promise((resolve) => {
      releaseChips = () => resolve('["One?", "Two?", "Three?"]')
    }))
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        { type: 'text-delta', payload: { text: 'Here is a long enough reply to qualify for follow-up suggestions.' } },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-fu',
    ))
    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledWith('done', expect.anything()))
    expect(sendEvent.mock.calls.find(([e]) => e === 'done')?.[1]).not.toHaveProperty('suggestedFollowUps')
    expect(sendEvent).not.toHaveBeenCalledWith('follow_ups', expect.anything())
    releaseChips()
    await runPromise
    expect(sendEvent).toHaveBeenCalledWith('follow_ups', expect.objectContaining({ suggestedFollowUps: ['One?', 'Two?', 'Three?'] }))
  })

  it('includes the item count on generation_confirm_request for a batch tool', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate_videos', toolCallId: 'tc-b1', args: { items: [{}, {}, {}] } } }],
      'run-b1',
    ))
    approveToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-b1',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({
        confirmationId: 'tc-b1', resourceType: 'video_generation', count: 3,
      }))
    )
    pendingToolApprovals.get('tc-b1')?.resolve({ confirmed: true })
    await runPromise
  })

  it('omits count on generation_confirm_request for a single-item tool', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-s1', args: { prompt: 'a cat' } } }],
      'run-s1',
    ))
    approveToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-s1',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent }))

    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-s1' }))
    )
    const payload = sendEvent.mock.calls.find((c) => c[0] === 'generation_confirm_request')![1]
    expect(payload).not.toHaveProperty('count')
    pendingToolApprovals.get('tc-s1')?.resolve({ confirmed: true })
    await runPromise
  })
})

describe('runChatStream — delegate-produced attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingToolApprovals.clear()
    agents.current = 'other'
  })

  it('unwraps a fileId from a delegate wrapper\'s subAgentToolResults into the done event\'s attachments', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-director-1',
            toolName: 'agent-director',
            result: {
              text: 'Here is Scene 1 of your video ad.',
              subAgentToolResults: [
                { toolName: 'retrieve_template', result: { templateId: 't1' } },
                { toolName: 'generate_video', result: { fileId: 'vid-1', name: 'clip.mp4', fileType: 'video/mp4', size: 2740710, creditsUsedMicro: '400000', model: 'gemini-omni-1.1-flash' } },
              ],
            },
          },
        },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-director-1',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({
      attachments: [
        expect.objectContaining({ fileId: 'vid-1', name: 'clip.mp4', type: 'video/mp4', size: 2740710, generation: { creditsUsedMicro: '400000', model: 'gemini-omni-1.1-flash' } }),
      ],
    }))
  })

  it('does not add an attachment when the delegate produced no fileId anywhere', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-director-2',
            toolName: 'agent-director',
            result: {
              text: 'The generation could not be started at this time.',
              subAgentToolResults: [
                { toolName: 'generate_video', result: { refused: true, refusalReason: 'GENERATION_FAILED' } },
              ],
            },
          },
        },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-director-2',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({ attachments: undefined }))
  })

  it('unwraps a fileId from a delegated generate_narration result into the done event\'s attachments', async () => {
    // These three tools (generate_narration/lipsync/assemble_clips) only ever
    // run via Director-as-delegate in production — never standalone Director —
    // so this exercises the same subAgentToolResults unwrap path as the
    // generate_video case above, for one of the new talking-head tools.
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-director-3',
            toolName: 'agent-director',
            result: {
              text: 'Here is the narration track.',
              subAgentToolResults: [
                { toolName: 'generate_narration', result: { fileId: 'narr-1', name: 'narration.wav', fileType: 'audio/wav', size: 481200, durationSeconds: 22, creditsUsedMicro: '30000' } },
              ],
            },
          },
        },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-director-3',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({
      attachments: [
        expect.objectContaining({ fileId: 'narr-1', name: 'narration.wav', type: 'audio/wav', size: 481200 }),
      ],
    }))
  })

  it('turns a batch tool-result into one attachment per succeeded item and none for failed items', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-batch-1',
            toolName: 'generate-videos',
            result: {
              results: [
                { index: 0, fileId: 'v-0', name: 'a.mp4', fileType: 'video/mp4', size: 10, creditsUsedMicro: '100000', model: 'google/gemini-omni-1.1-flash' },
                { index: 1, refused: true, refusalReason: 'GENERATION_FAILED' },
                { index: 2, fileId: 'v-2', name: 'c.mp4', fileType: 'video/mp4', size: 12 },
              ],
              succeeded: 2,
              failed: 1,
            },
          },
        },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-batch-1',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({
      attachments: [
        expect.objectContaining({ fileId: 'v-0', name: 'a.mp4', type: 'video/mp4', generation: { creditsUsedMicro: '100000', model: 'google/gemini-omni-1.1-flash' } }),
        expect.objectContaining({ fileId: 'v-2', name: 'c.mp4', type: 'video/mp4' }),
      ],
    }))
  })

  it('unwraps a batch result nested in a delegate wrapper (Olmo -> Director)', async () => {
    streamMock.mockResolvedValueOnce(fakeStream(
      [
        {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-director-b',
            toolName: 'agent-director',
            result: {
              text: 'Generated two stills.',
              subAgentToolResults: [
                { toolName: 'generate_images', result: { results: [
                  { index: 0, fileId: 'i-0', name: 'a.png', fileType: 'image/png', size: 5 },
                  { index: 1, fileId: 'i-1', name: 'b.png', fileType: 'image/png', size: 6 },
                ], succeeded: 2, failed: 0 } },
              ],
            },
          },
        },
        { type: 'finish', payload: { output: { usage: {} } } },
      ],
      'run-director-b',
    ))

    const sendEvent = vi.fn()
    await runChatStream(baseOpts({ sendEvent }))

    expect(sendEvent).toHaveBeenCalledWith('done', expect.objectContaining({
      attachments: [
        expect.objectContaining({ fileId: 'i-0' }),
        expect.objectContaining({ fileId: 'i-1' }),
      ],
    }))
  })
})

describe('attachmentsFromToolResult', () => {
  it('wraps a single-file result and returns [] for an unknown tool or a fileId-less result', () => {
    expect(attachmentsFromToolResult('generate-video', { fileId: 'f', name: 'n', fileType: 'video/mp4', size: 1 })).toHaveLength(1)
    expect(attachmentsFromToolResult('retrieve-template', { fileId: 'f' })).toEqual([])
    expect(attachmentsFromToolResult('generate-video', { refused: true })).toEqual([])
  })

  it('returns [] for a batch result with no results array', () => {
    expect(attachmentsFromToolResult('generate-videos', {})).toEqual([])
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

  // chatStream.ts builds `skillInvocationPrepareStep` from the number of
  // skills invoked this turn (mastra/skillInvocation.js's real
  // buildSkillInvocationPrepareStep — not mocked in this file) and only
  // spreads it into the *initial* .stream() call options. A resumed run
  // rebuilds its tools/steps from whatever options it's given, so carrying
  // prepareStep into approveToolCall/declineToolCall would force the
  // just-invoked skill's tool again on every resumed step, not just the
  // turn's first N. This is test-only per the brief: the production code
  // (chatStream.ts ~395/458/524-525) already omits it from both resumes.
  it('passes prepareStep only on the initial stream when a "/" pick resolves, and approveToolCall never sees it', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [], ok: true,
    })
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(PICKED.skillId) ? [PICKED] : [])

    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-skill-approve', args: { prompt: 'x' } } }],
      'run-skill-12',
    ))
    approveToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-skill-12',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent, skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-skill-approve' }))
    )
    pendingToolApprovals.get('tc-skill-approve')?.resolve({ confirmed: true })
    await runPromise

    const initialStreamOptions = streamMock.mock.calls[0][1]
    expect(typeof initialStreamOptions.prepareStep).toBe('function')

    expect(approveToolCall).toHaveBeenCalledTimes(1)
    expect(approveToolCall.mock.calls[0][0]).not.toHaveProperty('prepareStep')
    expect(declineToolCall).not.toHaveBeenCalled()
  })

  it('passes prepareStep only on the initial stream when a "/" pick resolves, and declineToolCall never sees it', async () => {
    vi.mocked(persistence.fetchConversationSkillSettings).mockResolvedValue({
      testSkillInstallId: null, invokedSkills: [], ok: true,
    })
    vi.mocked(usage.resolveInvokedSkills).mockImplementation(async (ids: string[]) =>
      ids.includes(PICKED.skillId) ? [PICKED] : [])

    streamMock.mockResolvedValueOnce(fakeStream(
      [{ type: 'tool-call-approval', payload: { toolName: 'generate-image', toolCallId: 'tc-skill-decline', args: { prompt: 'x' } } }],
      'run-skill-13',
    ))
    declineToolCall.mockResolvedValueOnce(fakeStream(
      [{ type: 'finish', payload: { output: { usage: {} } } }],
      'run-skill-13',
    ))

    const sendEvent = vi.fn()
    const runPromise = runChatStream(baseOpts({ sendEvent, skillsUsed: [{ id: PICKED.skillId, name: PICKED.name }] }))
    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({ confirmationId: 'tc-skill-decline' }))
    )
    pendingToolApprovals.get('tc-skill-decline')?.resolve({ confirmed: false, declineReason: 'nope' })
    await runPromise

    const initialStreamOptions = streamMock.mock.calls[0][1]
    expect(typeof initialStreamOptions.prepareStep).toBe('function')

    expect(declineToolCall).toHaveBeenCalledTimes(1)
    expect(declineToolCall.mock.calls[0][0]).not.toHaveProperty('prepareStep')
    expect(approveToolCall).not.toHaveBeenCalled()
  })
})

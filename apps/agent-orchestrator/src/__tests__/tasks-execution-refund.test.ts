import { describe, it, expect, vi, beforeEach } from 'vitest'

// This suite targets ONE thing: that runMastraTaskSteps refunds the estimate
// it charged at the top of the function whenever the run ends WITHOUT the
// success path running — the ordinary "the workflow returned status: 'failed'"
// shape, not just a thrown exception. Before this fix, `earlyTermination` was
// set by onStepFail/onTaskComment/either workflow's non-success branch, but
// the settle-or-refund decision only ever checked `if (!earlyTermination)` —
// there was no else, so a charged-and-never-refunded estimate was the
// outcome for all four of those paths. See tasks.execution.ts.
//
// Every heavy dependency is mocked, INCLUDING '../mastra/index.js' — that
// module transitively pulls in the whole Mastra agent graph
// (platformAgent.ts -> platform-capabilities.ts ->
// @serverless-saas/agent-capabilities), which has no built dist/ in this
// worktree and fails module resolution (the same pre-existing failure
// documented for tasks-execute.test.ts). Mocking it here means that chain is
// never loaded at all.

const chargeTaskEstimate = vi.fn().mockResolvedValue(undefined)
const refundTask = vi.fn().mockResolvedValue(undefined)
const settleTask = vi.fn().mockResolvedValue(undefined)
const estimateTaskMicro = vi.fn().mockResolvedValue(0n)
const resolveTaskRate = vi.fn().mockResolvedValue(null)

vi.mock('../credits.js', () => ({
  chargeTaskEstimate,
  refundTask,
  settleTask,
  estimateTaskMicro,
  resolveTaskRate,
  DEFAULT_TASK_MODEL: 'gemini-2.5-flash',
}))

vi.mock('../usage.js', () => ({
  fetchAgentSkill: vi.fn().mockResolvedValue({ systemPrompt: 'be helpful', tools: null }),
  fetchAgentModelSelection: vi.fn().mockResolvedValue(null),
  fetchConnectedProviders: vi.fn().mockResolvedValue([]),
  fetchToolGovernance: vi.fn().mockResolvedValue({ requiresApprovalTools: [], highStakeTools: [] }),
  fetchAgentPolicy: vi.fn().mockResolvedValue({
    allowedActions: [], blockedActions: [], requiresApproval: [],
    maxTokensPerMessage: null, maxMessagesPerConversation: null,
  }),
  recordUsage: vi.fn(),
}))

const callInternalTaskApi = vi.fn().mockResolvedValue(undefined)
const postTaskEval = vi.fn().mockResolvedValue(undefined)
const logToolCall = vi.fn().mockResolvedValue(undefined)
const postTaskComment = vi.fn().mockResolvedValue(undefined)

vi.mock('./tasks.helpers.js', () => ({
  callInternalTaskApi, postTaskEval, logToolCall, postTaskComment,
}))

// Each test sets this to control what the (mocked) workflow run resolves to.
let executionRunResult: unknown = { status: 'success', result: { inputTokens: 10, outputTokens: 5, summary: 'ok', status: 'done' } }
let documentRunResult: unknown = { status: 'success', result: { inputTokens: 10, outputTokens: 5, summary: 'ok', dodPassed: true, prdData: {} } }

vi.mock('../mastra/index.js', () => ({
  taskExecutionWorkflow: {
    createRun: vi.fn().mockImplementation(async () => ({
      runId: 'run-1',
      start: vi.fn().mockImplementation(async () => executionRunResult),
    })),
  },
  documentWorkflow: {
    createRun: vi.fn().mockImplementation(async () => ({
      start: vi.fn().mockImplementation(async () => documentRunResult),
    })),
  },
}))

const STEPS = [
  { id: 'step-1', stepOrder: 1, title: 'Step 1', description: 'first', toolName: 'web_search', parameters: {} },
  { id: 'step-2', stepOrder: 2, title: 'Step 2', description: 'second', toolName: 'web_search', parameters: {} },
]

describe('runMastraTaskSteps — refund on non-throwing failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    executionRunResult = { status: 'success', result: { inputTokens: 10, outputTokens: 5, summary: 'ok', status: 'done' } }
    documentRunResult = { status: 'success', result: { inputTokens: 10, outputTokens: 5, summary: 'ok', dodPassed: true, prdData: {} } }
  })

  it('refunds when the execution workflow resolves with status !== "success" (no throw)', async () => {
    executionRunResult = { status: 'failed', error: { message: 'workflow blew up' } }
    const { runMastraTaskSteps } = await import('../routes/tasks.execution.js')

    await runMastraTaskSteps(
      'task-1', 'agent-1', 'tenant-1', STEPS, 'Title', 'Desc', 'Agent',
      null, ['https://example.com'], null, null, 'trace-1',
    )

    expect(refundTask).toHaveBeenCalledTimes(1)
    expect(refundTask).toHaveBeenCalledWith({ tenantId: 'tenant-1', taskId: 'task-1' })
    expect(settleTask).not.toHaveBeenCalled()
  })

  it('does NOT refund when the execution workflow succeeds', async () => {
    const { runMastraTaskSteps } = await import('../routes/tasks.execution.js')

    await runMastraTaskSteps(
      'task-2', 'agent-1', 'tenant-1', STEPS, 'Title', 'Desc', 'Agent',
      null, ['https://example.com'], null, null, 'trace-2',
    )

    expect(refundTask).not.toHaveBeenCalled()
    expect(settleTask).toHaveBeenCalledTimes(1)
  })

  it('refunds when the document workflow resolves with status !== "success" (no throw) — attachmentContext set, no links', async () => {
    documentRunResult = { status: 'failed', error: { message: 'doc workflow blew up' } }
    const { runMastraTaskSteps } = await import('../routes/tasks.execution.js')

    await runMastraTaskSteps(
      'task-3', 'agent-1', 'tenant-1', STEPS, 'Title', 'Desc', 'Agent',
      null, null, 'some PRD text', null, 'trace-3',
    )

    expect(refundTask).toHaveBeenCalledTimes(1)
    expect(refundTask).toHaveBeenCalledWith({ tenantId: 'tenant-1', taskId: 'task-3' })
    expect(settleTask).not.toHaveBeenCalled()
  })

  it('does NOT refund when the document workflow succeeds', async () => {
    const { runMastraTaskSteps } = await import('../routes/tasks.execution.js')

    await runMastraTaskSteps(
      'task-4', 'agent-1', 'tenant-1', STEPS, 'Title', 'Desc', 'Agent',
      null, null, 'some PRD text', null, 'trace-4',
    )

    expect(refundTask).not.toHaveBeenCalled()
    expect(settleTask).toHaveBeenCalledTimes(1)
  })
})

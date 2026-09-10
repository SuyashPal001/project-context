import { describe, it, expect, vi, beforeEach } from 'vitest'

const refundTask = vi.fn().mockResolvedValue(undefined)
const settleTask = vi.fn().mockResolvedValue(undefined)

vi.mock('../credits.js', () => ({
  refundTask, settleTask, DEFAULT_TASK_MODEL: 'gemini-2.5-flash',
}))
vi.mock('../usage.js', () => ({
  fetchConnectedProviders: vi.fn().mockResolvedValue([]),
  fetchToolGovernance: vi.fn().mockResolvedValue({ requiresApprovalTools: [], highStakeTools: [] }),
  fetchAgentPolicy: vi.fn().mockResolvedValue({
    allowedActions: [], blockedActions: [], requiresApproval: [], maxTokensPerMessage: null,
  }),
}))
vi.mock('../types.js', () => ({ INTERNAL_SERVICE_KEY: 'k', INTERNAL_API_URL: 'http://api.test' }))

let runResult: unknown = { status: 'success', result: [] }
const createRun = vi.fn().mockResolvedValue({
  runId: 'mastra-run-1',
  start: vi.fn(() => Promise.resolve(runResult)),
})
vi.mock('../mastra/index.js', () => ({
  mastra: { getWorkflow: vi.fn(() => ({ createRun })) },
}))

const STEPS = [
  { id: 'step-1', stepNumber: 1, title: 'Step 1', description: 'first', toolName: null },
  { id: 'step-2', stepNumber: 2, title: 'Step 2', description: 'second', toolName: null },
]

describe('runMastraWorkflowSteps — settle on success', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
  })

  it('settles the estimate against the summed per-step token usage', async () => {
    runResult = {
      status: 'success',
      result: [
        { stepId: 'step-1', status: 'done', summary: 'a', inputTokens: 120, outputTokens: 30 },
        { stepId: 'step-2', status: 'done', summary: 'b', inputTokens: 80, outputTokens: 20 },
      ],
    }
    const { runMastraWorkflowSteps } = await import('../routes/tasks.workflow.js')
    await runMastraWorkflowSteps('wf-1', 'run-1', 'agent-1', 'tenant-1', STEPS as never, null, false, 'trace-1', 'gemini-2.5-pro')

    expect(refundTask).not.toHaveBeenCalled()
    expect(settleTask).toHaveBeenCalledTimes(1)
    expect(settleTask).toHaveBeenCalledWith({
      tenantId: 'tenant-1', taskId: 'run-1', agentId: 'agent-1', model: 'gemini-2.5-pro',
      inputTokens: 200, outputTokens: 50,
    })
  })

  it('refunds and does not settle when a step fails', async () => {
    runResult = {
      status: 'success',
      result: [
        { stepId: 'step-1', status: 'done', summary: 'a', inputTokens: 120, outputTokens: 30 },
        { stepId: 'step-2', status: 'failed', summary: 'tool exploded' },
      ],
    }
    const { runMastraWorkflowSteps } = await import('../routes/tasks.workflow.js')
    await runMastraWorkflowSteps('wf-1', 'run-2', 'agent-1', 'tenant-1', STEPS as never, null, false, 'trace-2', 'gemini-2.5-pro')

    expect(settleTask).not.toHaveBeenCalled()
    expect(refundTask).toHaveBeenCalledWith({ tenantId: 'tenant-1', taskId: 'run-2' })
  })

  it('settles at zero when the run reports no usage, rather than skipping', async () => {
    runResult = { status: 'success', result: [{ stepId: 'step-1', status: 'done', summary: 'a' }] }
    const { runMastraWorkflowSteps } = await import('../routes/tasks.workflow.js')
    await runMastraWorkflowSteps('wf-1', 'run-3', 'agent-1', 'tenant-1', STEPS as never, null, false, 'trace-3', 'gemini-2.5-pro')

    expect(settleTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'run-3', inputTokens: 0, outputTokens: 0 }))
  })

  it('marks awaiting_approval and persists the pending-approval descriptor when the run suspends', async () => {
    runResult = {
      status: 'suspended',
      suspendPayload: { 'run-plan-step': { stepId: 'step-2', title: 'Step 2', toolName: 'x', reason: 'requires_approval' } },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const { runMastraWorkflowSteps } = await import('../routes/tasks.workflow.js')
    await runMastraWorkflowSteps('wf-1', 'run-4', 'agent-1', 'tenant-1', STEPS as never, null, false, 'trace-4', 'gemini-2.5-pro')

    expect(settleTask).not.toHaveBeenCalled()
    expect(refundTask).not.toHaveBeenCalled()

    const fetchMock = vi.mocked(fetch)
    const updateCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/update'))
    const updateCall = updateCalls[updateCalls.length - 1]
    expect(updateCall).toBeDefined()
    const body = JSON.parse((updateCall![1] as RequestInit).body as string)
    expect(body).toMatchObject({
      status: 'awaiting_approval',
      pendingApproval: { stepId: 'step-2', title: 'Step 2', toolName: 'x', reason: 'requires_approval', resumeLabel: 'approve:step-2' },
    })
  })
})

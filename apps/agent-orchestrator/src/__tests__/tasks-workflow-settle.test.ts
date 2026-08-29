import { describe, it, expect, vi, beforeEach } from 'vitest'

// A SUCCESSFUL /api/workflows/execute run must be reconciled to the tokens it
// actually spent, not left charged at the up-front estimate forever.
//
// runMastraWorkflow already reported per-step usage on the onStepComplete
// payload — it sums both generate passes into inputTokens/outputTokens — but
// this flow simply never read it, and had no settle step at all. The only
// reconciliation was a refund on failure, so every workflow that WORKED was
// billed the estimate regardless of cost, unlike an equivalent task run.
//
// The mocks stand in for the real Mastra graph, which pulls in the whole agent
// tree and has no built dist/ in this worktree — the same pre-existing module
// resolution failure documented for tasks-execute.test.ts.

const refundTask = vi.fn().mockResolvedValue(undefined)
const settleTask = vi.fn().mockResolvedValue(undefined)

vi.mock('../credits.js', () => ({
  refundTask,
  settleTask,
  DEFAULT_TASK_MODEL: 'gemini-2.5-flash',
}))

vi.mock('../usage.js', () => ({
  fetchAgentSkill: vi.fn().mockResolvedValue({ systemPrompt: 'be helpful', tools: null }),
  fetchConnectedProviders: vi.fn().mockResolvedValue([]),
  fetchToolGovernance: vi.fn().mockResolvedValue({ requiresApprovalTools: [], highStakeTools: [] }),
  fetchAgentPolicy: vi.fn().mockResolvedValue({
    allowedActions: [], blockedActions: [], requiresApproval: [],
    maxTokensPerMessage: null, maxMessagesPerConversation: null,
  }),
}))

vi.mock('../types.js', () => ({
  INTERNAL_SERVICE_KEY: 'k',
  INTERNAL_API_URL: 'http://api.test',
}))

// Drives what the (mocked) workflow engine does to the context it is handed.
let driveWorkflow: (ctx: Record<string, any>) => Promise<void> = async () => {}

vi.mock('../mastra/index.js', () => ({
  runMastraWorkflow: vi.fn().mockImplementation(async (ctx: Record<string, any>) => driveWorkflow(ctx)),
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
    driveWorkflow = async (ctx) => {
      await ctx.onStepComplete('step-1', { stepId: 'step-1', status: 'done', summary: 'a', inputTokens: 120, outputTokens: 30 })
      await ctx.onStepComplete('step-2', { stepId: 'step-2', status: 'done', summary: 'b', inputTokens: 80, outputTokens: 20 })
    }

    const { runMastraWorkflowSteps } = await import('../routes/tasks.workflow.js')
    await runMastraWorkflowSteps('wf-1', 'run-1', 'agent-1', 'tenant-1', STEPS as never, null, false, 'trace-1', 'gemini-2.5-pro')

    expect(refundTask).not.toHaveBeenCalled()
    expect(settleTask).toHaveBeenCalledTimes(1)
    expect(settleTask).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      // The estimate at /api/workflows/execute is charged with taskId =
      // workflowRunId and no explicit key, so settleTask's own defaults
      // (`task:{id}` / `task:{id}:settle`) land on that exact charge. Passing
      // the workflow id here instead would settle against nothing.
      taskId: 'run-1',
      agentId: 'agent-1',
      model: 'gemini-2.5-pro',
      inputTokens: 200,
      outputTokens: 50,
    })
  })

  it('refunds and does not settle when a step fails', async () => {
    driveWorkflow = async (ctx) => {
      await ctx.onStepComplete('step-1', { stepId: 'step-1', status: 'done', summary: 'a', inputTokens: 120, outputTokens: 30 })
      await ctx.onStepFail('step-2', 'tool exploded')
    }

    const { runMastraWorkflowSteps } = await import('../routes/tasks.workflow.js')
    await runMastraWorkflowSteps('wf-1', 'run-2', 'agent-1', 'tenant-1', STEPS as never, null, false, 'trace-2', 'gemini-2.5-pro')

    // A failed run is refunded in full — settling it would reconcile a charge
    // that is about to be handed back, and refundTask's settled-row guard
    // would then skip the refund entirely.
    expect(settleTask).not.toHaveBeenCalled()
    expect(refundTask).toHaveBeenCalledWith({ tenantId: 'tenant-1', taskId: 'run-2' })
  })

  it('settles at zero when the run reports no usage, rather than skipping', async () => {
    // A workflow whose steps report no token counts still had an estimate
    // charged. Skipping the settle would silently make the estimate final —
    // the exact behaviour this fix removes.
    driveWorkflow = async (ctx) => {
      await ctx.onStepComplete('step-1', { stepId: 'step-1', status: 'done', summary: 'a' })
    }

    const { runMastraWorkflowSteps } = await import('../routes/tasks.workflow.js')
    await runMastraWorkflowSteps('wf-1', 'run-3', 'agent-1', 'tenant-1', STEPS as never, null, false, 'trace-3', 'gemini-2.5-pro')

    expect(settleTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'run-3', inputTokens: 0, outputTokens: 0,
    }))
  })
})

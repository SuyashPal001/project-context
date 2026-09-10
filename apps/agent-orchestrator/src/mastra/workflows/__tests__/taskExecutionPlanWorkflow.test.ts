import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { Mastra } from '@mastra/core/mastra'
import { InMemoryStore } from '@mastra/core/storage'
import type { TenantContext } from '../../context.js'

vi.mock('../../index.js', () => ({
  platformAgent: { generate: vi.fn() },
  formatterAgent: { generate: vi.fn() },
}))

import { taskExecutionPlanWorkflow } from '../taskExecutionPlanWorkflow.js'
import { platformAgent, formatterAgent } from '../../index.js'

// Suspend/resume round trips require a real workflows store — `run.resume()`
// loads its suspended snapshot from `mastra.getStorage()`, which is undefined
// for a workflow created via `.createRun()` with no Mastra instance attached
// (fine for the single-shot `start()`-only tests above, not for resume).
function createResumableRun() {
  const testMastra = new Mastra({
    workflows: { 'task-execution-plan': taskExecutionPlanWorkflow },
    storage: new InMemoryStore(),
  })
  return testMastra.getWorkflow('task-execution-plan').createRun()
}

const baseInput = {
  taskId: 't1', taskTitle: 'Test task', instructions: 'be helpful',
  steps: [{ stepId: 's1', stepNumber: 1, title: 'Step 1', toolName: 'blocked_tool' }],
  highStakeTools: [], requiresApprovalTools: [], blockedTools: ['blocked_tool'], allowedTools: [],
  maxTokensPerMessage: null, attachmentContext: null, acceptanceCriteria: null,
}

function makeRequestContext(tenantId: string) {
  const ctx = new RequestContext<TenantContext>()
  ctx.set('tenantId', tenantId)
  return ctx
}

describe('taskExecutionPlanWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails a blocked-tool step without calling the agent', async () => {
    const run = await taskExecutionPlanWorkflow.createRun()
    const result = await run.start({ inputData: baseInput, requestContext: makeRequestContext('t1') })
    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.result[0]).toMatchObject({ stepId: 's1', status: 'failed' })
      expect(result.result[0].summary).toContain('blocked by agent policy')
    }
  })

  it('suspends a requires-approval step instead of failing or running it', async () => {
    const run = await taskExecutionPlanWorkflow.createRun()
    const result = await run.start({
      inputData: { ...baseInput, blockedTools: [], requiresApprovalTools: ['blocked_tool'] },
      requestContext: makeRequestContext('t1'),
    })
    expect(result.status).toBe('suspended')
  })

  it('resumes an approved step and runs it through to a real agent-call success', async () => {
    vi.mocked(platformAgent.generate).mockResolvedValue({
      text: 'did the thing', totalUsage: { inputTokens: 100, outputTokens: 40 },
    } as never)
    vi.mocked(formatterAgent.generate).mockResolvedValue({
      object: { status: 'done', summary: 'Completed the step successfully.' },
      totalUsage: { inputTokens: 10, outputTokens: 5 },
    } as never)

    const run = await createResumableRun()
    const suspendedResult = await run.start({
      inputData: { ...baseInput, blockedTools: [], requiresApprovalTools: ['blocked_tool'] },
      requestContext: makeRequestContext('t1'),
    })
    expect(suspendedResult.status).toBe('suspended')

    const result = await run.resume({
      step: 'run-plan-step',
      resumeData: { approved: true },
      requestContext: makeRequestContext('t1'),
    })

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.result[0]).toMatchObject({ stepId: 's1', status: 'done' })
    }
  })

  it('resumes a declined step as a failed step result, without calling the agent', async () => {
    const run = await createResumableRun()
    const suspendedResult = await run.start({
      inputData: { ...baseInput, blockedTools: [], requiresApprovalTools: ['blocked_tool'] },
      requestContext: makeRequestContext('t1'),
    })
    expect(suspendedResult.status).toBe('suspended')

    const result = await run.resume({
      step: 'run-plan-step',
      resumeData: { approved: false },
      requestContext: makeRequestContext('t1'),
    })

    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.result[0]).toMatchObject({ stepId: 's1', status: 'failed' })
      expect(result.result[0].summary).toContain('declined')
    }
    expect(platformAgent.generate).not.toHaveBeenCalled()
  })

  it("threads a completed step's summary into the next step's prompt", async () => {
    const generateSpy = vi.mocked(platformAgent.generate)
    generateSpy.mockResolvedValueOnce({ text: 'first step output', totalUsage: { inputTokens: 10, outputTokens: 5 } } as never)
    vi.mocked(formatterAgent.generate).mockResolvedValueOnce({ object: { status: 'done', summary: 'Wrote the intro section' } } as never)
    generateSpy.mockResolvedValueOnce({ text: 'second step output', totalUsage: { inputTokens: 10, outputTokens: 5 } } as never)
    vi.mocked(formatterAgent.generate).mockResolvedValueOnce({ object: { status: 'done', summary: 'Wrote the conclusion' } } as never)

    const run = await createResumableRun()
    await run.start({
      inputData: {
        ...baseInput,
        steps: [
          { stepId: 's1', stepNumber: 1, title: 'Write intro' },
          { stepId: 's2', stepNumber: 2, title: 'Write conclusion' },
        ],
        blockedTools: [], requiresApprovalTools: [],
      },
      requestContext: makeRequestContext('t1'),
    })

    const secondCallPrompt = generateSpy.mock.calls[1][0] as string
    expect(secondCallPrompt).toContain('Previously Completed Steps')
    expect(secondCallPrompt).toContain('Wrote the intro section')
  })

  it('stops at the next step without calling the agent when the current step is declined', async () => {
    const run = await createResumableRun()
    const started = await run.start({
      inputData: {
        ...baseInput,
        steps: [
          { stepId: 's1', stepNumber: 1, title: 'Step 1', toolName: 'blocked_tool' },
          { stepId: 's2', stepNumber: 2, title: 'Step 2' },
        ],
        blockedTools: [], requiresApprovalTools: ['blocked_tool'],
      },
      requestContext: makeRequestContext('t1'),
    })
    expect(started.status).toBe('suspended')

    const generateSpy = vi.mocked(platformAgent.generate)
    generateSpy.mockClear()

    const resumed = await run.resume({ label: 'approve:s1', resumeData: { approved: false } })
    expect(resumed.status).toBe('success')
    if (resumed.status === 'success') {
      expect(resumed.result[0].status).toBe('failed')
      expect(resumed.result[1].status).toBe('failed')
      expect(resumed.result[1].summary).toContain('earlier tool call was declined')
    }
    expect(generateSpy).not.toHaveBeenCalled()
  })
})

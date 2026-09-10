import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'

vi.mock('../../index.js', () => ({
  platformAgent: { generate: vi.fn() },
  formatterAgent: { generate: vi.fn() },
}))

import { taskExecutionPlanWorkflow } from '../taskExecutionPlanWorkflow.js'

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
})

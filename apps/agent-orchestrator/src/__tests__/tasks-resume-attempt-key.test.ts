import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Regression for the HIGH finding on the re-review: /api/tasks/:taskId/resume
// (the Mastra suspend/approve/resume path — a task suspends for approval at
// tasks.execution.ts's `status === 'suspended'` branch, a human approves via
// PUT /tasks/:taskId/workflow/approve, which POSTs here) called
// refundTask/settleTask with NO chargeKey at all, defaulting to the
// unsuffixed task:{taskId} key. For any task at attempt >= 1 that default no
// longer matches the key the run was actually charged under
// (task:{taskId}:attempt:{n}), so resume's settle/refund silently miss the
// real charge — either leaving a terminal failure fully charged with no
// refund (clarified during planning, so no debit exists under task:{taskId}
// at all), or settling/crediting against a dead, already-refunded estimate
// while the real attempt-n charge is never reconciled (clarified
// mid-execution).
//
// Every heavy dependency is mocked, INCLUDING '../mastra/index.js' — see
// tasks-execute-attempt-key.test.ts for why (the unbuilt
// @serverless-saas/agent-capabilities collection failure).

vi.hoisted(() => {
  process.env.INTERNAL_SERVICE_KEY = 'test-key'
})

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
  taskChargeKey: (taskId: string, attempt: number) => attempt > 0 ? `task:${taskId}:attempt:${attempt}` : `task:${taskId}`,
}))

// The resume handler looks up agent_tasks and task_steps via a raw pg pool
// (getPool()), not Drizzle — distinguish the two queries by substring.
const poolQuery = vi.fn().mockImplementation((sqlText: string) => {
  if (String(sqlText).includes('FROM agent_tasks')) {
    return Promise.resolve({ rows: [{ mastra_run_id: 'run-1', tenant_id: 'tenant-1', agent_id: 'agent-1' }] })
  }
  if (String(sqlText).includes('FROM task_steps')) {
    return Promise.resolve({ rows: [] }) // no running steps — keeps the success path's completion loop a no-op
  }
  return Promise.resolve({ rows: [] })
})

vi.mock('../usage.js', () => ({
  fetchAgentModelSelection: vi.fn().mockResolvedValue(null),
  getPool: () => ({ query: poolQuery }),
  recordUsage: vi.fn(),
  fetchAgentSkill: vi.fn().mockResolvedValue({ systemPrompt: 'be helpful', tools: null }),
  fetchConnectedProviders: vi.fn().mockResolvedValue([]),
  fetchToolGovernance: vi.fn().mockResolvedValue({ requiresApprovalTools: [], highStakeTools: [] }),
  fetchAgentPolicy: vi.fn().mockResolvedValue({
    allowedActions: [], blockedActions: [], requiresApproval: [],
    maxTokensPerMessage: null, maxMessagesPerConversation: null,
  }),
}))

vi.mock('../pii-filter.js', () => ({
  filterPII: vi.fn().mockImplementation((text: string) => ({ sanitized: text, detections: [] })),
}))

vi.mock('../routes/tasks.helpers.js', () => ({
  callInternalTaskApi: vi.fn().mockResolvedValue(undefined),
  postTaskEval: vi.fn().mockResolvedValue(undefined),
  logToolCall: vi.fn().mockResolvedValue(undefined),
  postTaskComment: vi.fn().mockResolvedValue(undefined),
  fetchTaskComments: vi.fn(),
  fetchTenantMcpServers: vi.fn(),
}))

vi.mock('../routes/tasks.prompt.js', () => ({
  buildStepPrompt: vi.fn(),
  extractClarificationQuestion: vi.fn(),
}))

vi.mock('../routes/tasks.workflow.js', () => ({ runMastraWorkflowSteps: vi.fn() }))

vi.mock('../mastra/index.js', () => ({
  taskExecutionWorkflow: { createRun: vi.fn() },
  documentWorkflow: { createRun: vi.fn() },
  runMastraWorkflow: vi.fn(),
}))

function requestBody(attempt: number) {
  return JSON.stringify({ attempt })
}

describe('POST /api/tasks/:taskId/resume — per-attempt charge key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    poolQuery.mockImplementation((sqlText: string) => {
      if (String(sqlText).includes('FROM agent_tasks')) {
        return Promise.resolve({ rows: [{ mastra_run_id: 'run-1', tenant_id: 'tenant-1', agent_id: 'agent-1' }] })
      }
      if (String(sqlText).includes('FROM task_steps')) {
        return Promise.resolve({ rows: [] })
      }
      return Promise.resolve({ rows: [] })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('refunds under the attempt-scoped key when the resume trigger itself fails (no polling involved)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    const { tasksRouter } = await import('../routes/tasks.js')

    const res = await tasksRouter.request('/api/tasks/task-resume-1/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': 'test-key' },
      body: requestBody(1),
    })

    expect(res.status).toBe(500)
    expect(refundTask).toHaveBeenCalledTimes(1)
    expect(refundTask).toHaveBeenCalledWith({ tenantId: 'tenant-1', taskId: 'task-resume-1', chargeKey: 'task:task-resume-1:attempt:1' })
    expect(settleTask).not.toHaveBeenCalled()
  })

  it('attempt 0 (never clarified) resumes and refunds under the original unsuffixed key — unchanged for the common case', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    const { tasksRouter } = await import('../routes/tasks.js')

    await tasksRouter.request('/api/tasks/task-resume-2/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': 'test-key' },
      body: requestBody(0),
    })

    expect(refundTask).toHaveBeenCalledWith({ tenantId: 'tenant-1', taskId: 'task-resume-2', chargeKey: 'task:task-resume-2' })
  })

  it('settles under the attempt-scoped key on a successful resume (polling loop, fake timers)', async () => {
    vi.useFakeTimers()
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/resume?runId=')) {
        return Promise.resolve({ ok: true, status: 200, text: async () => '' })
      }
      if (u.includes('/runs/')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ status: 'success', result: { inputTokens: 10, outputTokens: 5, summary: 'ok' } }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
    })
    vi.stubGlobal('fetch', mockFetch)

    const { tasksRouter } = await import('../routes/tasks.js')
    const reqPromise = tasksRouter.request('/api/tasks/task-resume-3/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': 'test-key' },
      body: requestBody(1),
    })

    // The poll loop awaits one 10s setTimeout before its first check, which
    // returns 'success' immediately — advance exactly that much.
    await vi.advanceTimersByTimeAsync(10_000)
    const res = await reqPromise

    expect(res.status).toBe(200)
    expect(settleTask).toHaveBeenCalledTimes(1)
    const call = settleTask.mock.calls[0][0]
    expect(call.tenantId).toBe('tenant-1')
    expect(call.taskId).toBe('task-resume-3')
    expect(call.chargeKey).toBe('task:task-resume-3:attempt:1')
    expect(refundTask).not.toHaveBeenCalled()
  })
})

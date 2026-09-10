import { describe, it, expect, vi, beforeEach } from 'vitest'

// POST /api/workflows/:workflowRunId/resume — the native Mastra
// suspend/resume path for `task-execution-plan` runs, mirroring the
// mocking convention established in
// ../../__tests__/tasks-resume-attempt-key.test.ts for a Hono route backed
// by a mocked raw pg pool (getPool()) plus mocked credits/mastra modules.

vi.hoisted(() => {
  process.env.INTERNAL_SERVICE_KEY = 'test-key'
})

const refundTask = vi.fn().mockResolvedValue(undefined)
const settleTask = vi.fn().mockResolvedValue(undefined)

vi.mock('../../credits.js', () => ({
  refundTask,
  settleTask,
  chargeTaskEstimate: vi.fn(),
  estimateTaskMicro: vi.fn().mockResolvedValue(0n),
  resolveTaskRate: vi.fn().mockResolvedValue(null),
  DEFAULT_TASK_MODEL: 'gemini-2.5-flash',
  taskChargeKey: (taskId: string, attempt: number) => attempt > 0 ? `task:${taskId}:attempt:${attempt}` : `task:${taskId}`,
}))

// The resume handler looks up agent_workflow_runs via a raw pg pool
// (getPool()), not Drizzle — distinguish by substring like the sibling
// task-resume test does.
const poolQuery = vi.fn()
vi.mock('../../usage.js', () => ({
  fetchAgentModelSelection: vi.fn().mockResolvedValue(null),
  getPool: () => ({ query: poolQuery }),
  recordUsage: vi.fn(),
  fetchConnectedProviders: vi.fn().mockResolvedValue([]),
  fetchToolGovernance: vi.fn().mockResolvedValue({ requiresApprovalTools: [], highStakeTools: [] }),
  fetchAgentPolicy: vi.fn().mockResolvedValue({
    allowedActions: [], blockedActions: [], requiresApproval: [], maxTokensPerMessage: null,
  }),
}))

vi.mock('../../pii-filter.js', () => ({
  filterPII: vi.fn().mockImplementation((text: string) => ({ sanitized: text, detections: [] })),
}))

vi.mock('../tasks.helpers.js', () => ({
  callInternalTaskApi: vi.fn().mockResolvedValue(undefined),
  postTaskEval: vi.fn().mockResolvedValue(undefined),
  logToolCall: vi.fn().mockResolvedValue(undefined),
  postTaskComment: vi.fn().mockResolvedValue(undefined),
  fetchTaskComments: vi.fn(),
  fetchTenantMcpServers: vi.fn(),
}))

vi.mock('../tasks.prompt.js', () => ({
  buildStepPrompt: vi.fn(),
  extractClarificationQuestion: vi.fn(),
}))

const isRunOwnedByTenant = vi.fn()
vi.mock('../run-ownership.js', () => ({ isRunOwnedByTenant }))

const resume = vi.fn()
const createRun = vi.fn().mockResolvedValue({ runId: 'mastra-run-1', resume })
const getWorkflow = vi.fn(() => ({ createRun }))
const getStorage = vi.fn(() => ({}))
vi.mock('../../mastra/index.js', () => ({
  mastra: { getWorkflow, getStorage },
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))

function requestBody(body: Record<string, unknown>) {
  return JSON.stringify(body)
}

async function post(workflowRunId: string, body: Record<string, unknown>, headers: Record<string, string> = { 'x-internal-service-key': 'test-key' }) {
  const { tasksRouter } = await import('../tasks.js')
  return tasksRouter.request(`/api/workflows/${workflowRunId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: requestBody(body),
  })
}

describe('POST /api/workflows/:workflowRunId/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isRunOwnedByTenant.mockResolvedValue(true)
    poolQuery.mockResolvedValue({ rows: [{ mastra_run_id: 'mastra-run-1', agent_id: 'agent-1' }] })
    resume.mockResolvedValue({ status: 'suspended' })
  })

  it('rejects without the internal service key', async () => {
    const res = await post('wf-run-1', { tenantId: 'tenant-1' }, {})
    expect(res.status).toBe(401)
    expect(poolQuery).not.toHaveBeenCalled()
  })

  it('404s when the run has no mastra_run_id', async () => {
    poolQuery.mockResolvedValue({ rows: [{ mastra_run_id: null, agent_id: 'agent-1' }] })
    const res = await post('wf-run-2', { tenantId: 'tenant-1' })
    expect(res.status).toBe(404)
    expect(resume).not.toHaveBeenCalled()
  })

  it('404s when isRunOwnedByTenant refuses (wrong tenant)', async () => {
    isRunOwnedByTenant.mockResolvedValue(false)
    const res = await post('wf-run-3', { tenantId: 'tenant-wrong' })
    expect(res.status).toBe(404)
    expect(resume).not.toHaveBeenCalled()
  })

  it('resumes with the right step/resumeData/forEachIndex on a successful call', async () => {
    resume.mockResolvedValue({ status: 'suspended' })
    const res = await post('wf-run-4', { tenantId: 'tenant-1', approved: true, forEachIndex: 2 })

    expect(res.status).toBe(200)
    expect(createRun).toHaveBeenCalledWith({ runId: 'mastra-run-1' })
    expect(resume).toHaveBeenCalledTimes(1)
    const call = resume.mock.calls[0][0]
    expect(call.step).toBe('run-plan-step')
    expect(call.resumeData).toEqual({ approved: true })
    expect(call.forEachIndex).toBe(2)
  })

  it('settles and reports completed on a success result', async () => {
    resume.mockResolvedValue({
      status: 'success',
      result: [{ stepId: 'step-1', status: 'done', summary: 'ok', inputTokens: 10, outputTokens: 5 }],
    })
    const res = await post('wf-run-5', { tenantId: 'tenant-1', approved: true })
    const body = await res.json() as { status: string }

    expect(res.status).toBe(200)
    expect(body.status).toBe('completed')
    expect(settleTask).toHaveBeenCalledTimes(1)
    expect(refundTask).not.toHaveBeenCalled()
  })

  it('refunds and reports failed on a failed result', async () => {
    resume.mockResolvedValue({ status: 'failed', error: { message: 'boom' } })
    const res = await post('wf-run-6', { tenantId: 'tenant-1', approved: false })
    const body = await res.json() as { status: string }

    expect(res.status).toBe(200)
    expect(body.status).toBe('failed')
    expect(refundTask).toHaveBeenCalledWith({ tenantId: 'tenant-1', taskId: 'wf-run-6' })
    expect(settleTask).not.toHaveBeenCalled()
  })
})

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
    const res = await post('wf-run-2', { tenantId: 'tenant-1', approved: true, resumeLabel: 'approve:s1' })
    expect(res.status).toBe(404)
    expect(resume).not.toHaveBeenCalled()
  })

  it('404s when isRunOwnedByTenant refuses (wrong tenant)', async () => {
    isRunOwnedByTenant.mockResolvedValue(false)
    const res = await post('wf-run-3', { tenantId: 'tenant-wrong', approved: true, resumeLabel: 'approve:s1' })
    expect(res.status).toBe(404)
    expect(resume).not.toHaveBeenCalled()
  })

  it('returns 400 when resumeLabel is missing', async () => {
    const res = await post('wf-run-4', { tenantId: 'tenant-1', approved: true })
    expect(res.status).toBe(400)
    expect(resume).not.toHaveBeenCalled()
  })

  it('accepts and dispatches without waiting for the workflow to settle', async () => {
    let resolveResume!: (v: unknown) => void
    const resumePromise = new Promise((resolve) => { resolveResume = resolve })
    const detachedResume = vi.fn(() => resumePromise)
    getWorkflow.mockReturnValue({ createRun: vi.fn().mockResolvedValue({ resume: detachedResume }) })

    const start = Date.now()
    const res = await post('wf-run-5', { tenantId: 'tenant-1', approved: true, resumeLabel: 'approve:s1' })
    const elapsedMs = Date.now() - start

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, status: 'accepted' })
    // The route must not have awaited `resume` — it's still unresolved.
    expect(elapsedMs).toBeLessThan(50)

    resolveResume({ status: 'success', result: [] })
    await new Promise((r) => setTimeout(r, 0)) // flush the detached IIFE's microtask queue
    expect(detachedResume).toHaveBeenCalledWith(expect.objectContaining({ label: 'approve:s1', resumeData: { approved: true } }))
  })

  it('re-suspend writes a new pending_approval descriptor rather than clearing it', async () => {
    const detachedResume = vi.fn().mockResolvedValue({
      status: 'suspended',
      suspendPayload: { 'run-plan-step': { stepId: 's2', title: 'Step 2', toolName: 'y', reason: 'requires_approval' } },
    })
    getWorkflow.mockReturnValue({ createRun: vi.fn().mockResolvedValue({ resume: detachedResume }) })

    await post('wf-run-6', { tenantId: 'tenant-1', approved: true, resumeLabel: 'approve:s1' })
    await new Promise((r) => setTimeout(r, 0))

    const fetchMock = vi.mocked(fetch)
    const updateCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/update'))
    const updateBody = JSON.parse((updateCall![1] as RequestInit).body as string)
    expect(updateBody.pendingApproval).toMatchObject({ stepId: 's2', resumeLabel: 'approve:s2' })
  })
})

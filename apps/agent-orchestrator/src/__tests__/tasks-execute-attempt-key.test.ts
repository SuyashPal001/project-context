import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression for the clarify-and-resume free-re-run bug: a task that pauses
// for clarification gets refunded (tasks.execution.ts's earlyTermination
// else-branch), and the resumed run must ACTUALLY re-charge rather than
// replaying the original (now-refunded) debit under the same idempotency
// key. This suite proves the wiring end to end at the HTTP boundary this
// worker actually calls: POST /api/tasks/execute with an `attempt` field
// must charge under attempt-scoped keys that differ per attempt.
//
// Imports `tasksRouter` directly rather than the full `app.js` — the full
// app pulls in the Mastra agent graph via other route mounts
// (`@serverless-saas/agent-capabilities`, unbuilt in this worktree — the
// same pre-existing collection failure documented on tasks-execute.test.ts).
// `tasksRouter` only needs `../mastra/index.js` mocked directly, so that
// chain is never reached.

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

vi.mock('../usage.js', () => ({
  fetchAgentModelSelection: vi.fn().mockResolvedValue(null),
  getPool: vi.fn(),
  recordUsage: vi.fn(),
  fetchAgentSkills: vi.fn().mockResolvedValue({ systemPrompt: 'be helpful', installIds: [], droppedNames: [] }),
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

// `/api/workflows/execute` (unrelated route in the same file) needs this;
// not exercised by these tests but the module-level import must resolve.
vi.mock('../routes/tasks.workflow.js', () => ({ runMastraWorkflowSteps: vi.fn() }))

const documentRunResult = {
  status: 'success',
  result: { inputTokens: 10, outputTokens: 5, summary: 'ok', dodPassed: true, prdData: {} },
}

vi.mock('../mastra/index.js', () => ({
  taskExecutionWorkflow: { createRun: vi.fn() },
  documentWorkflow: {
    createRun: vi.fn().mockImplementation(async () => ({
      start: vi.fn().mockImplementation(async () => documentRunResult),
    })),
  },
  runMastraWorkflow: vi.fn(),
}))

const STEPS = [
  { id: 'step-1', title: 'Step 1', stepOrder: 1, description: 'first', toolName: 'web_search', parameters: {} },
  { id: 'step-2', title: 'Step 2', stepOrder: 2, description: 'second', toolName: 'web_search', parameters: {} },
]

// Same taskId in both requests, only `attempt` differs — mirrors an original
// submit (attempt 0) followed by a clarify-and-resume re-execution (attempt
// 1) of the SAME task.
function requestBody(attempt: number) {
  return JSON.stringify({
    taskId: 'task-clarified',
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    taskTitle: 'Title',
    taskDescription: 'Desc',
    // attachmentContext set + no links => the doc-workflow branch, which
    // AWAITS runMastraTaskSteps synchronously — deterministic, no fire-and-
    // forget draining needed.
    attachmentContext: 'some PRD text',
    steps: STEPS,
    attempt,
  })
}

describe('POST /api/tasks/execute — per-attempt charge key', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('charges attempt 0 under the original task:{taskId} key (unchanged for the common case)', async () => {
    const { tasksRouter } = await import('../routes/tasks.js')
    const res = await tasksRouter.request('/api/tasks/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': 'test-key' },
      body: requestBody(0),
    })
    expect(res.status).toBe(200)
    expect(chargeTaskEstimate.mock.calls.length).toBeGreaterThan(0)
    for (const call of chargeTaskEstimate.mock.calls) {
      expect(call[0].key).toBe('task:task-clarified')
    }
  })

  it('a clarified-then-resumed task is charged under a DIFFERENT key per attempt — genuinely charged twice, not replayed', async () => {
    const { tasksRouter } = await import('../routes/tasks.js')

    await tasksRouter.request('/api/tasks/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': 'test-key' },
      body: requestBody(0),
    })
    const firstAttemptKeys = new Set(chargeTaskEstimate.mock.calls.map(c => c[0].key))
    chargeTaskEstimate.mockClear()

    await tasksRouter.request('/api/tasks/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': 'test-key' },
      body: requestBody(1),
    })
    const secondAttemptKeys = new Set(chargeTaskEstimate.mock.calls.map(c => c[0].key))

    expect(firstAttemptKeys).toEqual(new Set(['task:task-clarified']))
    expect(secondAttemptKeys).toEqual(new Set(['task:task-clarified:attempt:1']))
    // Disjoint keys is the whole point: spend_credits()'s replay check keys
    // on idempotency_key, so two different keys can never short-circuit one
    // another the way the same key would.
    for (const k of secondAttemptKeys) expect(firstAttemptKeys.has(k)).toBe(false)
  })
})

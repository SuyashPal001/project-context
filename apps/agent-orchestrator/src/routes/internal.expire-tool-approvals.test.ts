import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// internal.ts pulls in several modules with real DB/DNS side effects at
// import time (mastra/index.ts builds a real Mastra instance;
// mastra/memory.ts does a top-level DNS resolution against DATABASE_URL) —
// same reasoning tasks-resume-attempt-key.test.ts documents for mocking
// '../mastra/index.js'. Everything below mirrors internal.ts's own import
// list; only '../mastra/registry.js' carries the fake this test actually
// exercises, following the fake-Agent pattern chatStream.tool-approval.test.ts
// uses (stub the two Agent methods the route calls, nothing else).

const { listSuspendedRuns, declineToolCall } = vi.hoisted(() => ({
  listSuspendedRuns: vi.fn(),
  declineToolCall: vi.fn(),
}))

vi.mock('../mastra/index.js', () => ({ mastra: {} }))
vi.mock('../mastra/memory.js', () => ({ truncateMastraThread: vi.fn() }))
vi.mock('../rag/queryRewrite.js', () => ({ rewriteQuery: vi.fn() }))
vi.mock('../rag/relevanceGate.js', () => ({ gateChunks: vi.fn(), fastGateChunks: vi.fn() }))
vi.mock('../pii-filter.js', () => ({ filterPII: vi.fn() }))
vi.mock('../persistence.js', () => ({ saveUserMessage: vi.fn(), saveAssistantMessage: vi.fn() }))

vi.mock('../mastra/registry.js', () => ({
  listRegisteredAgents: vi.fn(() => [
    { name: 'olmo', agent: { listSuspendedRuns, declineToolCall } },
  ]),
}))

import { internalRouter } from './internal.js'
import { pendingToolApprovals } from '../types.js'

const app = new Hono()
app.route('/', internalRouter)

const CUTOFF = '2026-09-09T00:00:00.000Z' // watchdog sends this; well before "now"
const BEFORE_CUTOFF = '2026-09-08T12:00:00.000Z' // suspendedAt well before cutoff
const AFTER_CUTOFF = '2026-09-09T12:00:00.000Z'  // suspendedAt after cutoff — too recent

function post(body: unknown, key = 'test-key') {
  return app.request('/internal/expire-tool-approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
    body: JSON.stringify(body),
  })
}

function fakeConsumableStream() {
  return { consumeStream: vi.fn().mockResolvedValue(undefined) }
}

beforeEach(() => {
  vi.clearAllMocks()
  pendingToolApprovals.clear()
  process.env.INTERNAL_SERVICE_KEY = 'test-key'
  declineToolCall.mockResolvedValue(fakeConsumableStream())
})

describe('POST /internal/expire-tool-approvals — auth', () => {
  it('401s with no X-Service-Key header', async () => {
    const res = await app.request('/internal/expire-tool-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toDate: CUTOFF }),
    })
    expect(res.status).toBe(401)
    expect(listSuspendedRuns).not.toHaveBeenCalled()
  })

  it('401s with a wrong X-Service-Key header', async () => {
    const res = await post({ toDate: CUTOFF }, 'wrong-key')
    expect(res.status).toBe(401)
    expect(listSuspendedRuns).not.toHaveBeenCalled()
  })
})

describe('POST /internal/expire-tool-approvals — requiresApproval discriminator', () => {
  it('declines only the run that requires approval and is old enough; leaves the workflow suspend and the too-recent approval alone', async () => {
    listSuspendedRuns.mockResolvedValueOnce({
      runs: [
        {
          // Eligible: requiresApproval true, suspended well before cutoff.
          runId: 'run-approval-old',
          suspendedAt: BEFORE_CUTOFF,
          threadId: 'thread-1',
          resourceId: 'resource-1',
          toolCalls: [
            { toolCallId: 'tc-old', toolName: 'generate-image', requiresApproval: true },
          ],
        },
        {
          // Not ours: a Mastra workflow suspend, not a tool-call approval —
          // same shape of mistake as Sweep 4's ingest incident (BUG-15) if
          // this filter regresses to "suspended and old" alone.
          runId: 'run-workflow-suspend',
          suspendedAt: BEFORE_CUTOFF,
          threadId: 'thread-2',
          resourceId: 'resource-2',
          toolCalls: [
            { toolCallId: 'tc-workflow', toolName: 'create_task', requiresApproval: false },
          ],
        },
        {
          // Too recent: requiresApproval true, but suspended after the cutoff.
          runId: 'run-approval-recent',
          suspendedAt: AFTER_CUTOFF,
          threadId: 'thread-3',
          resourceId: 'resource-3',
          toolCalls: [
            { toolCallId: 'tc-recent', toolName: 'generate-image', requiresApproval: true },
          ],
        },
      ],
    })

    const res = await post({ toDate: CUTOFF })
    expect(res.status).toBe(200)

    const body = await res.json() as { ok: boolean; declined: Array<{ runId: string; toolCallId?: string }> }
    expect(body.ok).toBe(true)
    expect(declineToolCall).toHaveBeenCalledTimes(1)
    expect(declineToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-approval-old', toolCallId: 'tc-old' })
    )
    expect(body.declined).toHaveLength(1)
    expect(body.declined[0]).toMatchObject({ runId: 'run-approval-old', toolCallId: 'tc-old' })
  })

  it('skips a toolCallId still held by a live SSE waiter even if otherwise eligible', async () => {
    pendingToolApprovals.set('tc-live', {
      resolve: vi.fn(),
      tenantId: 't1',
      runId: 'run-live',
      toolCallId: 'tc-live',
    })

    listSuspendedRuns.mockResolvedValueOnce({
      runs: [
        {
          runId: 'run-live',
          suspendedAt: BEFORE_CUTOFF,
          threadId: 'thread-4',
          resourceId: 'resource-4',
          toolCalls: [
            { toolCallId: 'tc-live', toolName: 'generate-image', requiresApproval: true },
          ],
        },
      ],
    })

    const res = await post({ toDate: CUTOFF })
    expect(res.status).toBe(200)
    expect(declineToolCall).not.toHaveBeenCalled()

    const body = await res.json() as { declined: unknown[] }
    expect(body.declined).toHaveLength(0)
  })
})

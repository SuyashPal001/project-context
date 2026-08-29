import { describe, it, expect, vi, beforeEach } from 'vitest'
import { taskHeartbeatKey } from '../lib/task-heartbeat'

/**
 * A task that reaches a terminal state must stop its watchdog heartbeat.
 *
 * handleExecution started a heartbeat on entry but referenced an undefined
 * `cache`/`watchdogKey` pair on the relay-rejected path — left behind when the
 * heartbeat moved into lib/task-heartbeat. That line did not compile, and the
 * timeout path never cleared the heartbeat at all, so a task marked `blocked`
 * kept a live heartbeat key until its TTL lapsed.
 */

const cache = { set: vi.fn(), del: vi.fn() }

const TASK = {
  id: 'task-1',
  tenantId: 'tenant-1',
  agentId: null,
  title: 'Do the thing',
  description: null,
  referenceText: null,
  links: [],
  attachmentFileIds: [],
  status: 'in_progress',
}

/** Chainable no-op stand-in for the drizzle query builders used here. */
function chain(result: unknown = []) {
  const p: any = Promise.resolve(result)
  for (const m of ['from', 'where', 'limit', 'orderBy', 'set', 'values']) {
    p[m] = () => chain(result)
  }
  return p
}

const db = {
  query: { agentTasks: { findFirst: vi.fn().mockResolvedValue(TASK) } },
  select: vi.fn(() => chain([{ id: 'step-1', stepNumber: 1, status: 'pending', title: 't', description: 'd', toolName: null }])),
  update: vi.fn(() => chain()),
  insert: vi.fn(() => chain()),
}

vi.mock('@serverless-saas/agent-schema', () => ({
  agentTasks: {}, taskSteps: {}, taskEvents: {}, agents: {},
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), asc: vi.fn(), count: vi.fn() }))
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn() }))
vi.mock('@serverless-saas/cache', () => ({ getCacheClient: () => cache }))
vi.mock('../workers/taskWorker.utils', () => ({
  db,
  AGENT_ORCHESTRATOR_URL: 'http://relay.test',
  INTERNAL_SERVICE_KEY: () => 'k',
  sanitizeTaskInput: (s: string) => s,
  makeLog: () => () => {},
  extractAttachments: vi.fn().mockResolvedValue({ attachmentContext: null }),
}))

describe('handleExecution heartbeat lifecycle', () => {
  beforeEach(() => {
    cache.set.mockClear()
    cache.del.mockClear()
  })

  it('clears the heartbeat when the relay rejects execution', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const { handleExecution } = await import('../workers/taskWorker.execution')

    await handleExecution('task-1', 'trace-1')

    expect(cache.del).toHaveBeenCalledWith(taskHeartbeatKey('task-1'))
  })

  it('clears the heartbeat when the relay call throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const { handleExecution } = await import('../workers/taskWorker.execution')

    await handleExecution('task-1', 'trace-1')

    expect(cache.del).toHaveBeenCalledWith(taskHeartbeatKey('task-1'))
  })

  it('leaves the heartbeat running when the relay accepts the work', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }))
    const { handleExecution } = await import('../workers/taskWorker.execution')

    await handleExecution('task-1', 'trace-1')

    expect(cache.del).not.toHaveBeenCalled()
  })
})

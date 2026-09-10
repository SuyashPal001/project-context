import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Sweep 7 declines a stalled `agent_workflow_runs` row stuck in
 * `awaiting_approval` by calling the agent-orchestrator's own
 * /internal/expire-workflow-approvals endpoint — it never touches this
 * Lambda's database directly (there is nothing to touch: resuming the run
 * and reading its Mastra snapshot are engine operations on the orchestrator
 * side). So the thing worth asserting here mirrors Sweep 6's test: that the
 * sweep fires the right request with the right cutoff/headers when
 * configured, stays silent (no request at all) when the orchestrator isn't
 * configured for this environment, and never lets a failed call take down
 * the sweeps that already ran.
 */

/** Chainable stand-in for the drizzle builders sweeps 1-5 use — empty
 *  results for all of them so sweep 7 is reached with nothing else firing. */
function chain(result: unknown = []) {
  const p: any = Promise.resolve(result)
  for (const m of ['from', 'where', 'set', 'values', 'returning', 'orderBy', 'limit']) {
    p[m] = () => chain(result)
  }
  return p
}

const db = {
  select: vi.fn(() => chain([])),
  update: vi.fn(() => chain([])),
  insert: vi.fn(() => chain()),
}

vi.mock('@serverless-saas/agent-schema', () => ({ agentTasks: {}, taskEvents: {}, messages: {} }))
vi.mock('@serverless-saas/database/schema/audit', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/database/schema/storage', () => ({ files: {} }))
vi.mock('../db', () => ({ db }))
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}))
vi.mock('@serverless-saas/cache', () => ({
  getCacheClient: () => ({ exists: vi.fn().mockResolvedValue(1) }), // 1 == heartbeat present == not stalled
}))
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn() }))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))
vi.mock('@serverless-saas/secrets', () => ({ initRuntimeSecrets: vi.fn() }))
vi.mock('../lib/credit-pool', () => ({ creditPool: { query: vi.fn() } }))
vi.mock('@serverless-saas/agent-credits', () => ({
  refundTask: vi.fn().mockResolvedValue(undefined),
  taskChargeKey: (taskId: string, attempt: number) =>
    attempt > 0 ? `task:${taskId}:attempt:${attempt}` : `task:${taskId}`,
}))

const originalEnv = { ...process.env }
const fetchMock = vi.fn()

beforeEach(() => {
  vi.resetModules()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  process.env = { ...originalEnv, AGENT_ORCHESTRATOR_URL: 'https://orchestrator.internal', INTERNAL_SERVICE_KEY: 'test-key' }
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env = originalEnv
})

describe('watchdog sweep 7: stalled workflow-run approvals', () => {
  it('calls the orchestrator with a 24h cutoff and the service-key header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ declined: [] }),
    })

    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    const call = fetchMock.mock.calls.find(([url]) => url === 'https://orchestrator.internal/internal/expire-workflow-approvals')
    expect(call).toBeDefined()
    const [url, opts] = call!
    expect(url).toBe('https://orchestrator.internal/internal/expire-workflow-approvals')
    expect(opts.method).toBe('POST')
    expect(opts.headers['x-internal-service-key']).toBe('test-key')

    const body = JSON.parse(opts.body)
    const cutoff = new Date(body.toDate)
    const expected = Date.now() - 24 * 60 * 60 * 1000
    // Within a few seconds of the exact 24h boundary — no fixed timers to
    // race against, just wall-clock drift across the two Date.now() calls.
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000)
  })

  it('does not call the workflow-approvals endpoint when AGENT_ORCHESTRATOR_URL is unset', async () => {
    delete process.env.AGENT_ORCHESTRATOR_URL

    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    expect(fetchMock.mock.calls.some(([url]) => url === 'https://orchestrator.internal/internal/expire-workflow-approvals')).toBe(false)
  })

  it('does not call the workflow-approvals endpoint when INTERNAL_SERVICE_KEY is unset', async () => {
    delete process.env.INTERNAL_SERVICE_KEY

    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    expect(fetchMock.mock.calls.some(([url]) => url.includes('expire-workflow-approvals'))).toBe(false)
  })

  it('logs the declined count on a successful sweep', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ declined: [{ workflowRunId: 'wf-1' }, { workflowRunId: 'wf-2', error: 'boom' }] }),
    })
    const wlogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    const loggedInfo = wlogSpy.mock.calls.some(([line]) =>
      typeof line === 'string' && line.includes('Expired workflow-run approvals declined'))
    expect(loggedInfo).toBe(true)

    wlogSpy.mockRestore()
  })

  it('does not throw when the orchestrator responds non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    const { handler } = await import('../handlers/watchdogHandler')
    await expect(handler({} as never, {} as never, (() => {}) as never)).resolves.toBeUndefined()
  })

  it('does not throw when the orchestrator call fails — sweep completes', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === 'https://orchestrator.internal/internal/expire-workflow-approvals') {
        return Promise.reject(new Error('orchestrator unreachable'))
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, declined: [] }) })
    })

    const { handler } = await import('../handlers/watchdogHandler')
    await expect(handler({} as never, {} as never, (() => {}) as never)).resolves.toBeUndefined()
  })
})

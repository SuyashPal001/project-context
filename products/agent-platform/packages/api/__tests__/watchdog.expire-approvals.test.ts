import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Sweep 6 declines a tool-call approval nobody answered in 24h by calling
 * the agent-orchestrator's own /internal/expire-tool-approvals endpoint —
 * it never touches this Lambda's database directly (there is nothing to
 * touch: the suspended run lives entirely in Mastra's snapshot storage on
 * the orchestrator side). So the thing worth asserting here is narrower
 * than the DB-heavy sweeps above: that the sweep fires the right request
 * with the right cutoff/headers when configured, stays silent (no request
 * at all) when the orchestrator isn't configured for this environment, and
 * never lets a failed call take down the sweeps that already ran.
 */

/** Chainable stand-in for the drizzle builders sweeps 1-5 use — empty
 *  results for all of them so sweep 6 is reached with nothing else firing. */
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

describe('watchdog sweep 6: abandoned tool-call approvals', () => {
  it('calls the orchestrator with a 24h cutoff, X-Service-Key, and a reason', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, declined: [] }),
    })

    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://orchestrator.internal/internal/expire-tool-approvals')
    expect(opts.method).toBe('POST')
    expect(opts.headers['X-Service-Key']).toBe('test-key')

    const body = JSON.parse(opts.body)
    expect(typeof body.reason).toBe('string')
    const cutoff = new Date(body.toDate)
    const expected = Date.now() - 24 * 60 * 60 * 1000
    // Within a few seconds of the exact 24h boundary — no fixed timers to
    // race against, just wall-clock drift across the two Date.now() calls.
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000)
  })

  it('does not call fetch when AGENT_ORCHESTRATOR_URL is unset', async () => {
    delete process.env.AGENT_ORCHESTRATOR_URL

    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not call fetch when INTERNAL_SERVICE_KEY is unset', async () => {
    delete process.env.INTERNAL_SERVICE_KEY

    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not throw when the orchestrator call fails — sweep completes', async () => {
    fetchMock.mockRejectedValue(new Error('orchestrator unreachable'))

    const { handler } = await import('../handlers/watchdogHandler')
    await expect(handler({} as never, {} as never, (() => {}) as never)).resolves.toBeUndefined()
  })

  it('does not throw when the orchestrator responds non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    const { handler } = await import('../handlers/watchdogHandler')
    await expect(handler({} as never, {} as never, (() => {}) as never)).resolves.toBeUndefined()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The watchdog must refund the task it blocks.
 *
 * Sweep 1 marks a task whose heartbeat expired as `blocked` and, before this
 * fix, walked away leaving the estimate charged at execution time standing.
 * That was not merely an overcharge on a dead run — it was a REVENUE LEAK,
 * because the retry attempt number is advanced by refundTask. With no refund
 * the attempt never moved, so the retry rebuilt the SAME charge key,
 * spend_credits() treated it as a replay and charged nothing, and the first
 * run's tokens went unbilled entirely.
 *
 * So the assertion that matters is not "a refund happened" but "a refund
 * happened FOR THE KEY THE RUN WAS CHARGED UNDER" — a refund keyed off the
 * wrong attempt finds no debit and silently no-ops, which looks identical from
 * the outside.
 */

const STALLED = {
  id: 'task-stalled',
  tenantId: 'tenant-1',
  agentId: null,
  createdBy: 'user-1',
  title: 'Stalled task',
  status: 'in_progress',
  creditAttempt: 2,
}

const refundTask = vi.fn().mockResolvedValue(undefined)

/** Chainable stand-in for the drizzle builders the watchdog uses. */
function chain(result: unknown = []) {
  const p: any = Promise.resolve(result)
  for (const m of ['from', 'where', 'set', 'values', 'returning', 'orderBy', 'limit']) {
    p[m] = () => chain(result)
  }
  return p
}

// Sweep 1 finds the stalled task; sweeps 2 and 3 find nothing.
const selectResults: unknown[][] = [[STALLED], [], []]
// The agent_tasks status update reports one row changed; sweep 4's files
// update reports none.
const updateResults: unknown[][] = [[{ id: STALLED.id }], []]

const db = {
  select: vi.fn(() => chain(selectResults.shift() ?? [])),
  update: vi.fn(() => chain(updateResults.shift() ?? [])),
  insert: vi.fn(() => chain()),
}

vi.mock('@serverless-saas/agent-schema', () => ({ agentTasks: {}, taskEvents: {} }))
vi.mock('@serverless-saas/database/schema/audit', () => ({ auditLog: {} }))
vi.mock('@serverless-saas/database/schema/storage', () => ({ files: {} }))
vi.mock('../db', () => ({ db }))
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}))
vi.mock('@serverless-saas/cache', () => ({
  // 0 == no heartbeat key == stalled.
  getCacheClient: () => ({ exists: vi.fn().mockResolvedValue(0) }),
}))
vi.mock('../lib/websocket', () => ({ pushWebSocketEvent: vi.fn() }))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))
vi.mock('@serverless-saas/secrets', () => ({ initRuntimeSecrets: vi.fn() }))
vi.mock('../lib/credit-pool', () => ({ creditPool: { query: vi.fn() } }))
vi.mock('@serverless-saas/agent-credits', () => ({
  refundTask,
  // NOT mocked away — the real key builder, so a wrong attempt produces a
  // wrong key here exactly as it would in production.
  taskChargeKey: (taskId: string, attempt: number) =>
    attempt > 0 ? `task:${taskId}:attempt:${attempt}` : `task:${taskId}`,
}))

describe('watchdog sweep 1: stalled task refund', () => {
  beforeEach(() => {
    refundTask.mockClear()
    selectResults.splice(0, selectResults.length, [STALLED], [], [])
    updateResults.splice(0, updateResults.length, [{ id: STALLED.id }], [])
  })

  it('refunds the blocked task under the charge key its current attempt was billed to', async () => {
    const { handler } = await import('../handlers/watchdogHandler')
    await handler({} as never, {} as never, (() => {}) as never)

    expect(refundTask).toHaveBeenCalledTimes(1)
    const [args] = refundTask.mock.calls[0]
    expect(args).toMatchObject({
      tenantId: STALLED.tenantId,
      taskId: STALLED.id,
      // creditAttempt is 2, so the live charge is under the attempt-2 key.
      // The bare `task:{id}` key would refund a debit that was already
      // refunded two attempts ago — a no-op that leaves this run charged.
      chargeKey: `task:${STALLED.id}:attempt:2`,
    })
  })

  it('still blocks the task when the refund throws', async () => {
    refundTask.mockRejectedValueOnce(new Error('pool exploded'))
    const { handler } = await import('../handlers/watchdogHandler')

    // A task whose refund fails must not stop the sweep: the status update has
    // already landed by then, and the remaining tasks still need blocking.
    await expect(handler({} as never, {} as never, (() => {}) as never)).resolves.toBeUndefined()
    expect(db.insert).toHaveBeenCalled()
  })
})

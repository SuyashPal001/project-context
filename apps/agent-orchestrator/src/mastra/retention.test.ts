import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveTraceRetentionDays,
  runTraceRetentionPrune,
  scheduleTraceRetention,
  DEFAULT_TRACE_RETENTION_DAYS,
  MIN_TRACE_RETENTION_DAYS,
  type PrunableStore,
  type RetentionLogger,
} from './retention.js'

function makeLogger() {
  return {
    log: vi.fn((..._args: unknown[]) => {}),
    error: vi.fn((..._args: unknown[]) => {}),
  } satisfies RetentionLogger
}

describe('resolveTraceRetentionDays', () => {
  it('defaults to 3 when TRACE_RETENTION_DAYS is unset', () => {
    expect(resolveTraceRetentionDays({})).toBe(DEFAULT_TRACE_RETENTION_DAYS)
  })

  it('defaults to 3 when TRACE_RETENTION_DAYS is blank', () => {
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: '   ' })).toBe(3)
  })

  it('defaults to 3 when TRACE_RETENTION_DAYS is not a number', () => {
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: 'nope' })).toBe(3)
  })

  it('passes through a valid value above the minimum', () => {
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: '7' })).toBe(7)
  })

  it('clamps up to the minimum (2) when below it', () => {
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: '1' })).toBe(MIN_TRACE_RETENTION_DAYS)
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: '0' })).toBe(MIN_TRACE_RETENTION_DAYS)
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: '-5' })).toBe(MIN_TRACE_RETENTION_DAYS)
  })

  it('floors a fractional value before clamping', () => {
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: '3.9' })).toBe(3)
    expect(resolveTraceRetentionDays({ TRACE_RETENTION_DAYS: '2.1' })).toBe(2)
  })
})

describe('runTraceRetentionPrune', () => {
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    logger = makeLogger()
  })

  it('calls store.prune with a retention policy scoped to observability.spans using the given days', async () => {
    const prune = vi.fn().mockResolvedValue([
      { domain: 'observability', table: 'mastra_span_events', deleted: 42, done: true },
    ])
    const store: PrunableStore = { prune }

    await runTraceRetentionPrune(store, 5, logger)

    expect(prune).toHaveBeenCalledTimes(1)
    expect(prune).toHaveBeenCalledWith({
      retention: { observability: { spans: { maxAge: '5d' } } },
    })
  })

  it('logs each PruneResult it gets back', async () => {
    const prune = vi.fn().mockResolvedValue([
      { domain: 'observability', table: 'mastra_span_events', deleted: 100, done: true },
      { domain: 'observability', table: 'mastra_metric_events', deleted: 0, done: false },
    ])
    const store: PrunableStore = { prune }

    await runTraceRetentionPrune(store, 3, logger)

    expect(logger.log).toHaveBeenCalledTimes(2)
    expect(logger.log.mock.calls[0][0]).toContain('mastra_span_events')
    expect(logger.log.mock.calls[0][0]).toContain('100')
    expect(logger.log.mock.calls[1][0]).toContain('more remain')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('never throws when prune() rejects — logs the error instead', async () => {
    const prune = vi.fn().mockRejectedValue(new Error('connection reset'))
    const store: PrunableStore = { prune }

    await expect(runTraceRetentionPrune(store, 3, logger)).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0].join(' ')).toContain('connection reset')
    expect(logger.log).not.toHaveBeenCalled()
  })

  it('never throws when prune() throws synchronously', async () => {
    const store: PrunableStore = {
      prune: vi.fn(() => {
        throw new Error('boom')
      }) as unknown as PrunableStore['prune'],
    }

    await expect(runTraceRetentionPrune(store, 3, logger)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  // F5: prune() can reject with something that isn't an Error at all (a
  // plain string, or null/undefined) — `(err as Error).message` on a
  // non-Error throws its own TypeError, which used to escape the catch
  // block's own error log entirely.
  it('never throws when prune() rejects with a non-Error value', async () => {
    const store: PrunableStore = { prune: vi.fn().mockRejectedValue('plain string rejection') }

    await expect(runTraceRetentionPrune(store, 3, logger)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0].join(' ')).toContain('plain string rejection')
  })

  it('never throws when prune() rejects with undefined', async () => {
    const store: PrunableStore = { prune: vi.fn().mockRejectedValue(undefined) }

    await expect(runTraceRetentionPrune(store, 3, logger)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0].join(' ')).toContain('undefined')
  })
})

describe('scheduleTraceRetention', () => {
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    vi.useFakeTimers()
    logger = makeLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs once immediately and then every 24h', async () => {
    const prune = vi.fn().mockResolvedValue([])
    const store: PrunableStore = { prune }

    const handle = scheduleTraceRetention(store, 4, logger)
    await vi.waitFor(() => expect(prune).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(prune).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(prune).toHaveBeenCalledTimes(3)

    for (const call of prune.mock.calls) {
      expect(call[0]).toEqual({ retention: { observability: { spans: { maxAge: '4d' } } } })
    }

    clearInterval(handle)
  })

  it('a failing tick never throws out of the interval', async () => {
    const prune = vi.fn().mockRejectedValue(new Error('read-only transaction'))
    const store: PrunableStore = { prune }

    const handle = scheduleTraceRetention(store, 3, logger)
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(2))

    clearInterval(handle)
  })

  // F5: the interval must not keep the orchestrator process alive on its own.
  it('calls unref() on the interval handle', () => {
    const prune = vi.fn().mockResolvedValue([])
    const store: PrunableStore = { prune }
    const unref = vi.fn()
    const fakeHandle = { unref } as unknown as NodeJS.Timeout
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeHandle)

    const handle = scheduleTraceRetention(store, 3, logger)

    expect(unref).toHaveBeenCalledTimes(1)
    expect(handle).toBe(fakeHandle)
    setIntervalSpy.mockRestore()
  })
})
